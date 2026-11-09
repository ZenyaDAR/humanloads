// Pure helpers for scripts/build-data.mjs and scripts/prerender.mjs, kept apart from those scripts' top-level
// network/file work so tests can import them. Only erasable TS syntax: Node runs this file by type stripping.
import semver from 'semver';
import type { Calibration, ChainStep, DeprecatedRow, FeaturedRow, InsightsFile, ListData, ListRow, ListsFile, MarketGrowth, RawPackageData, ShieldsBadge } from '../src/core/types.ts';
import { addDays, median } from '../src/core/estimate.ts';
import { esc } from '../src/core/html.ts';
import {
  FILTERED_NOTE, HOME_DESCRIPTION, HOME_PITCH, HOME_TITLE, NOISE_CAPTION, NOISIEST_CAPTION, NOISIEST_NOTE, NOISIEST_TITLE, REPO_LINK_HTML, REPO_URL, SITE_NAME, compareDescription, compareLinksHtml,
  HOME_COMPARE_SIZE, comparePath, compareTitle, deprecatedHtml, isIndexable, noiseBar, noiseText, numberCardsHtml, packageDescription, peopleAnswerHtml, popularHtml, homeFaqHtml, packageTitle, rangeText, roundCount,
} from '../src/core/seo.ts';
import { MARKET_MIN_WEEKLY, adoptionHtml, chainHtml, factsHtml, monthlyHtml } from '../src/core/insights.ts';
import { GUIDES, HOME_FAQ, type Guide } from '../src/core/guides.ts';
import { LIST_DEFS, categoryRankHtml, listLinksHtml } from '../src/core/lists.ts';
import {
  METHODOLOGY_DESCRIPTION, METHODOLOGY_FAQ, METHODOLOGY_PATH, METHODOLOGY_SECTIONS, METHODOLOGY_TITLE, methodologyBody,
} from '../src/core/methodology.ts';

export { esc };

const FEATURED_SIZE = 8;
const EXAMPLES_SIZE = 4;
const POPULAR_SIZE = 36; // internal links from the homepage, so crawlers reach package pages in one step
const AUTO_LIST_SIZE = 50; // rows in a list over the whole catalog
const NOISY_MIN_NPM = 100;
const NOISY_MIN_SHARE = 0.3;
// A release puts a package in this list for days whatever its real use, so only settled packages qualify.
const NOISY_MIN_AGE_DAYS = 30;
const NOISY_QUIET_DAYS = 14;
// The rolling catalog behind the package pages. At full size about 70 rows a night rotate, so a row waits about three weeks.
export const CATALOG_MAX = 1500;
const CATALOG_STALE_DAYS = 60;
const DAY_MS = 86_400_000;
const OLD_VERSION_DAYS = 14; // same cutoff as estimate.ts step B
// ponytail: sanity ceiling, not a measurement (the default floor is 3). A higher canary reading means the name was
// taken over or inflated, so ignore it. Tune it once real canary data exists.
const MAX_PLAUSIBLE_FLOOR = 100;

// Canary: every download is bot/mirror noise, so its numbers calibrate the model.
export function calibrate(data: RawPackageData, source: string): Calibration | null {
  const series = data.downloads;
  const lastDay = series.at(-1)?.day;
  if (!lastDay) return null;
  const publishDay: Record<string, string> = {};
  for (const [v, iso] of Object.entries(data.registry.time)) {
    if (v === 'created' || v === 'modified' || typeof iso !== 'string' || isNaN(Date.parse(iso))) continue;
    publishDay[v] = new Date(iso).toISOString().slice(0, 10);
  }
  // floorPerVersion: median weekly downloads of versions old enough to be past their publish spike.
  const oldCutoff = addDays(lastDay, -OLD_VERSION_DAYS);
  const old = Object.keys(publishDay)
    .filter((v) => publishDay[v] < oldCutoff)
    .map((v) => data.versionsLastWeek[v] ?? 0);
  // ponytail: only the floor is measured; estimate() uses nothing else. Measure the spike size again once the model uses it.
  if (!old.length) return null;
  const floorPerVersion = median(old);
  if (floorPerVersion > MAX_PLAUSIBLE_FLOOR) return null;
  return {
    floorPerVersion,
    updated: new Date().toISOString(),
    source,
  };
}

// A run that loses data must not overwrite the previous good badges and featured lists. Returns why the run
// should fail, or null. Applied to the fetched pool only, so a local `--limit` run stays usable.
// Only transient failures (429, 5xx, network) count: names in `notFound` (permanent 404s) are left out,
// otherwise one unpublished package would fail every future deploy.
export function poolFailure(
  candidates: string[],
  ok: { has(name: string): boolean },
  tracked: string[],
  notFound: { has(name: string): boolean } = new Set(),
): string | null {
  const failed = candidates.filter((n) => !ok.has(n) && !notFound.has(n));
  const lostTracked = failed.filter((n) => tracked.includes(n));
  if (lostTracked.length) return `tracked packages failed: ${lostTracked.join(', ')}`;
  if (failed.length * 2 > candidates.length) return `${failed.length}/${candidates.length} packages failed`;
  return null;
}

const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;

