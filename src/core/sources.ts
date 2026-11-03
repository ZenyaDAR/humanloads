import type { DailyDownloads, Evidence, RawPackageData, RegistryDoc, SearchHit } from './types.ts';
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
  };
}

// ponytail: we still download the full registry doc (several MB for react) because only it carries
// `time`; the abbreviated install doc doesn't. Trimming here only keeps memory/fixtures small.
export function trimRegistry(doc: any): RegistryDoc {
  return {
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

export async function fetchEvidence(name: string, registry: RegistryDoc, fetchImpl: typeof fetch = fetch): Promise<Evidence> {
  // Verified live: ecosyste.ms accepts both "@scope/name" and "@scope%2Fname"; jsDelivr needs a raw "/"
  // ("%2F" -> 400). Dependents sorted by downloads works (zod -> @zodios/core first).
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
          .filter((d: any) => typeof d?.name === 'string')
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
