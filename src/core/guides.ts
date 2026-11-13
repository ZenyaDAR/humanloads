// Short guides for the plain questions people type into a search box, shared by the SPA routes and the prerender script.
// Their paths contain a slash without "@scope", so they can't clash with a package name.
import { esc, rangeText, roundCount } from './html.ts';
import { CHAIN_GUIDE_PATH, chainListHtml } from './insights.ts';
import { METHODOLOGY_PATH, METHODOLOGY_TITLE, methodologyBody } from './methodology.ts';
import { noiseBar } from './seo.ts';
import type { FeaturedRow, InsightsFile } from './types.ts';

// The numbers a "Mentioned in this article" card shows: a nightly snapshot, never live.
export type MentionRow = Pick<FeaturedRow, 'name' | 'npmWeekly' | 'organicWeekly' | 'low' | 'high' | 'inflation' | 'tooNew'>;

export interface Guide<T = InsightsFile> {
  path: string;
  title: string;
  description: string;
  body: (base: string, data?: T | null, mentions?: MentionRow[]) => string;
  // For a guide built on nightly data: without enough of it the page is thin, so it stays out of search indexes.
  ready?: (data?: T | null) => boolean;
  dataFile?: string; // where that data lives, when it isn't data/insights.json
  mentions?: string[]; // packages the text names; the rail shows their numbers when the build has them
  items?: (data?: T | null) => string[]; // for a ranking: the package names in order, for the ItemList in JSON-LD
}

// Rows for the names a guide mentions, in its order. Packages too new to tell are left out: their "real" number is a guess.
export function pickMentions(names: string[] | undefined, rows: Record<string, FeaturedRow | MentionRow | undefined> | null | undefined): MentionRow[] {
  return (names ?? []).flatMap((n) => {
    const r = rows?.[n];
    return r && !r.tooNew && r.npmWeekly > 0
      ? [{ name: r.name, npmWeekly: r.npmWeekly, organicWeekly: r.organicWeekly, low: r.low, high: r.high, inflation: r.inflation }]
      : [];
  });
}