function settledAndNoisy(r: FeaturedRow): boolean {
  const f = r.facts;
  if (!f?.firstPublished || !f.lastRelease || f.deprecated || r.tooNew || r.confidence === 'low') return false;
  return (
    r.npmWeekly >= NOISY_MIN_NPM &&
    r.inflation >= NOISY_MIN_SHARE &&
    daysBetween(f.firstPublished, f.asOf) >= NOISY_MIN_AGE_DAYS &&
    daysBetween(f.lastPublish ?? f.lastRelease.day, f.asOf) >= NOISY_QUIET_DAYS
  );
}

export function selectFeatured(all: FeaturedRow[]): { examples: string[]; popular: string[]; noisiest: FeaturedRow[] } {
  const popular = [...all].sort((a, b) => b.npmWeekly - a.npmWeekly).slice(0, POPULAR_SIZE).map((r) => r.name);
  const examples = popular.slice(0, EXAMPLES_SIZE);
  // One package per scope, so a single project can't fill the list. Fewer than FEATURED_SIZE qualifying rows give a
  // shorter list, never one padded with barely noisy packages.
  const scopes = new Set<string>();
  const noisiest = all
    .filter(settledAndNoisy)
    .sort((a, b) => b.inflation - a.inflation || b.npmWeekly - a.npmWeekly)
    .filter((r) => {
      if (!r.name.startsWith('@')) return true;
      const scope = r.name.split('/')[0];
      if (scopes.has(scope)) return false;
      scopes.add(scope);
      return true;
    })
    .slice(0, FEATURED_SIZE);
  return { examples, popular, noisiest };
}

// ---------- insights.json: what can be derived from the whole catalog ----------

const DEPRECATED_MIN_WEEKLY = 10_000;
const DEPRECATED_SIZE = 100;
const CHAIN_MIN_WEEKLY = 100_000;
const CHAIN_MAX_STEPS = 6;
const PARENT_MIN_SHARE = 0.3; // a dependent carrying less than this doesn't change the story, more than one means a fork
const PARENT_MIN_EXPLAINED = 0.5; // pages say "mostly through other packages", so the parent must carry at least half
const [MATCH_LOW, MATCH_HIGH] = [0.7, 1.3];
const DEPRECATED_NIGHTLY = 20;

export function deprecatedRows(rows: FeaturedRow[]): DeprecatedRow[] {
  return rows
    // @types stubs are deprecated by design once a package ships its own types: a long list saying nothing.
    .filter((r) => r.facts?.deprecated && !r.name.startsWith('@types/') && r.npmWeekly >= DEPRECATED_MIN_WEEKLY)
    .sort((a, b) => b.npmWeekly - a.npmWeekly)
    .slice(0, DEPRECATED_SIZE)
    .map((r) => ({
      name: r.name,
      npmWeekly: r.npmWeekly,
      message: r.facts!.deprecated!,
      ...(r.facts!.lastRelease && { lastRelease: r.facts!.lastRelease.day }),
    }));
}

// The top of the list is refreshed every night, like the homepage: it says their maintainers retired them, and that can change.
export const deprecatedToRefresh = (rows: FeaturedRow[]): string[] => deprecatedRows(rows).slice(0, DEPRECATED_NIGHTLY).map((r) => r.name);

export function marketGrowth(rows: FeaturedRow[]): MarketGrowth {
  const values = rows.filter((r) => r.npmWeekly >= MARKET_MIN_WEEKLY && typeof r.facts?.growth11m === 'number').map((r) => r.facts!.growth11m!);
  return { growth11m: values.length ? median(values) : null, packages: values.length };
}

// Which single catalog package explains most of `child`'s downloads, if one does. A parent only counts when the range it
// asks for covers the child's most used version and the downloads on both sides line up: anything looser would name a
// parent for every popular package. Parents outside the catalog are invisible, so a missed fork stays possible.
function soleParent(child: FeaturedRow, parentsOf: Map<string, FeaturedRow[]>): FeaturedRow | null {
  const top = child.facts?.adoption;
  if (!top) return null;
  const big = (parentsOf.get(child.name) ?? []).filter((p) => p.pulls![child.name].weekly >= PARENT_MIN_SHARE * child.npmWeekly);
  if (big.length !== 1) return null;
  const pull = big[0].pulls![child.name];
  const topWeekly = top.topShare * child.organicWeekly;
  const ratio = topWeekly > 0 ? pull.rangeWeekly / topWeekly : 0;
  // The top version alone isn't enough: 14M downloads can match a version without saying anything about the other 165M.
  if (pull.rangeWeekly < PARENT_MIN_EXPLAINED * child.npmWeekly) return null;
  return ratio >= MATCH_LOW && ratio <= MATCH_HIGH && semver.satisfies(top.topVersion, pull.range) ? big[0] : null;
}

export function dependencyChains(rows: FeaturedRow[]): Record<string, ChainStep[]> {
  const parentsOf = new Map<string, FeaturedRow[]>();
  for (const r of rows) {
    for (const child of Object.keys(r.pulls ?? {})) parentsOf.set(child, [...(parentsOf.get(child) ?? []), r]);
  }
  const step = (r: FeaturedRow): ChainStep => ({ name: r.name, ...(r.facts?.adoption && { version: r.facts.adoption.topVersion }), weekly: r.npmWeekly });
  const chains: [string, ChainStep[]][] = [];
  for (const r of rows) {
    if (r.npmWeekly < CHAIN_MIN_WEEKLY) continue;
    const trail = [r];
    for (let p = soleParent(r, parentsOf); p && trail.length < CHAIN_MAX_STEPS && !trail.includes(p); p = soleParent(p, parentsOf)) trail.push(p);
    if (trail.length >= 2) chains.push([r.name, trail.map(step)]);
  }
  return Object.fromEntries(chains);
}

