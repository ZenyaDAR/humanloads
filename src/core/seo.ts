// Page titles and descriptions, shared by the SPA (src/web/main.ts) and the prerender script, so a crawler
// sees the same text in the static HTML and after the app boots.
import { GUIDES, HOME_FAQ } from './guides.ts';
import { clip as clipOnWord, esc, rangeText, roundCount } from './html.ts';
import type { Confidence, FeaturedRow } from './types.ts';

export { rangeText, roundCount };

export const SITE_NAME = 'humanloads';
export const REPO_URL = 'https://github.com/ZenyaDAR/humanloads';

// Header link to the source, shared by the SPA header and the prerendered pages. Octicon "mark-github".
export const REPO_LINK_HTML = `<a class="gh-link" href="${REPO_URL}" rel="noopener"><svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub</a>`;
// Titles lead with what people type: "npm downloads", "npm download stats", "<pkg> npm downloads" (Google autocomplete, 2026-11).
// Not "npm installs": search completes it to the `npm install` command. The metric is "real installs": what is left after
// mirror spikes and the crawler floor. CI and dependency installs do install the package, so the label holds at any scale.
export const HOME_TITLE = 'npm download stats: check real downloads of any package · humanloads';
export const HOME_PITCH = 'Check the npm download stats of any package. <span class="hl">See how many are real installs.</span>';
export const HOME_DESCRIPTION =
  'Check the npm download stats of any package and see how many are real installs, with mirror spikes and crawler traffic removed. Free, no signup.';
export const NOISIEST_TITLE = "Most noise in npm's count";
export const NOISIEST_NOTE = 'settled packages, no release in the last two weeks';
export const NOISIEST_CAPTION = 'Noise here means ordinary mirrors and crawlers, not foul play.';
export const NOISE_CAPTION = "Noise: the share of npm's count that mirror spikes and crawlers account for. What remains still includes CI and dependency installs.";
export const noiseText = (npm: number, organic: number, tooNew?: boolean): string => {
  if (tooNew || npm <= 0) return 'unknown yet';
  const share = 1 - organic / npm;
  return share < 0.01 ? 'under 1%' : `${Math.round(share * 100)}%`;
};
// Calm notice under the package header when the latest version is deprecated; shared so it is there at first paint.
export const deprecatedHtml = (message: string): string =>
  `<p class="deprecated"><strong>Deprecated on npm.</strong> The maintainers' message: “${esc(clipOnWord(message, 200))}”</p>`;
export const CHECKING_LABEL = 'checking evidence…';
export const FILTERED_NOTE = 'Mirror spikes and crawlers removed. CI and dependency installs still count, so this is not a head count.';

// At this scale filtering barely moves npm's number, so a separate "best guess" would only add false precision.
const QUIET_MIN_NPM = 1_000_000;
const QUIET_MAX_SHARE = 0.01;
export const quietAtScale = (npm: number, organic: number): boolean => npm >= QUIET_MIN_NPM && 1 - organic / npm < QUIET_MAX_SHARE;

export interface CardNumbers {
  npm: number;
  organic: number;
  low: number;
  high: number;
  confidence: Confidence;
  tooNew?: boolean;
  checking?: boolean; // the app is still fetching the evidence that decides the confidence level
}

// Share of npm's count that filtering removed, 0..1.
const noiseShare = (n: CardNumbers): number => (n.npm > 0 ? Math.min(1, Math.max(0, 1 - n.organic / n.npm)) : 0);

