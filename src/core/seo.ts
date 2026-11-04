// Page titles and descriptions, shared by the SPA (src/web/main.ts) and the prerender script, so a crawler
// sees the same text in the static HTML and after the app boots.
import type { FeaturedRow } from './types.ts';

export const SITE_NAME = 'humanloads';
export const REPO_URL = 'https://github.com/ZenyaDAR/humanloads';

// Header link to the source, shared by the SPA header and the prerendered pages. Octicon "mark-github".
export const REPO_LINK_HTML = `<a class="gh-link" href="${REPO_URL}" rel="noopener"><svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub</a>`;
// Titles lead with the phrases people search for ("<pkg> npm downloads", "how many people use <pkg>").
export const HOME_TITLE = 'Real npm download stats, minus the bots · humanloads';
export const HOME_DESCRIPTION =
  'How many people really use an npm package? npm counts every mirror, scanner and CI fetch. humanloads estimates the real weekly human installs, with a range.';

// Bing Webmaster Tools reports descriptions over 160 characters as an error. Package names can run to 214
// characters, so templates alone can't guarantee this. A hard cut: a word-boundary cut would drop such a name
// whole and leave a description that is too short, which Bing reports too.
const MAX_DESCRIPTION = 160;
const clip = (s: string) => (s.length <= MAX_DESCRIPTION ? s : `${s.slice(0, MAX_DESCRIPTION - 1)}…`);

// "446,650,334" reads badly in a search snippet; big numbers go compact ("447M").
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fmt = (n: number) => (n >= 10_000 ? compact.format(n) : Math.round(n).toLocaleString('en-US'));
const range = (low: number, high: number) => (fmt(low) === fmt(high) ? fmt(low) : `${fmt(low)}–${fmt(high)}`);

// Long titles get cut off in results and flagged by Bing, so the site name is the first thing to go.
const MAX_TITLE = 70;
const titled = (t: string) => (t.length + SITE_NAME.length + 3 <= MAX_TITLE ? `${t} · ${SITE_NAME}` : t);

export function packageTitle(name: string): string {
  const full = `${name} npm downloads vs real human installs`;
  return full.length <= MAX_TITLE ? titled(full) : `${name} npm downloads vs humans`;
}

// Below this many estimated human installs a week a page stays reachable but out of search indexes: there is
// little to say about such a package and few people search for it. The same 1,000 gives "high" confidence in estimate.ts.
const INDEXABLE_MIN_WEEKLY = 1000;
export const isIndexable = (r?: Pick<FeaturedRow, 'organicWeekly'>): boolean => (r?.organicWeekly ?? 0) >= INDEXABLE_MIN_WEEKLY;

// With build-time numbers (summary.json) the description quotes them; without, it stays generic.
export function packageDescription(name: string, r?: Pick<FeaturedRow, 'organicWeekly' | 'low' | 'high' | 'confidence' | 'npmWeekly'>): string {
  return clip(r
    ? `How many people use ${name}? npm counts ${fmt(r.npmWeekly)} downloads a week; about ${range(r.low, r.high)} look like ` +
        `real human installs (${r.confidence} confidence).`
    : `How many people really use ${name}? humanloads separates real human installs from the mirrors, scanners and crawlers in its npm download count.`);
}

export function compareTitle(names: string[]): string {
  return titled(`${names.join(' vs ')}: npm downloads and real human installs`);
}

export const comparePath = (names: string[]) => `compare/${names.join(',')}`;

// "Popular comparisons" links (data/compare.json), shared by the SPA home and the prerendered pages.
// `esc` is passed in so this module stays free of DOM and Node imports.
export function compareLinksHtml(base: string, pairs: string[][], esc: (s: string) => string, title = 'Popular comparisons'): string {
  if (!pairs.length) return '';
  return `<section class="cmp-links-sec">
      <h2 class="section-title">${esc(title)}</h2>
      <ul class="cmp-links">${pairs
        .map((p) => `<li><a class="tag" href="${esc(base + comparePath(p))}">${p.map(esc).join(' vs ')}</a></li>`)
        .join('')}</ul>
    </section>`;
}

type CompareRow = Pick<FeaturedRow, 'organicWeekly' | 'npmWeekly'>;

// With numbers for every package the description quotes them, in the same order as the names.
export function compareDescription(names: string[], rows?: (CompareRow | undefined)[]): string {
  const vs = names.join(' vs ');
  if (rows?.length === names.length && rows.every(Boolean)) {
    const per = (pick: (r: CompareRow) => number) => (rows as CompareRow[]).map((r) => fmt(pick(r))).join(' vs ');
    return clip(`${vs}: which is more popular? npm counts ${per((r) => r.npmWeekly)} downloads a week; ` +
      `about ${per((r) => r.organicWeekly)} look like real human installs.`);
  }
  return clip(`${vs}: which is more popular? npm weekly downloads compared with estimated real human installs, week by week, bots removed.`);
}