const listRow = (r: FeaturedRow): ListRow => ({
  name: r.name,
  ...(r.description && { description: r.description }),
  npmWeekly: r.npmWeekly,
  organicWeekly: r.organicWeekly,
  low: r.low,
  high: r.high,
  confidence: r.confidence,
  ...(r.facts?.deprecated && { deprecated: true }),
  ...(r.facts?.lastRelease && { lastRelease: r.facts.lastRelease.day }),
  ...(r.updated && { updated: r.updated }),
});

// Too-new packages have no ranking number yet. @types stubs would crowd lists over the whole catalog without saying anything.
export function buildLists(rows: FeaturedRow[], pairs: string[][] = []): Record<string, ListData> {
  const ranked = rows.filter((r) => !r.tooNew);
  const whole = ranked.filter((r) => !r.name.startsWith('@types/'));
  return Object.fromEntries(
    LIST_DEFS.map((def) => {
      const names = def.names;
      if (!names) {
        const top = [...whole].sort((a, b) => b.npmWeekly - a.npmWeekly).slice(0, AUTO_LIST_SIZE);
        return [def.slug, { rows: top.map(listRow), pairs: [], catalog: rows.length }];
      }
      const picked = ranked.filter((r) => names.includes(r.name)).sort((a, b) => b.organicWeekly - a.organicWeekly);
      const inList = new Set(picked.map((r) => r.name));
      // Only pairs whose packages both have numbers: the others' compare pages stay out of indexes.
      return [def.slug, { rows: picked.map(listRow), pairs: pairs.filter((p) => p.every((n) => inList.has(n))) }];
    }),
  );
}

export function buildInsights(rows: FeaturedRow[], generated: string): InsightsFile {
  return { generated, market: marketGrowth(rows), deprecated: deprecatedRows(rows), chains: dependencyChains(rows) };
}

// ---------- rolling catalog: pages stay up between builds, only the numbers rotate ----------

// What a previous summary.json gives this build. With another model version its numbers can't be mixed with new ones, but
// its names stay `pending`: their pages keep working with generic text until they get their turn, instead of turning into 404s.
export function readPrevious(body: unknown, model: string): { rows: Record<string, FeaturedRow>; pending: string[]; archived: string[] } {
  const b = body as { model?: string; packages?: Record<string, FeaturedRow>; pending?: string[]; archived?: string[] } | null;
  if (!b?.packages || typeof b.packages !== 'object') throw new Error('summary.json has no packages');
  const pending = Array.isArray(b.pending) ? b.pending : [];
  const archived = Array.isArray(b.archived) ? b.archived : [];
  return b.model === model ? { rows: b.packages, pending, archived } : { rows: {}, pending: [...new Set([...Object.keys(b.packages), ...pending])], archived };
}

// Names that left the catalog (over the cap, or not refreshed for weeks) keep a page without numbers and out of search
// indexes: a link to it still works, and a 404 would be the worse answer. Unpublished and blocked names do leave.
// ponytail: oldest dropped past the cap, about 50 MB of HTML. Raise it if GitHub Pages' size limit allows and old links matter.
const ARCHIVE_MAX = 5000;
export function archiveNames(
  known: string[],
  stay: { has(name: string): boolean },
  gone: { has(name: string): boolean },
  max = ARCHIVE_MAX,
): string[] {
  return [...new Set(known)].filter((n) => !stay.has(n) && !gone.has(n)).slice(-max);
}

// Comparison and list packages are too many to fetch every night, and they would leave no budget for the rest of the
// catalog. A share of the budget rotates through them: names with no row first, then the stalest. Pages wait on names
// with no row (a new pair, a model change), so those may take up to `maxMissing` until they all have one.
export function curatedToRefresh(names: string[], previous: Record<string, FeaturedRow>, max: number, maxMissing = max): string[] {
  const updated = (n: string) => (Object.hasOwn(previous, n) ? (previous[n].updated ?? '') : '');
  const sorted = [...new Set(names)].sort((a, b) => updated(a).localeCompare(updated(b)));
  const missing = sorted.filter((n) => !Object.hasOwn(previous, n)).length;
  return sorted.slice(0, Math.max(max, Math.min(missing, maxMissing)));
}

// Which comparison pages exist. `pairs` have numbers for every package: indexable, in the sitemap and in links.
// `pages` adds pairs whose names wait for numbers or left the catalog, so their URLs keep working out of indexes.
// A name never fetched has no page yet.
export function comparePages(all: string[][], packages: Record<string, unknown>, waiting: string[]): { pairs: string[][]; pages: string[][] } {
  const known = new Set(waiting);
  return {
    pairs: all.filter((p) => p.every((n) => Object.hasOwn(packages, n))),
    pages: all.filter((p) => p.every((n) => Object.hasOwn(packages, n) || known.has(n))),
  };
}

// Which packages to fetch tonight: required ones, then a share of what is left for names new to the catalog (half
// while it grows, a quarter once full), then the rows that have waited longest. Unused budget goes to more new names.
const TOP_PAGES_PER_RUN = 5;
const TOP_DEPTH = 30; // pages of 100, so about six nights to pass the top 3,000 and start over

// Which pages of the downloads ranking to read on this day.
export function topPages(dayNumber: number): number[] {
  const start = (dayNumber * TOP_PAGES_PER_RUN) % TOP_DEPTH;
  return Array.from({ length: TOP_PAGES_PER_RUN }, (_, i) => ((start + i) % TOP_DEPTH) + 1);
}