export const DEPRECATED_GUIDE_PATH = 'docs/deprecated-npm-packages';
const DEPRECATED_MIN_ROWS = 10;
const CHAIN_EXAMPLE = 'is-number';
const dateOf = (day?: string) => (day ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
const fullDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

function deprecatedTable(ins: InsightsFile, base: string): string {
  return `<div class="table-wrap"><table class="cmp-table dep-table">
      <thead><tr><th scope="col">package</th><th scope="col" class="num">npm downloads / week</th><th scope="col">last release</th><th scope="col">the maintainers' message</th></tr></thead>
      <tbody>${ins.deprecated
        .map(
          (r) => `<tr><th scope="row"><a href="${esc(base + r.name)}">${esc(r.name)}</a></th>
          <td class="num" data-label="npm downloads / week">${roundCount(r.npmWeekly)}</td>
          <td data-label="last release">${esc(dateOf(r.lastRelease))}</td>
          <td class="dep-msg" data-label="the maintainers' message">${esc(r.message)}</td></tr>`,
        )
        .join('')}</tbody>
    </table></div>`;
}

export const HOME_FAQ: [string, string][] = [
  [
    'How do I check how many downloads an npm package has?',
    'Type its name in the search box above. You get npm\'s weekly count, a 12-month chart and a per-version breakdown, next to an estimate of real installs. No signup.',
  ],
  [
    'How many people use my npm package?',
    'Public data can\'t tell you: npm does not record who downloaded a package. humanloads removes mirror spikes and the crawler floor and shows the rest as a range of real installs, which still includes CI and installs as a dependency. The packages and repositories that depend on yours are another signal.',
  ],
  [
    'Why did my new npm package get 100 downloads on the first day?',
    'Mostly automation. Registry mirrors and security scanners fetch every new version as soon as it is published, whether or not anybody uses it. Tenable measured about 100–150 such downloads per version.',
  ],
  [
    'What do weekly downloads on npm mean?',
    'The number of times the package tarball was served in the last 7 days. Every successful fetch counts, including mirrors, crawlers and CI, so it is not a number of users.',
  ],
  [
    'Can I add a real installs badge to my README?',
    'Yes, for any npm package. Open the package\'s page here, find "Badge for your README" and press "Copy markdown". The URL format is also in llms.txt.',
  ],
];

// ---------- the journal article template ----------

export interface ArticleOpts {
  kicker?: string; // breadcrumb text, default "journal / guide"
  kickerHref?: string; // home page anchor it links to, default "#journal"
  path?: string; // this page, left out of "Keep reading"
  tldr?: string[]; // HTML bullets, only claims the article itself makes
  updated?: string; // ISO date of the data the page is built on; never shown when unknown
  mentions?: MentionRow[];
  cols?: boolean; // TOC, body and rail (default); false keeps one wide column for ranking tables
}

const WORDS_PER_MINUTE = 220;
// Prose only: tables and figures are scanned, not read word by word.
const readingMinutes = (html: string) => {
  const words = html
    .replace(/<(table|svg|figure)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
};

// "Keep reading" needs the other articles' reading times. Rendering one to measure it must not render its rail in
// turn, so while `measuring` is set article() returns only its text.
let measuring = false;
const minutesCache = new Map<string, number>();
function minutesOf(path: string, render: () => string): number {
  let m = minutesCache.get(path);
  if (m === undefined) {
    const outer = measuring;
    measuring = true;
    try {
      m = readingMinutes(render());
    } finally {
      measuring = outer;
    }
    minutesCache.set(path, m);
  }
  return m;
}

const plain = (html: string) => html.replace(/<[^>]+>/g, '').trim();
const slug = (text: string) => plain(text).toLowerCase().replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Gives every section h2 an id (keeping one it already has) and returns the TOC entries.
function withHeadingIds(html: string): { html: string; toc: [string, string][] } {
  const toc: [string, string][] = [];
  const seen = new Set<string>();
  const out = html.replace(/<h2 class="section-title"(?: id="([^"]+)")?>([\s\S]*?)<\/h2>/g, (_, id: string | undefined, text: string) => {
    let key = id ?? (slug(text) || 'section');
    while (seen.has(key)) key += '-2';
    seen.add(key);
    toc.push([key, text]);
    return `<h2 class="section-title" id="${key}">${text}</h2>`;
  });
  return { html: out, toc };
}

// Items are trusted markup written in code (<strong>, <code>), so they go in unescaped: never pass npm data here.
const tldrHtml = (items: string[]) =>
  `<aside class="tldr" aria-label="Short version"><span class="tldr-label hand" aria-hidden="true">tl;dr</span><ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul></aside>`;

// The article's own search box. The slot stays empty here (layout.ts imports GUIDES from this file, so importing it
// back would add an import cycle): the prerender puts an inert stand-in in it (scripts/data-lib.ts), the SPA a live box
// (src/web/main.ts).
export const ARTICLE_SEARCH_SLOT = '<div class="art-search"></div>';
const ctaHtml = (base: string, path?: string) => `<section class="art-cta">
    <h2 class="section-title">Check your own package</h2>
    ${ARTICLE_SEARCH_SLOT}
    ${path === METHODOLOGY_PATH ? '' : `<p>The full filter, with its known limits, is in the <a href="${esc(base + METHODOLOGY_PATH)}">methodology</a>.</p>`}
  </section>`;

// Rail variant of the correction block: npm's count struck through, the real installs highlighted, the noise bar.
const mentionCard = (base: string, r: MentionRow) => `<a class="rail-card" href="${esc(base + r.name)}">
      <span class="num rc-name">${esc(r.name)}</span>
      <span class="rc-nums"><span class="num rc-npm struck"><span class="sr-only">npm says </span>${esc(roundCount(r.npmWeekly))}</span>
        <span class="num rc-real"><mark>≈ ${esc(rangeText(r.low, r.high))}</mark><span class="sr-only"> real installs</span></span><span class="rc-per">/ week</span></span>
      ${noiseBar(r.inflation, ' noise-bar-rail')}
    </a>`;

const guideName = (title: string) => title.replace(/ · .*$/, '');