// What filtering did to npm's count, as one bar: solid = real installs, hatched = noise. A huge package reads as
// an all-solid bar, a mostly-noise one as an all-hatched bar; the text says the same in words.
function noiseHtml(n: CardNumbers): string {
  if (n.tooNew) {
    return `<div class="noise"><p class="noise-text">Noise: too new to tell yet, so the range is wide.</p><span class="noise-bar noise-bar-unknown" aria-hidden="true"></span></div>`;
  }
  const key = '<span class="noise-key"><span class="key noise-cut" aria-hidden="true"></span>noise <span class="key noise-kept" aria-hidden="true"></span>real installs</span>';
  const quiet = quietAtScale(n.npm, n.organic);
  const share = quiet ? 0 : noiseShare(n);
  const all = share >= 0.995;
  const text = quiet
    ? `<strong>noise under 1%</strong> of npm's count, so nearly all of it counts.`
    : all
      ? `<strong>Nearly all</strong> of npm's count looks like noise.`
      : `About <strong class="num">${Math.round(share * 100)}%</strong> of npm's count looks like noise.`;
  return `<div class="noise"><p class="noise-text">${text} ${key}</p>${noiseBar(share)}</div>`;
}

// Solid part = what is left after filtering, hatched part = noise. Decorative: the same figure is always written out.
export function noiseBar(share: number, cls = ''): string {
  const kept = share >= 0.995 ? '' : `<span class="noise-kept" style="flex-grow:${(1 - share).toFixed(4)}"></span>`;
  const cut = share > 0 ? `<span class="noise-cut" style="flex-grow:${share.toFixed(4)}"></span>` : '';
  return `<span class="noise-bar${cls}" aria-hidden="true">${kept}${cut}</span>`;
}

// Links to well-known package pages on the home page: crawlers find them, and people get a quick way in.
export function popularHtml(base: string, names: string[]): string {
  if (!names.length) return '';
  return `<section class="cmp-links-sec">
      <h2 class="section-title">Popular npm packages</h2>
      <ul class="cmp-links">${names.map((n) => `<li><a class="tag" href="${esc(base + n)}">${esc(n)}</a></li>`).join('')}</ul>
    </section>`;
}

// The plain questions from search, on the home page in both static and app markup.
export function homeFaqHtml(base: string): string {
  return `<section class="home-faq doc">
      <h2 class="section-title">npm downloads: common questions</h2>
      <dl class="doc-faq">${HOME_FAQ.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl>
      <ul class="cmp-links">${GUIDES.map((g) => `<li><a class="tag" href="${esc(base + g.path)}">${esc(g.title.replace(/ · .*$/, ''))}</a></li>`).join('')}</ul>
    </section>`;
}

// The question people actually ask, answered as far as anyone can. In both the static page and the app, so it survives
// for crawlers that run JavaScript.
export function peopleAnswerHtml(name: string, n: CardNumbers): string {
  const pkg = esc(name);
  const counted = `npm counted ${Math.round(n.npm).toLocaleString('en-US')} downloads of ${pkg} in the last 7 days. Nobody can count people exactly, npm included: it does not record who downloaded what.`;
  const answer = n.tooNew
    ? n.high > 0
      ? `The package is too new to separate automated fetches from first users, so anything from ${rangeText(n.low, n.high)} could be real.`
      : 'The package is too new to tell, and npm has counted no downloads in this window.'
    : `After removing mirror spikes and crawlers, about ${rangeText(n.low, n.high)} look like real installs. ` +
      (quietAtScale(n.npm, n.organic)
        ? `At this scale most of them come from CI, builds and other packages that depend on ${pkg}, so the number of people behind them is far smaller.`
        : `Noise is ${noiseText(n.npm, n.organic)} of npm's count. What remains still includes CI and installs as a dependency of other packages.`);
  return `<section class="insights">
        <h2 class="section-title">How many people use ${pkg}?</h2>
        <p>${counted} ${answer}</p>
      </section>`;
}