// Names that lost their numbers to a model change come right after the required ones: their pages are out of indexes until then.
export function refreshPlan(must: string[], seeds: string[], previous: Record<string, FeaturedRow>, budget: number, pending: string[] = []): string[] {
  const plan = new Set(must);
  for (const n of pending) if (plan.size < budget) plan.add(n);
  const fresh = [...new Set(seeds)].filter((n) => !Object.hasOwn(previous, n) && !plan.has(n));
  const stalest = Object.values(previous)
    .filter((r) => !plan.has(r.name))
    .sort((a, b) => (a.updated ?? '').localeCompare(b.updated ?? ''))
    .map((r) => r.name);
  const newShare = Math.ceil(Math.max(0, budget - plan.size) / (Object.keys(previous).length >= CATALOG_MAX ? 4 : 2));
  for (const n of fresh.slice(0, newShare)) plan.add(n);
  for (const n of stalest) if (plan.size < budget) plan.add(n);
  for (const n of fresh) if (plan.size < budget) plan.add(n);
  return [...plan];
}

// Fresh rows over the previous ones. Unpublished packages, blocked names and rows nobody could refresh for weeks
// leave; past the cap the smallest by npm's count go first (by real installs, the noisiest packages would always go
// first and the homepage list would run dry), never the `keep` names that badges and compare pages rely on, and never
// a row fetched tonight, or a small new name would be fetched and thrown away again every night.
export function mergeCatalog(
  previous: Record<string, FeaturedRow>,
  fresh: Map<string, FeaturedRow>,
  opts: { gone: { has(name: string): boolean }; blocked: { has(name: string): boolean }; keep: { has(name: string): boolean }; now: string; max?: number },
): Record<string, FeaturedRow> {
  const rows = new Map(Object.entries(previous));
  for (const [name, row] of fresh) rows.set(name, row);
  for (const [name, row] of rows) {
    const stale = !row.updated || daysBetween(row.updated, opts.now) > CATALOG_STALE_DAYS;
    if (opts.gone.has(name) || opts.blocked.has(name) || (stale && !opts.keep.has(name))) rows.delete(name);
  }
  const extra = rows.size - (opts.max ?? CATALOG_MAX);
  if (extra > 0) {
    const smallest = [...rows.values()].filter((r) => !opts.keep.has(r.name) && !fresh.has(r.name)).sort((a, b) => a.npmWeekly - b.npmWeekly);
    for (const r of smallest.slice(0, extra)) rows.delete(r.name);
  }
  return Object.fromEntries(rows);
}

export function compactCount(n: number): string {
  const short = (x: number, unit: string) => `${(Math.round(x * 10) / 10).toString()}${unit}`;
  if (n >= 999_950) return short(n / 1e6, 'M');
  if (n >= 1000) return short(n / 1e3, 'k');
  return String(n);
}

const COLORS = { high: 'brightgreen', medium: 'yellow', low: 'lightgrey' } as const;

export function badgeFor(row: Pick<FeaturedRow, 'organicWeekly' | 'confidence' | 'tooNew'>): ShieldsBadge {
  return { schemaVersion: 1, label: 'real installs/week', message: row.tooNew ? 'too new' : `≈ ${compactCount(row.organicWeekly)}`, color: COLORS[row.confidence] };
}

// "@scope/name" -> "scope__name": a flat file name for badges and fixtures.
export const safeName = (name: string): string => name.replace(/^@/, '').replace('/', '__');

// ---------- prerender: static HTML for crawlers, replaced by the SPA when it boots ----------

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const day = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t)
    ? null
    : new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const range = (r: Pick<FeaturedRow, 'low' | 'high'>) => rangeText(r.low, r.high);
const noiseShare = (r: Pick<FeaturedRow, 'npmWeekly' | 'organicWeekly' | 'tooNew'>) => noiseText(r.npmWeekly, r.organicWeekly, r.tooNew);