function railHtml(base: string, opts: ArticleOpts): string {
  const others = [
    ...GUIDES.filter((g) => g.path !== opts.path).map((g) => ({ path: g.path, title: guideName(g.title), meta: 'Guide', min: minutesOf(g.path, () => g.body('/')) })),
    ...(opts.path === METHODOLOGY_PATH ? [] : [{ path: METHODOLOGY_PATH, title: guideName(METHODOLOGY_TITLE), meta: 'Methodology', min: minutesOf(METHODOLOGY_PATH, () => methodologyBody('/')) }]),
  ];
  const mentions = opts.mentions ?? [];
  return `<aside class="doc-rail" aria-label="Related">
    ${mentions.length ? `<div class="rail-block"><p class="toc-title">Mentioned in this article</p>${mentions.map((r) => mentionCard(base, r)).join('')}
      <p class="rail-note">Weekly numbers from the nightly build.</p></div>` : ''}
    <div class="rail-block"><p class="toc-title">Keep reading</p><ul class="rail-list">${others
      .map((a) => `<li><a href="${esc(base + a.path)}">${esc(a.title)}</a><span class="num rail-meta">${esc(a.meta)} · ${a.min} min</span></li>`)
      .join('')}</ul></div>
  </aside>`;
}

// Journal article: breadcrumb kicker, title, serif lede, meta line, then TOC · body · rail.
export function article(h1: string, lede: string, sections: string, base: string, opts: ArticleOpts = {}): string {
  if (measuring) return `${lede} ${sections}`;
  const cols = opts.cols ?? true;
  const { html: body, toc } = withHeadingIds(`${opts.tldr?.length ? tldrHtml(opts.tldr) : ''}
  ${sections}
  ${ctaHtml(base, opts.path)}`);
  const meta = `humanloads${opts.updated ? ` · updated ${esc(fullDate(opts.updated))}` : ''} · ${readingMinutes(`${lede} ${sections}`)} min read`;
  const head = `<header class="pkg-head doc-head">
    <p class="kicker hand"><a href="${esc(base + (opts.kickerHref ?? '#journal'))}">${esc(opts.kicker ?? 'journal / guide')}</a></p>
    <h1 tabindex="-1">${h1}</h1>
    <p class="doc-lede">${lede}</p>
    <p class="num doc-meta">${meta}</p>
  </header>`;
  if (!cols) return `<article class="pkg doc">
  ${head}
  <div class="doc-body">
  ${body}
  </div>
</article>`;
  return `<article class="pkg doc">
  ${head}
  <div class="doc-cols">
  <nav class="doc-toc" aria-label="In this article"><p class="toc-title">In this article</p><ol>${toc.map(([id, t]) => `<li><a href="#${id}">${plain(t)}</a></li>`).join('')}</ol></nav>
  <div class="doc-body">
  ${body}
  </div>
  ${railHtml(base, opts)}
  </div>
</article>`;
}

// ---------- explanatory figure: the first three weeks of a new package ----------

