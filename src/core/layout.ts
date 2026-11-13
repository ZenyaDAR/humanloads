// Site chrome (header, footer) and home page sections, shared by the SPA and the prerender script, so the static
// page and the live one have the same markup at first paint. DOM-free: interactive parts (search box, theme toggle)
// are passed in as HTML slots and swapped for live elements by the SPA.
import { GUIDES } from './guides.ts';
import { esc, rangeText, roundCount } from './html.ts';
import { listLinksHtml } from './lists.ts';
import { METHODOLOGY_PATH, METHODOLOGY_TITLE } from './methodology.ts';
import { REPO_LINK_HTML, comparePath, noiseBar } from './seo.ts';
import type { Monthly } from './insights.ts';
import type { FeaturedRow, RisingRow, Showcase } from './types.ts';

export type NavKey = 'rankings' | 'compare' | 'journal' | 'methodology' | null;

// Compare series, in order: blue, red pen, green. CSS custom properties, read by the chart at draw time.
export const COMPARE_COLORS = ['--blue', '--pen', '--green'];

const SEARCH_ICON = '<svg class="search-icon" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';

// The bordered box of a search form: icon, input, "/" hint in the header, button. `inputAttrs` carries the
// combobox attributes in the SPA; the static stand-in has none.
export function searchFormInner(id: string, placeholder: string, button: string, inputAttrs = ''): string {
  return `<div class="search-box">${id === 'cmp' ? '' : SEARCH_ICON}<input ${inputAttrs} type="text" placeholder="${esc(placeholder)}" />${
    id === 'top' ? '<kbd class="num" aria-hidden="true">/</kbd>' : ''
  }<button type="submit">${esc(button)}</button></div>`;
}

// Home anchors: the sections exist on the home page, so the nav needs no extra routes.
const nav = (base: string): [NavKey, string, string][] => [
  ['rankings', 'Rankings', `${base}#rankings`],
  ['compare', 'Compare', `${base}#compare`],
  ['journal', 'Journal', `${base}#journal`],
  ['methodology', 'Methodology', base + METHODOLOGY_PATH],
];

export const logoHtml = (base: string) => `<a class="logo" href="${esc(base)}">human<span class="logo-mark">loads</span></a>`;

// `search` is '' on pages that carry their own big search box (home, articles).
export function siteHeaderHtml(base: string, active: NavKey, search: string, tools: string): string {
  return `<header class="site-head"><div class="wrap site-head-in">
      ${logoHtml(base)}
      ${search ? `<div class="head-search">${search}</div>` : ''}
      <nav class="site-nav" aria-label="Main">${nav(base)
        // Only Methodology links to the page itself; the others point at a home section, so they mark the section.
        .map(([k, label, href]) => `<a href="${esc(href)}"${k === active ? ` aria-current="${k === 'methodology' ? 'page' : 'true'}"` : ''}>${label}</a>`)
        .join('')}</nav>
      ${tools}
    </div></header>`;
}

// Static stand-in for the theme toggle; the SPA replaces the whole tools block with live controls.
export const STATIC_TOOLS = `<div class="head-tools">${REPO_LINK_HTML}<span class="theme-toggle" inert aria-hidden="true">${themeIcon()}System</span></div>`;

export function themeIcon(): string {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/></svg>';
}

export function siteFooterHtml(base: string): string {
  return `<footer class="site-foot"><div class="wrap site-foot-in">
      <div class="foot-about">
        <p class="foot-logo">human<span>loads</span></p>
        <p>Data from the npm registry, refreshed nightly. Real installs are an estimate with a range. CI and dependency installs still count, so this is not a head count.</p>
      </div>
      <nav class="foot-nav" aria-label="Footer">${nav(base)
        .map(([, label, href]) => `<a href="${esc(href)}">${label}</a>`)
        .join('')}<a href="https://github.com/ZenyaDAR/humanloads" rel="noopener">GitHub</a></nav>
    </div></footer>`;
}

// ---------- home ----------

export const HOME_NOISY_SIZE = 6;

export const HOME_LEDE =
  "npm counts every tarball fetch, mirrors and crawlers included. Search any package to see what's left without them, as a range, next to its versions and a year of history. CI and dependency installs still count.";