// <script type="application/ld+json"> body; "<" is escaped so no string can close the script tag.
export function jsonLd(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

interface Page {
  title: string;
  description: string;
  url: string;
  body: string; // goes inside <main id="app">
  jsonLd?: unknown;
  noindex?: boolean;
}

// The SPA shell with this page's <title>, description, canonical, Open Graph, JSON-LD and static body.
export function withPage(shell: string, page: Page): string {
  const tags = [
    ...(page.noindex ? ['<meta name="robots" content="noindex" />'] : []),
    `<meta name="description" content="${esc(page.description)}" />`,
    `<link rel="canonical" href="${esc(page.url)}" />`,
    `<meta property="og:title" content="${esc(page.title)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${esc(page.url)}" />`,
    ...(page.jsonLd ? [jsonLd(page.jsonLd)] : []),
  ].join('\n    ');
  return (
    shell
      // Drop the shell's own copies of tags set here; anything else (og:image, og:site_name...) stays.
      .replace(/\s*<meta\s+(?:name="description"|property="og:(?:title|description|url)")[^>]*>/g, '')
      .replace(/\s*<link\s+rel="canonical"[^>]*>/g, '')
      .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(page.title)}</title>\n    ${tags}`)
      .replace(/(id="app">)\s*(<\/)/, (_, open: string, close: string) => `${open}${page.body}${close}`)
  );
}

// 404.html: the bare shell (no static body, no canonical), kept out of indexes. GitHub Pages serves it with
// HTTP 404 for any path without a file; the SPA still boots and renders the route.
export function notFoundHtml(shell: string): string {
  return shell
    .replace(/\s*<link\s+rel="canonical"[^>]*>/g, '')
    .replace(/\s*<meta\s+property="og:url"[^>]*>/g, '')
    .replace(/<title>/, () => '<meta name="robots" content="noindex" />\n    <title>');
}

// Inert stand-ins for the controls the SPA builds (search box, theme toggle), with the same classes and
// sizes, so nothing moves when the app takes over (CLS). Hidden from assistive tech and not focusable.
const searchStandIn = (id: 'top' | 'home', placeholder: string) =>
  `<form class="search search-${id}" inert aria-hidden="true"><input type="text" placeholder="${placeholder}" /><button type="button">Look</button><p class="search-hint"></p></form>`;
const headTools = `<div class="head-tools">${REPO_LINK_HTML}<span class="theme-toggle" inert aria-hidden="true">◐ system</span></div>`;

const masthead = (base: string) =>
  `<header class="masthead"><a class="logo" href="${esc(base)}">human<span>loads</span></a>${searchStandIn('top', 'search a package…')}${headTools}</header>`;

const METHOD_STEPS = `<ol>
        <li>Cut the spike every new version gets from mirrors in its first days.</li>
        <li>Subtract the flat floor robots download from <em>every</em> version each week.</li>
        <li>Show what is left as a range, with a confidence level. It still includes CI and dependency installs, so it is not a count of people.</li>
      </ol>`;

function website(site: string) {
  return { '@type': 'WebSite', '@id': `${site}#website`, url: site, name: SITE_NAME, description: HOME_DESCRIPTION, inLanguage: 'en' };
}

export interface PackagePageOpts {
  generated?: string; // summary.json timestamp
  related?: string[]; // other prerendered packages to link to
  comparisons?: string[][]; // prerendered compare pages that include this package
  insights?: InsightsFile | null;
  lists?: ListsFile | null; // for the category rank
}

export function prerenderHtml(
  shell: string,
  name: string,
  r: FeaturedRow | undefined,
  site: string,
  opts: PackagePageOpts = {},
): string {
  const base = new URL(site).pathname;
  const title = packageTitle(name);
  const description = packageDescription(name, r);
  const url = site + name;
  const asOf = day(opts.generated);
  const npmUrl = `https://www.npmjs.com/package/${name}`;

  const numbers = r
    ? `${numberCardsHtml({ npm: r.npmWeekly, organic: r.organicWeekly, low: r.low, high: r.high, confidence: r.confidence, tooNew: r.tooNew })}
      ${adoptionHtml(r.facts)}
      <p class="fineprint">Snapshot from the daily build${asOf ? ` of ${esc(asOf)}` : ''}, last 7 days of npm data. With JavaScript on, this page recomputes it live from the npm API.</p>
      ${peopleAnswerHtml(name, { npm: r.npmWeekly, organic: r.organicWeekly, low: r.low, high: r.high, confidence: r.confidence, tooNew: r.tooNew })}
      ${r.facts ? factsHtml(name, r.facts, opts.insights?.market, r.npmWeekly) : ''}
      ${monthlyHtml(name, r.facts)}
      ${categoryRankHtml(name, opts.lists, base)}
      ${chainHtml(name, opts.insights?.chains[name], base)}`
    : `<section>
        <h2 class="section-title">What this page shows</h2>
        <p>npm's download count for ${esc(name)} includes every tarball fetch: registry mirrors, security scanners,
          CI pipelines and crawlers as well as people. This page fetches the last 12 months from the npm API and
          removes the mirror spikes and the crawler floor, then shows the real installs as a weekly range with a confidence level.</p>
      </section>`;

  const related = (opts.related ?? []).filter((n) => n !== name);
  const body = `<div class="view">
    ${masthead(base)}
    <article class="pkg">
      <header class="pkg-head">
        <h1 tabindex="-1"><span class="pkg-name">${esc(name)}</span></h1>
        ${r?.description ? `<p class="pkg-desc">${esc(r.description)}</p>` : ''}
        <ul class="pkg-links"><li><a href="${esc(npmUrl)}">npm</a></li></ul>
        ${r?.facts?.deprecated ? deprecatedHtml(r.facts.deprecated) : ''}
      </header>
      ${numbers}
      <section>
        <h2 class="section-title">How the estimate works</h2>
        ${METHOD_STEPS}
        <p class="method"><a href="${esc(base + METHODOLOGY_PATH)}">Read the methodology <span aria-hidden="true">→</span></a></p>
      </section>
      ${compareLinksHtml(base, opts.comparisons ?? [], esc, `Compare ${name}`)}
      ${
        related.length
          ? `<section>
        <h2 class="section-title">Other packages</h2>
        <ul class="ev-top">${related.map((n) => `<li><a class="tag" href="${esc(base + n)}">${esc(n)}</a></li>`).join('')}</ul>
      </section>`
          : ''
      }
    </article>
  </div>`;

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      website(site),
      {
        '@type': 'WebPage',
        '@id': url,
        url,
        name: title,
        description,
        inLanguage: 'en',
        isPartOf: { '@id': `${site}#website` },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        about: { '@type': 'SoftwareSourceCode', name, url: npmUrl },
        ...(opts.generated && { dateModified: opts.generated }),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: site },
          { '@type': 'ListItem', position: 2, name, item: url },
        ],
      },
    ],
  };
  return withPage(shell, { title, description, url, body, jsonLd: ld, noindex: !isIndexable(r) });
}