// Fixed illustration data, so the figure is identical on every render: crawler noise around a floor of 9 a day,
// real installs from day 7 on, and the extra mirror and scanner fetches after the two releases.
const FIG_FLOOR = 9;
const FIG_MAX = 70;
const FIG_NOISE = [9.4, 8.7, 9.6, 8.8, 9.3, 9.1, 8.6, 9.5, 8.9, 9.2, 9.0, 8.8, 9.4, 9.1, 8.7, 9.3, 9.0, 8.9, 9.5, 8.8, 9.2];
const FIG_REAL = [0, 0, 0, 0, 0, 0, 1.0, 2.4, 3.1, 4.6, 5.2, 6.4, 7.3, 8.9, 9.6, 11.2, 11.9, 13.4, 14.1, 15.8, 16.6];
const FIG_SPIKE: Record<number, number> = { 0: 53, 1: 21, 2: 5, 10: 29, 11: 9 };
const figY = (v: number) => (300 - (300 * v) / FIG_MAX).toFixed(1);
const figPath = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${i * (1000 / (vals.length - 1))} ${figY(v)}`).join(' ');
const FIG_NPM = FIG_NOISE.map((v, i) => v + FIG_REAL[i] + (FIG_SPIKE[i] ?? 0));

const NEW_PACKAGE_FIGURE = `<figure class="art-fig">
    <div class="art-fig-plot" role="img" aria-label="Daily npm downloads of a new package over its first 21 days: a spike to about 60 on publish day, a smaller spike after the next release, a crawler floor near 9 a day, and real installs rising slowly above it.">
      <svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
        <path class="fig-band" d="M0 ${figY(FIG_FLOOR)} L1000 ${figY(FIG_FLOOR)} L1000 300 L0 300 Z"/>
        <path class="fig-floor" d="M0 ${figY(FIG_FLOOR)} L1000 ${figY(FIG_FLOOR)}"/>
        <path class="fig-npm" d="${figPath(FIG_NPM)}"/>
        <path class="fig-real" d="${figPath(FIG_REAL)}"/>
      </svg>
      <span class="fig-note fig-n-pub hand" aria-hidden="true">day 1: mirrors &amp;<br>scanners copy it</span>
      <span class="fig-note fig-n-rel hand" aria-hidden="true">next release → again</span>
      <span class="fig-note fig-n-floor hand" aria-hidden="true">crawler floor ≈ 9 a day</span>
      <span class="fig-note fig-n-real hand" aria-hidden="true">real installs ↘</span>
    </div>
    <figcaption>
      <span class="fig-key"><span class="fig-sw fig-sw-npm"></span>npm downloads per day</span>
      <span class="fig-key"><span class="fig-sw fig-sw-floor"></span>crawler floor</span>
      <span class="fig-key"><span class="fig-sw fig-sw-real"></span>real installs (above the floor)</span>
      <span class="fig-cap">Illustration of the typical shape, not a specific package.</span>
    </figcaption>
  </figure>`;

// ---------- the guides ----------

export const GUIDES: Guide[] = [
  {
    path: 'docs/npm-download-count',
    title: 'How to check the download count of an npm package · humanloads',
    description: 'Where to see npm download stats for any package: npmjs.com, the npm downloads API, weekly history and per-version counts, and what a download counts.',
    mentions: ['zod', 'jest', 'vitest'],
    body: (base, _data, mentions) =>
      article(
        'How to check the download count of an npm package',
        'The quickest way: <a href="' + base + '">search for the package here</a>. You get its weekly downloads, a 12-month chart and an estimate of real installs, without signing up.',
        `<section>
    <h2 class="section-title">On npmjs.com</h2>
    <p>Every package page shows <strong>Weekly Downloads</strong> with a small chart. It is a total for the last 7 days, with no breakdown of where the downloads came from. The Versions tab lists downloads per version for the same 7 days.</p>
  </section>
  <section>
    <h2 class="section-title">With the npm API</h2>
    <p>npm's downloads API is public and needs no key. Replace <code>zod</code> with your package.</p>
    <ul>
      <li>Last week's total: <code>https://api.npmjs.org/downloads/point/last-week/zod</code></li>
      <li>Downloads per day: <code>https://api.npmjs.org/downloads/range/last-year/zod</code></li>
      <li>Last week per version: <code>https://api.npmjs.org/versions/zod/last-week</code></li>
    </ul>
    <p>For a scoped package write the slash as <code>%2F</code> in the per-version URL: <code>@scope%2Fname</code>. npm publishes counts 1–2 days late.</p>
  </section>
  <section>
    <h2 class="section-title">Download history and comparisons</h2>
    <p>A package page here shows 12 months week by week, with the biggest releases marked. To compare packages, open a page such as
      <a href="${base}compare/react,vue">react vs vue</a> or <a href="${base}compare/jest,vitest">jest vs vitest</a>.</p>
  </section>
  <section>
    <h2 class="section-title">What the number means</h2>
    <p>A download is one served tarball, not one person. Mirrors, security scanners, crawlers and CI all count, so a small package can show hundreds of downloads with almost no users. For a big package, most of the count is CI runs and installs as a dependency of other packages.
      <a href="${base}docs/are-npm-downloads-real">Are npm downloads real?</a> explains how much of the count that can be.</p>
  </section>`,
        base,
        {
          path: 'docs/npm-download-count',
          mentions,
          tldr: [
            'npmjs.com shows <strong>Weekly Downloads</strong>: a total for the last 7 days, with no breakdown of where they came from.',
            'npm\'s downloads API is public and needs no key. It gives weekly totals, daily counts and per-version counts, 1–2 days late.',
            'A download is one served tarball, not one person: mirrors, scanners, crawlers and CI all count.',
          ],
        },
      ),
  },
  {
    path: 'docs/are-npm-downloads-real',
    title: 'Are npm downloads real? Why new packages get 100 downloads', // with " · humanloads" it would pass 70 characters
    description: 'npm counts every tarball fetch. Why a new package gets about 100 downloads on day one, what crawlers add each week, and what is left after filtering.',
    body: (base, _data, mentions) =>
      article(
        'Are npm downloads <span class="wavy">real</span>?',
        'Each download is a real tarball fetch, but not a user. npm itself says its counts <a href="https://blog.npmjs.org/post/92574016600/numeric-precision-matters-how-npm-download-counts-work.html">are not the same as the number of users</a> and that it does not filter out robots.',
        `<section>
    <h2 class="section-title">Why did my new package get 100 downloads?</h2>
    <p>Because you published it. Registry mirrors and security scanners fetch every new version right away.
      <a href="https://tenable.com/blog/how-cyberattackers-inflate-malicious-package-npm-download-counts">Tenable measured</a> about 100–150 automated downloads for each version published. That says nothing about users.</p>
    ${NEW_PACKAGE_FIGURE}
  </section>
  <section>
    <h2 class="section-title">Why does an old package still get downloads every week?</h2>
    <p>Crawlers fetch every published version, used or not, the same few times each week. That flat background is the crawler floor. A package with many versions can collect a steady count from it even if nobody installs it.</p>
  </section>
  <blockquote class="pull-quote hand" aria-hidden="true">“A script that requests the tarball URL directly counts the same as a real install.”</blockquote>
  <section>
    <h2 class="section-title">Can download counts be faked?</h2>
    <p>Yes. A script that requests the tarball URL directly counts the same as a real install: Tenable pushed a test package to 17,000 downloads in about an hour. A high count alone is not proof that a package is trusted, so check its dependents and repository too.</p>
  </section>
  <section>
    <h2 class="section-title">How many people use my npm package?</h2>
    <p>Nobody can say exactly, because npm does not record who downloaded what. You can get closer: remove the mirror spikes and the crawler floor, then look at what is left and at who depends on the package.
      What is left is shown as a range of real installs. It still includes CI and installs as a dependency of other packages, so it is not a count of people.
      Search for your package <a href="${base}">here</a> to see it, or read <a href="${base}${METHODOLOGY_PATH}">how the estimate works</a>.</p>
  </section>`,
        base,
        {
          path: 'docs/are-npm-downloads-real',
          mentions,
          tldr: [
            'npm counts every tarball fetch and does not filter out robots, so downloads are real fetches, not real users.',
            'Mirrors and scanners fetch each new version right away: Tenable measured about 100–150 automated downloads per version.',
            'Crawlers fetch old versions every week and a script can inflate the count, so check dependents and the repository too.',
          ],
        },
      ),
  },
  {
    path: DEPRECATED_GUIDE_PATH,
    title: 'Deprecated npm packages list: the most downloaded ones · humanloads',
    description: 'The most downloaded deprecated npm packages, with each maintainer\'s own message, and how to find them in your project. Rebuilt from nightly data.',
    ready: (ins) => (ins?.deprecated.length ?? 0) >= DEPRECATED_MIN_ROWS,
    mentions: ['inflight'],
    body: (base, ins, mentions) => {
      const rows = ins?.deprecated ?? [];
      const total = rows.reduce((s, r) => s + r.npmWeekly, 0);
      return article(
        'The most downloaded deprecated npm packages',
        rows.length
          ? `Their own maintainers have retired them, yet npm serves these ${rows.length} packages about <strong>${roundCount(total)}</strong> times a week.`
          : 'Their own maintainers have retired them, yet npm keeps serving them. The list is built by the daily data run and is empty in this copy of the site.',
        `${rows.length && ins ? `<section>${deprecatedTable(ins, base)}<p class="fineprint">From the packages we track, which grow nightly from npm's most downloaded. The top of the list is checked every night, the rest within a few weeks. Only packages whose latest version is deprecated count, and <code>@types</code> stubs are left out. The messages are the maintainers' words, shortened to 200 characters.</p></section>` : ''}
  <section>
    <h2 class="section-title">Why are they still downloaded?</h2>
    <p>Usually because other packages still require them. A deprecated package keeps working, and it stays in every lockfile and dependency tree that names it, so most of these downloads probably don't come from anyone choosing it today. Deprecated doesn't always mean dangerous either: the message may point to a renamed package or a replacement, so read it before you plan a migration.</p>
  </section>
  <section>
    <h2 class="section-title">How do I check for deprecated packages in my project?</h2>
    <ul>
      <li><code>npm install</code> prints <code>npm warn deprecated</code> for each one it installs.</li>
      <li><code>npm view inflight deprecated</code> shows the message for one package, and prints nothing if it isn't deprecated.</li>
      <li><code>npm explain inflight</code> shows which of your dependencies brought it in.</li>
    </ul>
    <p><code>npm outdated</code> won't help: it only compares versions.</p>
  </section>`,
        base,
        {
          path: DEPRECATED_GUIDE_PATH,
          mentions,
          updated: rows.length ? ins?.generated : undefined,
          tldr: [
            'Their own maintainers have retired these packages, yet npm keeps serving them every week.',
            'Most of those downloads probably come from other packages that still require them, not from anyone choosing them today.',
            '<code>npm install</code> warns about each one, and <code>npm explain</code> shows which dependency brought it in.',
          ],
        },
      );
    },
  },
  {
    path: CHAIN_GUIDE_PATH,
    title: 'Why does is-number have so many npm downloads? · humanloads',
    description: 'A package that checks whether a value is a number gets hundreds of millions of npm downloads a week. Follow the dependency trail that explains it.',
    ready: (ins) => (ins?.chains[CHAIN_EXAMPLE]?.length ?? 0) >= 2,
    mentions: ['is-number', 'to-regex-range', 'fill-range', 'braces'],
    body: (base, ins, mentions) => {
      const chain = ins?.chains[CHAIN_EXAMPLE];
      const count = ins ? Object.keys(ins.chains).length : 0;
      return article(
        'Why does is-number have so many npm downloads?',
        chain
          ? `is-number got about <strong>${roundCount(chain[0].weekly)}</strong> downloads last week. Probably very few of them came from someone choosing it.`
          : 'Probably very few of its downloads come from someone choosing it.',
        `<section>
    <h2 class="section-title">Follow the dependency trail</h2>
    <p>${chain ? 'Each package below requires the one above it, and their weekly downloads on the matching versions line up within about 30%:' : 'is-number is required by to-regex-range, which is required by fill-range, which is required by braces. Their weekly downloads line up closely.'}</p>
    ${chain ? chainListHtml(chain, base) : ''}
    <p>Installing any package at the end of that trail fetches every package before it. So a widely used build tool adds a download to each small helper underneath it on every install that isn't served from a cache, including CI runs.</p>
  </section>
  <section>
    <h2 class="section-title">Are those real installs?</h2>
    <p>In the sense this site uses, mostly yes: the tarball is fetched as part of an install, so removing mirror spikes and the crawler floor barely changes a number this size. What the count doesn't tell you is that anyone decided to use the package. For a package like this, it mostly measures how popular its dependents are.</p>
  </section>
  <section>
    <h2 class="section-title">How do I see why a package is in my project?</h2>
    <p>Run <code>npm explain is-number</code>. It prints the chain of dependencies that brought the package in.</p>
  </section>
  <section>
    <h2 class="section-title">How do you know?</h2>
    <p>You can't know exactly, because npm doesn't record who requested a download. We compare weekly per-version counts: when one package requires another, and the versions in question get nearly the same downloads, that package probably explains them. Where several big packages share a dependency, the shares overlap and can't be told apart, so we stop there.${count ? ` Package pages show a trail like this for the ${count} packages where we could follow one.` : ''}</p>
  </section>`,
        base,
        {
          path: CHAIN_GUIDE_PATH,
          mentions,
          updated: chain ? ins?.generated : undefined,
          tldr: [
            'Probably very few of is-number\'s downloads come from someone choosing it.',
            'Installing any package at the end of its dependency trail fetches every package before it, including on CI runs.',
            'Filtering out mirror spikes and crawlers barely changes a number this size: it mostly measures how popular its dependents are.',
          ],
        },
      );
    },
  },
];