// The two number cards and the noise bar, shared by the SPA and the prerender so nothing moves when the app takes over.
// `extra` fills the "Why this estimate" disclosure (notes only exist once the estimate is computed live).
export function numberCardsHtml(n: CardNumbers, extra = ''): string {
  const point = n.tooNew || quietAtScale(n.npm, n.organic) ? '' : `<p class="card-point">best guess <strong>${roundCount(n.organic)}</strong></p>`;
  const why = extra || '<p class="card-sub">With JavaScript on, this lists what the filter found for this package.</p>';
  return `<section class="cards" aria-label="Downloads in the last 7 days">
        <div class="card card-npm">
          <div class="card-head"><h2 class="card-label">npm says</h2></div>
          <p class="card-big"><s class="struck">${Math.round(n.npm).toLocaleString('en-US')}</s></p>
          <p class="per">per week</p>
          <p class="card-sub">Every tarball fetch: mirrors, scanners, CI and people.</p>
        </div>
        <div class="card card-human">
          <div class="card-head"><h2 class="card-label">real installs</h2>
            ${n.checking ? `<span class="pill pill-checking">${CHECKING_LABEL}</span>` : `<span class="pill pill-${esc(n.confidence)}">${esc(n.confidence)} confidence</span>`}</div>
          <p class="card-big">≈ <mark>${rangeText(n.low, n.high)}</mark></p>
          <p class="per">per week</p>
          ${point}
          <p class="card-sub">${FILTERED_NOTE}</p>
        </div>
        ${noiseHtml(n)}
        <details class="why"><summary>Why this estimate</summary>${why}</details>
      </section>`;
}

// Bing Webmaster Tools reports descriptions over 160 characters as an error. Package names can run to 214
// characters, so templates alone can't guarantee this. A hard cut: a word-boundary cut would drop such a name
// whole and leave a description that is too short, which Bing reports too.
const MAX_DESCRIPTION = 160;
const clip = (s: string) => (s.length <= MAX_DESCRIPTION ? s : `${s.slice(0, MAX_DESCRIPTION - 1)}…`);

// "446,650,334" reads badly in a search snippet; big numbers go compact ("447M").
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fmt = (n: number) => (n >= 10_000 ? compact.format(n) : Math.round(n).toLocaleString('en-US'));

// Long titles get cut off in results and flagged by Bing, so the site name is the first thing to go.
const MAX_TITLE = 70;
const titled = (t: string) => (t.length + SITE_NAME.length + 3 <= MAX_TITLE ? `${t} · ${SITE_NAME}` : t);

export function packageTitle(name: string): string {
  const full = `${name} npm downloads: weekly stats and real installs`;
  return full.length <= MAX_TITLE ? titled(full) : `${name} npm downloads and real installs`;
}

// Below this many real installs a week a page stays reachable but out of search indexes: there is little to
// say about such a package and few people search for it. "high" confidence in estimate.ts needs the same 1,000.
const INDEXABLE_MIN_WEEKLY = 1000;
export const isIndexable = (r?: Pick<FeaturedRow, 'organicWeekly'>): boolean => (r?.organicWeekly ?? 0) >= INDEXABLE_MIN_WEEKLY;

// With build-time numbers (summary.json) the description quotes them; without, it stays generic.
export function packageDescription(name: string, r?: Pick<FeaturedRow, 'organicWeekly' | 'low' | 'high' | 'confidence' | 'npmWeekly'>): string {
  return clip(r
    ? `${name} npm downloads: ${fmt(r.npmWeekly)} a week on npm, about ${rangeText(r.low, r.high)} real installs after removing ` +
        `mirrors and crawlers (${r.confidence} confidence).`
    : `Check ${name} npm downloads and real installs: weekly stats, a 12-month chart and a per-version breakdown, with mirrors and crawlers removed.`);
}

export function compareTitle(names: string[]): string {
  return titled(`${names.join(' vs ')}: npm downloads and real installs compared`);
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
    const counts = (pick: (r: CompareRow) => number, format: (n: number) => string) => (rows as CompareRow[]).map((r) => format(pick(r))).join(' vs ');
    return clip(`${vs} npm downloads: ${counts((r) => r.npmWeekly, fmt)} a week on npm, ` +
      `about ${counts((r) => r.organicWeekly, roundCount)} real installs after removing mirrors and crawlers.`);
  }
  return clip(`${vs}: npm weekly downloads compared week by week, with mirror spikes and crawler traffic removed.`);
}