// Same markup as the SPA's home cards (src/web/home.ts), so the swap on boot looks alike.
function homeCard(r: FeaturedRow, base: string): string {
  return `<li><a class="fcard" href="${esc(base + r.name)}">
    <span class="fcard-name">${esc(r.name)}</span>
    <span class="fcard-tag">${Math.round(r.inflation * 100)}% noise</span>
    ${r.description ? `<span class="fcard-desc">${esc(r.description)}</span>` : ''}
    <span class="fcard-nums">
      <s class="struck num"><span class="sr-only">npm says </span>${roundCount(r.npmWeekly)}</s>
      <span class="fcard-human">≈ <mark>${range(r)}</mark> real installs</span>
    </span>
    ${noiseBar(r.inflation, ' noise-bar-mini')}
    <span class="pill pill-${esc(r.confidence)}">${esc(r.confidence)}</span>
  </a></li>`;
}

export interface Featured {
  generated?: string;
  examples?: string[];
  popular?: string[];
  noisiest?: FeaturedRow[];
}

// index.html: the home page with its featured lists as static links, so crawlers find the package pages.
export function homeHtml(shell: string, site: string, featured: Featured | null, pairs: string[][] = []): string {
  const base = new URL(site).pathname;
  const noisiest = featured?.noisiest?.length
    ? `<section class="fcards-sec">
        <h2 class="section-title">${NOISIEST_TITLE} <span class="fcards-note hand">${NOISIEST_NOTE}</span></h2>
        <ul class="fcards">${featured.noisiest.slice(0, 6).map((r) => homeCard(r, base)).join('')}</ul>
        <p class="fineprint">${NOISIEST_CAPTION}</p>
      </section>`
    : '';
  const asOf = day(featured?.generated);
  const body = `<div class="view">
    <div class="home-top">${headTools}</div>
    <section class="home">
      <h1 class="home-title" tabindex="-1">human<span class="home-title-mark">loads</span></h1>
      <p class="home-pitch">${HOME_PITCH}</p>
      <div class="home-search">${searchStandIn('home', 'package name, e.g. zod')}</div>
      ${
        featured?.examples?.length
          ? `<p class="home-examples"><span class="hand">try one</span>
        ${featured.examples.slice(0, 4).map((n) => `<a class="tag" href="${esc(base + n)}">${esc(n)}</a>`).join('')}</p>`
          : ''
      }
    </section>
    <div class="featured">
      ${noisiest}
      ${popularHtml(base, featured?.popular ?? [])}
      ${asOf ? `<p class="fineprint">Updated ${esc(asOf)}. Weekly numbers, last 7 days.</p>` : ''}
    </div>
    ${compareLinksHtml(base, pairs.slice(0, HOME_COMPARE_SIZE), esc)}
    ${listLinksHtml(base)}
    <aside class="home-note">
      <p class="hand">how it works</p>
      ${METHOD_STEPS}
      <p><a href="${esc(base + METHODOLOGY_PATH)}">Read the methodology</a></p>
    </aside>
    ${homeFaqHtml(base)}
  </div>`;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      website(site),
      {
        '@type': 'Dataset',
        '@id': `${site}#dataset`,
        name: 'npm download stats and real installs',
        description:
          'Weekly npm download counts next to real installs: what remains after removing publish spikes from registry ' +
          'mirrors and scanners, and the crawler floor. Part of the catalog is refreshed daily from the public npm downloads API.',
        url: site,
        isAccessibleForFree: true,
        license: 'https://github.com/ZenyaDAR/humanloads/blob/main/LICENSE',
        creator: { '@type': 'Person', name: 'Yevhenii Dziza', url: 'https://github.com/ZenyaDAR' },
        keywords: ['npm', 'downloads', 'bot traffic', 'package popularity'],
        measurementTechnique: 'Publish-spike removal and per-version crawler floor subtraction',
        variableMeasured: ['npm weekly downloads', 'estimated weekly real installs', 'confidence'],
        ...(featured?.generated && { dateModified: featured.generated }),
        distribution: [
          { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${site}data/summary.json` },
          { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${site}data/featured.json` },
        ],
      },
      { '@type': 'FAQPage', '@id': `${site}#faq`, mainEntity: HOME_FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    ],
  };
  return withPage(shell, { title: HOME_TITLE, description: HOME_DESCRIPTION, url: site, body, jsonLd: ld });
}

const COMPARE_COLORS = ['--marker', '--berry', '--green']; // same as src/web/compare.ts