const CHECK = '<svg class="tick" aria-hidden="true" viewBox="0 0 26 22" width="26" height="22"><path d="M2 12 C 5 14, 8 17, 10 20 C 13 13, 18 6, 24 2"/></svg>';
export const checkMark = (cls = '') => CHECK.replace('class="tick"', `class="tick${cls ? ` ${cls}` : ''}"`);

export function examplesHtml(base: string, names: string[]): string {
  return names.map((n) => `<a class="quiet-link num" href="${esc(base + n)}">${esc(n)}</a>`).join('');
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

// Seeded, so the hand wobble is the same in the static page and the live one.
function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

// A line on a 1000x300 plot (stretched to its box), square-root scale like the package chart, with a small wobble.
function plotPath(vals: number[], max: number, r: () => number, wobble: number): string {
  const top = 10;
  return vals
    .map((v, i) => {
      const x = (i * 1000) / Math.max(1, vals.length - 1);
      const y = top + (300 - top) * (1 - Math.sqrt(Math.max(0, v) / max));
      return `${i ? 'L' : 'M'}${(x + (r() - 0.5) * wobble).toFixed(1)} ${(y + (r() - 0.5) * wobble).toFixed(1)}`;
    })
    .join(' ');
}

// Per day, so 28- and 31-day months compare fairly. Real installs are the middle of the range.
function pinnedChartHtml(m: Monthly | null | undefined): string {
  const idx = (m?.months ?? []).map((_, i) => i).filter((i) => m!.days[i] > 0).slice(-12);
  if (!m || idx.length < 2) return '';
  const npm = idx.map((i) => m.npm[i] / m.days[i]);
  const real = idx.map((i) => (m.low[i] + m.high[i]) / 2 / m.days[i]);
  const max = Math.max(1, ...npm, ...real);
  const r = rng(7);
  return `<span class="pin-chart" aria-hidden="true"><svg viewBox="0 0 1000 300" preserveAspectRatio="none">
        <path class="pc-npm" d="${plotPath(npm, max, r, 4)}"/>
        <path class="pc-real" d="${plotPath(real, max, r, 5)}"/>
        <path class="pc-real2" d="${plotPath(real, max, r, 7)}"/>
      </svg></span>`;
}

// The one pinned, tilted object on the home page: a package's homework, corrected.
export function pinnedCardHtml(base: string, r: FeaturedRow): string {
  const chart = pinnedChartHtml(r.facts?.monthly);
  // No aria-label: the name comes from the visible text plus the sr-only numbers, so it contains what is on screen.
  return `<a class="pinned" href="${esc(base + r.name)}">
      <span class="tape" aria-hidden="true"></span>
      <span class="pin-head"><span class="num pin-name">${esc(r.name)}</span><span class="pin-per">downloads per week</span><span class="sr-only">: npm says ${esc(roundCount(r.npmWeekly))}, about ${esc(rangeText(r.low, r.high))} are real installs</span></span>
      <span class="pin-cols" aria-hidden="true">
        <span><span class="corr-label">npm says</span><span class="num pin-npm struck">${esc(roundCount(r.npmWeekly))}</span></span>
        <span><span class="corr-label corr-label-real">real installs</span><span class="num pin-real"><mark>≈ ${esc(roundCount(r.organicWeekly))}</mark></span></span>
      </span>
      <span class="pin-note hand" aria-hidden="true">${pct(r.inflation)} of it was mirrors &amp; crawlers. Range ${esc(rangeText(r.low, r.high))}.</span>
      ${chart || noiseBar(r.inflation)}
      <span class="pin-foot" aria-hidden="true"><span class="key key-npm"></span>npm downloads <span class="key key-human"></span>real installs
        <span class="pill pill-${esc(r.confidence)}">${esc(r.confidence)} confidence</span></span>
    </a>`;
}

// The card shows the best-known of the noisy rows (the biggest by npm's count), one with a year to draw if any has it.
export function pinnedRow(rows: FeaturedRow[]): FeaturedRow {
  const drawable = rows.filter((r) => (r.facts?.monthly?.months.length ?? 0) >= 2);
  return (drawable.length ? drawable : rows).reduce((a, b) => (b.npmWeekly > a.npmWeekly ? b : a));
}

// Same box as the real card, so nothing moves when the data arrives (CLS).
export const PINNED_SKELETON = '<div class="pinned pinned-sk sk" aria-hidden="true"></div>';

export function heroHtml(base: string, search: string, examples: string, pinned: string): string {
  return `<section class="hero wrap">
      <div class="hero-copy">
        <p class="hero-kicker hand">npm's homework, corrected in red pen ${checkMark()}</p>
        <h1 class="hero-title" tabindex="-1">How many npm downloads are <mark>real installs</mark>?</h1>
        <p class="hero-lede">${HOME_LEDE}</p>
        <div class="home-search">${search}</div>
        <p class="home-examples"${examples ? '' : ' hidden'}><span class="hand">try one →</span>${examples}</p>
      </div>
      <div class="hero-pin">${pinned}</div>
    </section>`;
}

const STEPS: [string, string][] = [
  ['Cut the publish spikes', 'Every release is copied by registry mirrors and scanners in its first few days. Those spikes come out first.'],
  ['Subtract the crawler floor', 'Crawlers fetch every version a few times a week. Old versions show that flat floor; it comes off all of them.'],
  ['Give a range, not a fact', 'What is left is shown as a range. The confidence level says how far to trust the filter for that package, backed by dependents and CDN hits. It still includes CI and dependency installs.'],
];

export function howHtml(base: string): string {
  return `<section class="how" id="how" aria-labelledby="how-title"><div class="wrap how-in">
      <h2 class="sr-only" id="how-title">How it works</h2>
      ${STEPS.map(([t, p], i) => `<div class="how-step"><span class="how-n hand" aria-hidden="true">${i + 1}.</span><div><h3>${t}</h3><p>${p}</p></div></div>`).join('')}
      <p class="how-more"><a href="${esc(base + METHODOLOGY_PATH)}">Read the methodology <span aria-hidden="true">→</span></a></p>
    </div></section>`;
}

// One row of the "most noise" index card. The link keeps the class the tests and the CSS key on.
export function noisyRowHtml(base: string, r: FeaturedRow, i: number): string {
  return `<li><a class="fcard" href="${esc(base + r.name)}">
      <span class="num ic-rank">${i + 1}</span>
      <span class="ic-main"><span class="num ic-name">${esc(r.name)}</span><span class="num ic-sub"><s class="struck"><span class="sr-only">npm says </span>${esc(roundCount(r.npmWeekly))}</s> → <span class="ic-real">≈ ${esc(rangeText(r.low, r.high))}</span><span class="sr-only"> real installs</span></span></span>
      ${noiseBar(r.inflation, ' noise-bar-mini')}
      <span class="num ic-val ic-noise">${pct(r.inflation)}<span class="sr-only"> noise</span></span>
    </a></li>`;
}

// A 120x30 sparkline, scaled to its own range: the shape of the trend, not its size.
function sparkPath(vals: number[]): string {
  const lo = Math.min(...vals);
  const span = Math.max(...vals) - lo || 1;
  return vals.map((v, i) => `${i ? 'L' : 'M'}${((i * 120) / Math.max(1, vals.length - 1)).toFixed(1)} ${(28 - ((v - lo) / span) * 26).toFixed(1)}`).join(' ');
}

// One row of the "rising" index card: same grid as the noisy rows, a sparkline instead of the noise bar.
export function risingRowHtml(base: string, r: RisingRow, i: number): string {
  const g = Math.round(r.growth3m * 100);
  return `<li><a class="fcard fcard-rise" href="${esc(base + r.name)}">
      <span class="num ic-rank">${i + 1}</span>
      <span class="ic-main"><span class="num ic-name">${esc(r.name)}</span>${r.category ? `<span class="ic-cat">${esc(r.category)}</span>` : ''}</span>
      ${r.spark.length > 1 ? `<svg class="spark" viewBox="0 0 120 30" width="120" height="30" aria-hidden="true"><path d="${sparkPath(r.spark)}"/></svg>` : '<span></span>'}
      <span class="num ic-val ic-rise">${g >= 0 ? '+' : ''}${g}%<span class="sr-only"> spike-free downloads over three months</span></span>
    </a></li>`;
}

const SK_ROW = '<li><span class="fcard sk-row"><span class="sk sk-bar"></span></span></li>';

// `rows` null = still loading (SPA): both ranked cards show skeleton rows. `recent`: the noisy rows include packages
// released in the last two weeks (see selectFeatured), and the card says so.
export function notebookHtml(base: string, rows: FeaturedRow[] | null, updated: string, rising: RisingRow[] = [], recent = false): string {
  const loading = rows === null;
  if (!loading && !rows.length && !rising.length) return '';
  return `<section class="wrap sec" id="rankings">
      <div class="sec-head">
        <div><p class="kicker hand">this week in the notebook</p><h2 class="sec-title">Where npm's count and real installs split</h2></div>
        ${updated ? `<p class="num sec-meta">Updated ${esc(updated)} · last 7 days</p>` : ''}
      </div>
      <div class="notebook"${loading ? ' aria-busy="true"' : ''}>
        ${loading || rows.length ? `<div class="icard">
          <div class="icard-head"><h3>Most noise</h3><span>${recent ? 'a month old or more, recent releases included' : 'no release in the last two weeks'}</span></div>
          <ol class="icard-list">${loading ? SK_ROW.repeat(6) : rows.map((r, i) => noisyRowHtml(base, r, i)).join('')}</ol>
          <p class="icard-foot">Noise means ordinary mirrors and crawlers, not foul play.</p>
        </div>` : ''}
        ${loading || rising.length ? `<div class="icard icard-b">
          <div class="icard-head"><h3>Growing fastest</h3><span>spike-free downloads, last 3 months</span></div>
          <ol class="icard-list">${loading ? SK_ROW.repeat(6) : rising.map((r, i) => risingRowHtml(base, r, i)).join('')}</ol>
          <p class="icard-foot">Publish spikes are taken out, so a burst of mirror traffic can't fake a trend. The crawler floor, CI and dependency installs are still in.</p>
        </div>` : ''}
      </div>
    </section>`;
}

// The ranked lists as a notebook index: category, dot leader, its #1 by real installs.
export function categoriesHtml(base: string, tops: Record<string, string> | null | undefined): string {
  return `<section class="wrap sec" id="categories">
      <h2 class="sec-title">Best npm packages by category</h2>
      ${listLinksHtml(base, tops)}
    </section>`;
}

// The biggest packages as plain links, so crawlers reach their pages from the home page in one step. Empty without data.
export function popularHtml(base: string, names: string[]): string {
  if (!names.length) return '';
  return `<section class="wrap cmp-links-sec" id="popular">
      <h2 class="section-title">Most downloaded npm packages</h2>
      <ul class="cmp-links">${names.map((n) => `<li><a class="tag" href="${esc(base + n)}">${esc(n)}</a></li>`).join('')}</ul>
    </section>`;
}

// The main event of a comparison, only when the data shows one: a line that starts below another and ends above it.
function overtakeNote(s: Showcase): string {
  for (let a = 0; a < s.names.length; a++) {
    for (let b = 0; b < s.names.length; b++) {
      if (a !== b && s.real[a][0] < s.real[b][0] && s.real[a].at(-1)! > s.real[b].at(-1)!) return `${s.names[a]} overtakes ${s.names[b]} ↗`;
    }
  }
  return '';
}

// One comparison drawn as a chart, linking to its compare page. Empty without data.
export function showcaseHtml(base: string, s: Showcase | null | undefined): string {
  if (!s || s.names.length < 2 || s.months.length < 2 || s.real.length !== s.names.length) return '';
  const max = Math.max(1, ...s.real.flat()) * 1.05;
  const r = rng(23);
  const note = overtakeNote(s);
  return `<a class="showcase" href="${esc(base + comparePath(s.names))}">
        <span class="sc-head"><span class="num sc-title">${s.names.map(esc).join(' <span class="sc-vs">vs</span> ')}</span><span class="sc-meta">real installs, ${s.months.length} months</span></span>
        <span class="sc-plot">${note ? `<span class="sc-note hand">${esc(note)}</span>` : ''}<svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">${s.real
          .map((v, i) => `<path class="sc-line${i ? '' : ' sc-lead'}" style="stroke:var(${COMPARE_COLORS[i]})" d="${plotPath(v, max, r, 5)}"/>`)
          .join('')}</svg></span>
        <span class="sc-legend">${s.names
          .map((n, i) => `<span><span class="sc-key" style="background:var(${COMPARE_COLORS[i]})"></span><span class="num sc-name">${esc(n)}</span> ≈ ${esc(roundCount((s.real[i].at(-1) ?? 0) * 7))}/wk</span>`)
          .join('')}</span>
      </a>`;
}

export function compareSectionHtml(base: string, pairs: string[][], showcase: Showcase | null = null): string {
  if (!pairs.length) return '';
  const card = showcaseHtml(base, showcase);
  const chips = `<ul class="chips">${pairs.map((p) => `<li><a class="tag" href="${esc(base + comparePath(p))}">${p.map(esc).join(' vs ')}</a></li>`).join('')}</ul>`;
  return `<section class="wrap sec" id="compare">
      <div class="compare-sec">
        <div class="compare-copy">
          <h2 class="sec-title">Compare libraries by real installs</h2>
          <p>npm's count rewards packages that publish often: every release brings a wave of mirror downloads. Comparing real installs takes that out. Installs as a dependency of other packages still count for both.</p>
          ${card ? chips : ''}
        </div>
        ${card || chips}
      </div>
    </section>`;
}

// Decorative sketch for the featured article: a publish spike, the crawler floor and the slow rise above it.
const JOURNAL_SKETCH = `<svg viewBox="0 0 400 240" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <path class="js-axis" d="M30 200 L 370 200"/>
    <path class="js-npm" d="M40 196 C 60 194, 70 60, 82 50 C 96 44, 100 170, 120 176 C 150 182, 180 180, 220 181 C 270 182, 320 180, 362 181"/>
    <path class="js-real" d="M40 199 C 120 198, 200 196, 260 190 C 300 186, 330 178, 362 170"/>
    <path class="js-floor" d="M150 158 L 360 158"/>
    <text class="js-pen" x="94" y="40">publish → mirrors</text>
    <text class="js-pen" x="200" y="150">crawler floor</text>
    <text class="js-blue" x="236" y="224">real installs</text>
  </svg>`;

const FEATURED_GUIDE = 'docs/are-npm-downloads-real';
const guideName = (title: string) => title.replace(/ · .*$/, '');

export function journalHtml(base: string): string {
  const feat = GUIDES.find((g) => g.path === FEATURED_GUIDE) ?? GUIDES[0];
  const rest = [
    ...GUIDES.filter((g) => g !== feat).map((g) => ({ meta: 'Guide', title: guideName(g.title), text: g.description, path: g.path })),
    { meta: 'Methodology', title: guideName(METHODOLOGY_TITLE), text: 'Every step of the filter, the evidence behind the confidence levels, and the known limits.', path: METHODOLOGY_PATH },
  ];
  return `<section class="wrap sec" id="journal">
      <div class="sec-head">
        <div><p class="kicker hand">the journal</p><h2 class="sec-title">Field notes on bots, mirrors and the numbers</h2></div>
      </div>
      <a class="jfeat" href="${esc(base + feat.path)}">
        <span class="jfeat-art">${JOURNAL_SKETCH}</span>
        <span class="jfeat-copy">
          <span class="num jmeta"><span class="new">Featured</span> Guide</span>
          <span class="jfeat-title">${esc(guideName(feat.title))}</span>
          <span class="jfeat-text">${esc(feat.description)}</span>
        </span>
      </a>
      <ul class="jcards">${rest
        .map((a) => `<li><a class="jcard" href="${esc(base + a.path)}"><span class="num jmeta">${a.meta}</span><span class="jcard-title">${esc(a.title)}</span><span class="jcard-text">${esc(a.text)}</span></a></li>`)
        .join('')}</ul>
    </section>`;
}
