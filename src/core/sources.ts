import type { DailyDownloads, DependencyPull, Evidence, RawPackageData, RegistryDoc, SearchHit } from './types.ts';
import { clip } from './html.ts';
import { PackageNotFoundError } from './types.ts';

// npm's rules: url-safe, optional @scope/, at most 214 chars. Uppercase is allowed because legacy
// packages (JSONStream) still have it, even though new names must be lowercase.
const NAME_RE = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;

export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NAME_RE.test(name);
}

// Verified live: registry and versions/last-week need "@scope%2Fname" (versions 404s on a raw "/"),
// downloads/range accepts both. So one encoding for all three.
function encodeName(name: string): string {
  return name.replace('/', '%2F');
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<{ status: number; body: any }> {
  const res = await fetchImpl(url);
  return { status: res.status, body: res.ok ? await res.json() : null };
}

export async function fetchPackageData(name: string, fetchImpl: typeof fetch = fetch): Promise<RawPackageData> {
  const enc = encodeName(name);
  const [dl, reg, ver] = await Promise.all([
    getJson(fetchImpl, `https://api.npmjs.org/downloads/range/last-year/${enc}`),
    getJson(fetchImpl, `https://registry.npmjs.org/${enc}`),
    getJson(fetchImpl, `https://api.npmjs.org/versions/${enc}/last-week`),
  ]);
  if (reg.status === 404) throw new PackageNotFoundError(name);
  if (!reg.body) throw new Error(`registry.npmjs.org responded ${reg.status} for ${name}`);
  // The downloads API 404s for packages that exist but have no recorded downloads yet.
  if (!dl.body && dl.status !== 404) throw new Error(`api.npmjs.org downloads responded ${dl.status} for ${name}`);
  // Same for versions/last-week: a 404 means no per-version counts yet.
  if (!ver.body && ver.status !== 404) throw new Error(`api.npmjs.org versions responded ${ver.status} for ${name}`);

  return {
    name,
    downloads: ((dl.body?.downloads ?? []) as DailyDownloads[]).map((d) => ({ day: d.day, downloads: d.downloads })),
    registry: trimRegistry(reg.body),
    versionsLastWeek: ver.body?.downloads ?? {},
    pulls: dependencyPulls(reg.body, ver.body?.downloads ?? {}),
  };
}

const PULL_MIN_WEEKLY = 10_000; // below this a dependency can't explain anything worth a line on a page

// For each required dependency: how many of last week's downloads came on versions that ask for it. Optional, peer and
// bundled dependencies are left out, since installing the package doesn't have to fetch them.
export function dependencyPulls(doc: any, weekly: Record<string, unknown>): Record<string, DependencyPull> {
  const byChild = new Map<string, Map<string, number>>();
  for (const [version, n] of Object.entries(weekly)) {
    const manifest = doc.versions?.[version];
    if (typeof n !== 'number' || !manifest?.dependencies) continue;
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies; // a list, or true for all of them
    if (bundled === true) continue;
    for (const [child, range] of Object.entries(manifest.dependencies)) {
      if (typeof range !== 'string' || Object.hasOwn(manifest.optionalDependencies ?? {}, child)) continue;
      if (Array.isArray(bundled) && bundled.includes(child)) continue;
      const ranges = byChild.get(child) ?? new Map<string, number>();
      ranges.set(range, (ranges.get(range) ?? 0) + n);
      byChild.set(child, ranges);
    }
  }
  const out: [string, DependencyPull][] = [];
  for (const [child, ranges] of byChild) {
    const total = [...ranges.values()].reduce((a, b) => a + b, 0);
    if (total < PULL_MIN_WEEKLY) continue;
    const [range, rangeWeekly] = [...ranges].sort((a, b) => b[1] - a[1])[0];
    out.push([child, { weekly: total, range, rangeWeekly }]);
  }
  return Object.fromEntries(out);
}

const README_HEAD = 2000; // a project says this near the top; further down it is usually about something else
const MAINTENANCE_NOTE_MAX = 200;
// "not maintained by Discord" and "no longer supported on Node 12" say something else, so the phrase must end the clause.
const MAINTENANCE_RE = /\b(?:in maintenance mode|legacy project|unmaintained|no longer\s+(?:actively\s+)?(?:maintained|supported|developed)|not\s+(?:actively\s+)?(?:maintained|developed))\b(?!\s+(?:by|for|on|in|with|at|as|under)\b)/i;
const TAKEN_OVER_RE = /\b(?:now|currently|still)\s+maintained\b|\bmaintained by\b/i;
// Sentences that name it to describe something else: "based on foo, which is unmaintained".
const ABOUT_ANOTHER_RE = /\b(?:fork|instead|replac|successor|alternative|based on|which)\b/i;

// The README's own sentence about the project being unmaintained. Only a sentence about the project itself counts:
// "Node 12 is no longer supported" or "a fork of the unmaintained foo" say nothing about it, so a false claim costs more
// than a missed one.
export function maintenanceNote(name: string, readme: unknown): string | undefined {
  if (typeof readme !== 'string') return undefined;
  const short = name.replace(/^@[^/]+\//, '').toLowerCase();
  const text = readme
    .slice(0, README_HEAD)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
    .replace(/^\s*[>#]+\s*/gm, '') // quotes and headings
    .replace(/[*`]/g, '');
  for (const paragraph of text.split(/\n\s*\n/)) {
    const sentences = paragraph.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
    for (const [i, raw] of sentences.entries()) {
      const sentence = raw.replace(/^[^\p{L}\p{N}]+/u, '').replace(/^(?:note|notice|warning|important)\s*:\s*/i, '').trim();
      const lower = sentence.toLowerCase();
      const aboutItself =
        /^(?:this|the) (?:package|project|library|module|repo|repository|tool)\b/.test(lower) ||
        lower.startsWith(`${short} `) ||
        lower.startsWith(`${short}.js `);
      if (!aboutItself || !MAINTENANCE_RE.test(sentence) || ABOUT_ANOTHER_RE.test(sentence)) continue;
      // "No longer maintained by its author. It is now maintained by the community." reverses the quote.
      return TAKEN_OVER_RE.test(sentences[i + 1] ?? '') ? undefined : clip(sentence, MAINTENANCE_NOTE_MAX);
    }
  }
  return undefined;
}

const README_MAX = 150_000; // chars; the doc is cached in sessionStorage

// Any "types" condition anywhere in an exports map.
const exportsHaveTypes = (x: unknown): boolean =>
  !!x && typeof x === 'object' && Object.entries(x).some(([k, v]) => k === 'types' || exportsHaveTypes(v));

function hasTypes(name: string, manifest: any): boolean {
  return name.startsWith('@types/') || typeof manifest.types === 'string' || typeof manifest.typings === 'string' || exportsHaveTypes(manifest.exports);
}

// All string targets and condition names in an exports map.
function exportsEntries(x: unknown, out: [string, string][] = [], key = ''): [string, string][] {
  if (typeof x === 'string') out.push([key, x]);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) exportsEntries(v, out, k);
  return out;
}

// Conservative: only what the manifest states plainly. Empty when unsure.
function moduleFormats(m: any): ('esm' | 'cjs')[] {
  const main = typeof m.main === 'string' ? m.main : '';
  const exp = exportsEntries(m.exports);
  const esm =
    m.type === 'module' || typeof m.module === 'string' || main.endsWith('.mjs') ||
    exp.some(([k, v]) => k === 'import' || k === 'module' || v.endsWith('.mjs'));
  const cjs =
    main.endsWith('.cjs') || exp.some(([k, v]) => k === 'require' || v.endsWith('.cjs')) ||
    (m.type !== 'module' && main !== '' && !main.endsWith('.mjs'));
  return [...(esm ? ['esm' as const] : []), ...(cjs ? ['cjs' as const] : [])];
}

// ponytail: we still download the full registry doc (several MB for react) because only it carries
// `time`; the abbreviated install doc doesn't. Trimming here only keeps memory/fixtures small.
export function trimRegistry(doc: any): RegistryDoc {
  const latest = doc.versions?.[doc['dist-tags']?.latest];
  const deprecated = latest?.deprecated;
  const note = maintenanceNote(String(doc.name ?? ''), doc.readme);
  const deps = latest?.dependencies && typeof latest.dependencies === 'object'
    ? Object.fromEntries(Object.entries(latest.dependencies).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : undefined;
  const maintainers = Array.isArray(doc.maintainers)
    ? doc.maintainers.map((m: any) => m?.name).filter((n: unknown): n is string => typeof n === 'string' && n !== '')
    : [];
  const publisher = latest?._npmUser?.name;
  const formats = latest ? moduleFormats(latest) : [];
  return {
    ...(Array.isArray(doc.maintainers) && { maintainerCount: doc.maintainers.length }),
    ...(typeof deprecated === 'string' && deprecated && { deprecated }),
    ...(note && { maintenanceNote: note }),
    ...(typeof doc.readme === 'string' && doc.readme.trim() && { readme: doc.readme.slice(0, README_MAX) }),
    ...(deps && { dependencies: deps }),
    ...(typeof latest?.dist?.unpackedSize === 'number' && { unpackedSize: latest.dist.unpackedSize }),
    ...(typeof latest?.dist?.fileCount === 'number' && { fileCount: latest.dist.fileCount }),
    ...(latest && hasTypes(String(doc.name ?? ''), latest) && { types: true }),
    ...(formats.length && { moduleFormats: formats }),
    ...(typeof publisher === 'string' && publisher && { publisher }),
    ...(maintainers.length && { maintainers }), // names only: the registry list also carries emails
    name: doc.name,
    description: doc.description,
    license: typeof doc.license === 'string' ? doc.license : doc.license?.type,
    homepage: doc.homepage,
    repository: doc.repository,
    'dist-tags': doc['dist-tags'] ?? {},
    time: doc.time ?? {},
  };
}

const MAX_SCOPED_POINTS = 3;

const num = (x: unknown): number | undefined => {
  const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

// For the UI: hits added from npms.io have version '' and no date/publisher/dependents (npms data is stale,
// so it is not shown as fresh). Hide the version when it is ''.
export async function searchPackages(text: string, fetchImpl: typeof fetch = fetch): Promise<SearchHit[]> {
  const enc = encodeURIComponent(text);
  const [res, suggestions] = await Promise.all([
    fetchImpl(`https://registry.npmjs.org/-/v1/search?text=${enc}&size=10`),
    // npm search doesn't match prefixes ("nervegr" -> nothing, "react-ro" -> no react-router); npms does.
    // ponytail: npms' index is stale (2022) and misses brand-new packages, so for those only npm's full-word
    // matches are found. Upgrade path: our own name index.
    okJson(fetchImpl, `https://api.npms.io/v2/search/suggestions?q=${enc}&size=10`).catch(() => []),
  ]);
  if (!res.ok) throw new Error(`npm search responded ${res.status}`);
  const body = await res.json();
  const hits: SearchHit[] = (body.objects ?? []).map((o: any) => ({
    name: o.package.name,
    description: o.package.description,
    version: o.package.version,
    weeklyDownloads: num(o.downloads?.weekly),
    dependents: num(o.dependents),
    date: o.package.date,
    publisher: o.package.publisher?.username, // never the email
  }));
  const seen = new Set(hits.map((h) => h.name));
  const added: SearchHit[] = (Array.isArray(suggestions) ? suggestions : [])
    .map((s: any) => s?.package)
    .filter((p: any) => typeof p?.name === 'string' && !seen.has(p.name))
    .map((p: any) => ({ name: p.name, description: p.description, version: '' }));
  // Weekly counts for the added names: one bulk call for unscoped names (with a single name it answers with that
  // package's object instead of a map), and one call per scoped name since bulk doesn't take them (<= 10).
  // A failed call just leaves the count missing.
  const point = 'https://api.npmjs.org/downloads/point/last-week/';
  const unscoped = added.filter((h) => !h.name.startsWith('@')).map((h) => h.name);
  // Cap the per-name calls: only the top MAX_SCOPED_POINTS scoped names get a count.
  const scoped = added.filter((h) => h.name.startsWith('@')).slice(0, MAX_SCOPED_POINTS);
  const [bulk, ...scopedPoints] = await Promise.all([
    unscoped.length ? okJson(fetchImpl, point + unscoped.join(',')).catch(() => null) : null,
    ...scoped.map((h) => okJson(fetchImpl, point + encodeName(h.name)).catch(() => null)),
  ]);
  for (const h of added) {
    const p = h.name.startsWith('@')
      ? scopedPoints[scoped.indexOf(h)] // undefined past the cap
      : unscoped.length === 1
        ? bulk
        : bulk?.[h.name];
    if (p?.package === h.name) h.weeklyDownloads = num(p.downloads);
  }
  hits.push(...added);
  // npm ranks prefixes poorly ("react-ro" -> @react-pdf first): exact name, then prefix matches by weekly
  // downloads, then the rest in npm's order. Array#sort is stable, so ties keep npm's order.
  const q = text.trim().toLowerCase();
  const group = (h: SearchHit) => (h.name.toLowerCase() === q ? 0 : h.name.toLowerCase().startsWith(q) ? 1 : 2);
  return hits
    .sort((a, b) => group(a) - group(b) || (group(a) === 1 ? (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0) : 0))
    .slice(0, 10);
}

// owner/repo from a registry `repository` field, only for github.com. Handles git+https://, git://,
// git+ssh://git@, git@github.com:, github:owner/repo, the bare owner/repo shorthand (npm defaults it to
// GitHub), a .git suffix and monorepo paths such as /tree/main/packages/x.
export function parseGithubRepo(repository: RegistryDoc['repository']): string | null {
  // Registry data is untrusted: repository.url may be any JSON value.
  const raw: unknown = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url) return null;
  const m = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url) ?? /github\.com[/:]([\w.-]+)\/([\w.-]+)/i.exec(url);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : null;
}

// Any failure (network, non-2xx incl. 403/429 rate limits, bad JSON) rejects, and the caller maps it to null.
async function okJson(fetchImpl: typeof fetch, url: string): Promise<any> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}
const count = (x: unknown): number | null => num(x) ?? null;

// The signals that can change confidence, without the display-only calls (GitHub, top dependents). For the nightly
// build and the compare page, which need confidence but not the evidence block. A failed source stays null.
export async function fetchConfidenceEvidence(name: string, fetchImpl: typeof fetch = fetch): Promise<Evidence> {
  const [pkg, cdn] = await Promise.all([
    okJson(fetchImpl, `https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encodeName(name)}`).catch(() => null),
    okJson(fetchImpl, `https://data.jsdelivr.com/v1/stats/packages/npm/${name}?period=month`).catch(() => null),
  ]);
  return {
    dependentPackages: count(pkg?.dependent_packages_count),
    dependentRepos: count(pkg?.dependent_repos_count),
    topDependents: [],
    cdnHitsMonth: count(cdn?.hits?.total),
    github: null,
    codeSearchUrl: '',
  };
}

export async function fetchEvidence(name: string, registry: RegistryDoc, fetchImpl: typeof fetch = fetch): Promise<Evidence> {
  // Verified live: ecosyste.ms accepts both "@scope/name" and "@scope%2Fname"; jsDelivr needs a raw "/"
  // ("%2F" -> 400). This list is incomplete: zod's misses @modelcontextprotocol/sdk, so it is never "the biggest dependents".
  const eco = `https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encodeName(name)}`;
  const repo = parseGithubRepo(registry.repository);
  const [pkg, deps, cdn, gh] = await Promise.all([
    okJson(fetchImpl, eco).catch(() => null),
    okJson(fetchImpl, `${eco}/dependent_packages?per_page=5&sort=downloads&order=desc`).catch(() => null),
    okJson(fetchImpl, `https://data.jsdelivr.com/v1/stats/packages/npm/${name}?period=month`).catch(() => null),
    repo ? okJson(fetchImpl, `https://api.github.com/repos/${repo}`).catch(() => null) : null,
  ]);
  return {
    dependentPackages: count(pkg?.dependent_packages_count),
    dependentRepos: count(pkg?.dependent_repos_count),
    topDependents: Array.isArray(deps)
      ? deps
          .filter((d: any) => typeof d?.name === 'string' && isValidPackageName(d.name))
          .map((d: any) => ({ name: d.name, downloads: num(d.downloads) }))
      : [],
    cdnHitsMonth: count(cdn?.hits?.total),
    github:
      gh && typeof gh.stargazers_count === 'number'
        ? {
            repo: gh.full_name ?? repo,
            stars: gh.stargazers_count,
            forks: gh.forks_count ?? 0,
            openIssues: gh.open_issues_count ?? 0,
            pushedAt: gh.pushed_at ?? '',
          }
        : null,
    // Code search treats the quoted string as an exact phrase, so `"\"zod\""` matches the dependency key
    // `"zod":` and not names that merely contain it (zod-to-json-schema).
    codeSearchUrl: 'https://github.com/search?type=code&q=' + encodeURIComponent(`"\\"${name}\\"" path:package.json`),
  };
}