// compare/<a>,<b>.html: a popular pair with the build-time numbers side by side; the SPA then draws the chart.
export function compareHtml(
  shell: string,
  names: string[],
  rows: (FeaturedRow | undefined)[],
  site: string,
  opts: { generated?: string; others?: string[][] } = {},
): string {
  const base = new URL(site).pathname;
  const path = comparePath(names);
  const url = site + path;
  const title = compareTitle(names);
  const description = compareDescription(names, rows);
  const asOf = day(opts.generated);
  const vs = names.map(esc).join(' vs ');
  const known = rows.every(Boolean) ? (rows as FeaturedRow[]) : null;

  // "Which is more popular?" answered in one sentence, by real installs rather than raw downloads.
  let answer = '';
  if (known && !known.some((r) => r.tooNew)) {
    const order = names.map((n, i) => ({ n, r: known[i] })).sort((a, b) => b.r.organicWeekly - a.r.organicWeekly);
    const [top, next] = order;
    const ratio = next.r.organicWeekly > 0 ? top.r.organicWeekly / next.r.organicWeekly : null;
    answer = `<p>By real installs, <strong>${esc(top.n)}</strong> is ahead of ${esc(next.n)}${
      ratio && ratio >= 1.1 ? ` by about ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×` : ', and the two are close'
    }: about ${roundCount(top.r.organicWeekly)} vs ${roundCount(next.r.organicWeekly)} a week. npm's raw counts are
      ${known.map((r, i) => `${fmt(r.npmWeekly)} for ${esc(names[i])}`).join(' and ')}, which include mirrors, scanners and crawlers.
      ${esc(FILTERED_NOTE)}</p>`;
  }

  const table = known
    ? `<div class="table-wrap"><table class="cmp-table">
        <thead><tr><th scope="col">package</th><th scope="col" class="num">npm / week</th><th scope="col" class="num">real installs / week</th>
          <th scope="col" class="num">noise</th><th scope="col">confidence</th></tr></thead>
        <tbody>${known
          .map(
            (r, i) => `<tr><th scope="row"><a href="${esc(base + names[i])}">${esc(names[i])}</a></th>
            <td class="num" data-label="npm / week">${fmt(r.npmWeekly)}</td>
            <td class="num above" data-label="real installs / week">${range(r)}</td>
            <td class="num" data-label="noise">${noiseShare(r)}</td>
            <td data-label="confidence"><span class="pill pill-${esc(r.confidence)}">${esc(r.confidence)}</span></td></tr>`,
          )
          .join('')}</tbody>
      </table></div>
      <p class="fineprint">${NOISE_CAPTION}</p>
      <p class="fineprint">Snapshot from the daily build${asOf ? ` of ${esc(asOf)}` : ''}, last 7 days of npm data. With JavaScript on, this page recomputes it live with a 12-month chart.</p>`
    : '';

  const body = `<div class="view">
    ${masthead(base)}
    <article class="pkg compare">
      <header class="pkg-head"><h1 tabindex="-1">${names.map((n) => `<span class="pkg-name">${esc(n)}</span>`).join(' <span class="vs hand">vs</span> ')}</h1></header>
      <figure class="chart-fig">
        <figcaption>
          <h2 class="section-title">Real installs, week by week</h2>
          <ul class="legend">
            ${names.map((n, i) => `<li><span class="key key-line" style="--c:var(${COMPARE_COLORS[i]})" aria-hidden="true"></span>${esc(n)}</li>`).join('')}
            <li><span class="key key-npm" aria-hidden="true"></span>npm downloads (same color, dashed)</li>
          </ul>
        </figcaption>
        <div class="sk sk-chart" aria-hidden="true"></div>
        <p class="fineprint">The 12-month chart is drawn in the browser from the npm API.</p>
      </figure>
      <section class="versions">
        <h2 class="section-title">${vs}: which is more popular?</h2>
        ${table}
        ${answer || `<p>npm's weekly download counts for ${vs}, with mirror spikes and crawler traffic removed, week by week.</p>`}
      </section>
      <section>
        <h2 class="section-title">How the estimate works</h2>
        ${METHOD_STEPS}
        <p class="method"><a href="${esc(base + METHODOLOGY_PATH)}">Read the methodology <span aria-hidden="true">→</span></a></p>
      </section>
      ${compareLinksHtml(base, opts.others ?? [], esc, 'More comparisons')}
    </article>
  </div>`;

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      website(site),
      {
        '@type': 'WebPage',
        '@id': url,
        url,
        name: title,
        description,
        inLanguage: 'en',
        isPartOf: { '@id': `${site}#website` },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        about: names.map((n) => ({ '@type': 'SoftwareSourceCode', name: n, url: `https://www.npmjs.com/package/${n}` })),
        ...(opts.generated && { dateModified: opts.generated }),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: site },
          { '@type': 'ListItem', position: 2, name: names.join(' vs '), item: url },
        ],
      },
    ],
  };
  // Without numbers (their turn hasn't come since a model change) the page is thin: it stays reachable, out of indexes.
  return withPage(shell, { title, description, url, body, jsonLd: ld, noindex: !known });
}

// docs/methodology.html: the English methodology, as an article with an FAQ.
export function methodologyHtml(shell: string, site: string, modified?: string): string {
  const base = new URL(site).pathname;
  const url = site + METHODOLOGY_PATH;
  const body = `<div class="view">${masthead(base)}${methodologyBody(base)}</div>`;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      website(site),
      {
        '@type': 'TechArticle',
        '@id': url,
        url,
        headline: METHODOLOGY_TITLE,
        description: METHODOLOGY_DESCRIPTION,
        inLanguage: 'en',
        isPartOf: { '@id': `${site}#website` },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        about: ['npm download counts', 'bot traffic', 'package popularity'],
        articleSection: METHODOLOGY_SECTIONS.map(([, t]) => t),
        ...(modified && { dateModified: modified }),
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        mainEntity: METHODOLOGY_FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: site },
          { '@type': 'ListItem', position: 2, name: 'Methodology', item: url },
        ],
      },
    ],
  };
  return withPage(shell, { title: METHODOLOGY_TITLE, description: METHODOLOGY_DESCRIPTION, url, body, jsonLd: ld });
}

// docs/<guide>.html: a short answer to one plain question.
export function guideHtml<T>(shell: string, site: string, guide: Guide<T>, data?: T | null): string {
  const base = new URL(site).pathname;
  const url = site + guide.path;
  const name = guide.title.replace(/ · .*$/, '');
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      website(site),
      { '@type': 'TechArticle', '@id': url, url, headline: name, description: guide.description, inLanguage: 'en', isPartOf: { '@id': `${site}#website` }, breadcrumb: { '@id': `${url}#breadcrumb` } },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: site },
          { '@type': 'ListItem', position: 2, name, item: url },
        ],
      },
    ],
  };
  return withPage(shell, {
    title: guide.title,
    description: guide.description,
    url,
    body: `<div class="view">${masthead(base)}${guide.body(base, data)}</div>`,
    jsonLd: ld,
    noindex: guide.ready ? !guide.ready(data) : false,
  });
}

// ---------- crawler files ----------

// `perUrl` holds the date a package's row was really refreshed; rows rotate, so a single date would overstate it.
export function sitemapXml(urls: string[], lastmod?: string, perUrl: Record<string, string | undefined> = {}): string {
  const mod = (iso?: string) =>
    iso && !Number.isNaN(Date.parse(iso)) ? `<lastmod>${new Date(iso).toISOString().slice(0, 10)}</lastmod>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc>${mod(perUrl[u] ?? lastmod)}</url>`).join('\n')}
</urlset>
`;
}

// Search and AI crawlers are named explicitly, so a later blanket rule cannot shut them out by accident.
const CRAWLERS = [
  'Googlebot', 'Bingbot', 'DuckDuckBot', 'Applebot', 'YandexBot',
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'meta-externalagent',
  'Amazonbot', 'MistralAI-User',
];

export function robotsTxt(site: string): string {
  return `${CRAWLERS.map((ua) => `User-agent: ${ua}`).join('\n')}
Allow: /

User-agent: *
Allow: /

Sitemap: ${site}sitemap.xml
`;
}

// https://llmstxt.org: a Markdown index for language models.
export function llmsTxt(site: string, pages: { name: string; row?: FeaturedRow }[], generated?: string, pairs: string[][] = [], lists: Pick<Guide, 'title' | 'path'>[] = []): string {
  const compares = pairs.length
    ? `\n## Comparisons\n\n${pairs.map((p) => `- [${p.join(' vs ')}](${site}${comparePath(p)})`).join('\n')}\n`
    : '';
  const ranked = lists.length
    ? `\n## Ranked lists\n\n${lists.map((g) => `- [${g.title.replace(/ · .*$/, '')}](${site}${g.path})`).join('\n')}\n`
    : '';
  const asOf = day(generated);
  const list = pages
    .map(
      ({ name, row }) =>
        `- [${name}](${site}${name})` +
        (row
          ? `: ${row.tooNew ? 'too new to tell,' : `~${roundCount(row.organicWeekly)} real installs/week`} (range ${range(row)}, ${row.confidence} confidence) vs ${fmt(row.npmWeekly)} npm downloads`
          : ''),
    )
    .join('\n');
  return `# ${SITE_NAME}

> npm's download counter counts every tarball fetch: registry mirrors, security scanners, CI and crawlers.
> humanloads removes publish spikes and the crawler floor from an npm package's weekly downloads and reports what remains as "real installs", a range with a confidence level.
> Real installs still include CI runs, Docker builds and installs as a dependency of other packages, so they are not a count of people. No public data can give that number.

## Method

- Every new version gets a burst of downloads from mirrors and scanners in its first days; that spike is removed.
- Crawlers download every published version at a roughly flat weekly rate (the per-version floor); that floor is subtracted.
- What remains is reported as a weekly range with a confidence level (high, medium or low). Small packages get wide, low-confidence ranges.
- "high" also needs independent evidence of use (dependent packages or repositories, jsDelivr CDN hits). Direct tarball requests pass both filters, so volume alone never earns it.
- Packages under two weeks old are marked as too new to tell.
- [Full methodology](${site}${METHODOLOGY_PATH}): the math, the thresholds, the limits and an FAQ
${GUIDES.map((g) => `- [${g.title.replace(/ · .*$/, '')}](${site}${g.path})`).join('\n')}

## URLs

- Home: ${site}
- A package: ${site}<package-name>, scoped: ${site}@scope/name
- Compare 2–3 packages: ${site}compare/<a>,<b>[,<c>]
- Pages compute live numbers in the browser from the public npm API. Prerendered pages also carry the daily build's numbers as static HTML.

## Data (JSON, part of the catalog refreshed daily${asOf ? `, last build ${asOf}` : ''})

- [summary.json](${site}data/summary.json): per package: npmWeekly, organicWeekly (real installs), low, high, inflation (noise share, 0–1), confidence, tooNew, updated (date of that row)
- [featured.json](${site}data/featured.json): examples, and noisiest: settled packages with the most noise in npm's count
- [insights.json](${site}data/insights.json): deprecated (the most downloaded deprecated packages), chains (dependency trails), market (median growth)
- [lists.json](${site}data/lists.json): the rows behind the ranked lists, by list slug
- [badges/index.json](${site}badges/index.json): packages with a shields.io endpoint badge at ${site}badges/<name>.json (\`@scope/name\` is written \`scope__name\`)

## Package pages

${list}
${compares}${ranked}
## Optional

- [Source code](${REPO_URL})
`;
}
