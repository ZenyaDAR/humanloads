// Short guides for the plain questions people type into a search box, shared by the SPA routes and the prerender script.
// Their paths contain a slash without "@scope", so they can't clash with a package name.
import { esc, roundCount } from './html.ts';
import { CHAIN_GUIDE_PATH, chainListHtml } from './insights.ts';
import { METHODOLOGY_PATH } from './methodology.ts';
import type { InsightsFile } from './types.ts';

export interface Guide<T = InsightsFile> {
  path: string;
  title: string;
  description: string;
  body: (base: string, data?: T | null) => string;
  // For a guide built on nightly data: without enough of it the page is thin, so it stays out of search indexes.
  ready?: (data?: T | null) => boolean;
  dataFile?: string; // where that data lives, when it isn't data/insights.json
}

export const DEPRECATED_GUIDE_PATH = 'docs/deprecated-npm-packages';
const DEPRECATED_MIN_ROWS = 10;
const CHAIN_EXAMPLE = 'is-number';
const dateOf = (day?: string) => (day ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');

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
    'Nobody can count people exactly, npm included: npm does not record who downloaded what. humanloads removes mirror spikes and crawler traffic, then shows what looks like real installs, along with packages and repositories that depend on yours.',
  ],
  [
    'Why did my new npm package get 100 downloads on the first day?',
    'Mostly automation. Registry mirrors and security scanners fetch every new version as soon as it is published, usually 100–150 downloads per version, whether or not anybody uses it.',
  ],
  [
    'What do weekly downloads on npm mean?',
    'The number of times the package tarball was served in the last 7 days. It counts every fetch, including mirrors, crawlers and CI, so it is not a number of users.',
  ],
];

const check = (base: string) => `<p class="method"><a href="${base}">Check a package <span aria-hidden="true">→</span></a></p>`;
export const article = (h1: string, lede: string, sections: string, base: string) => `<article class="pkg doc">
  <header class="pkg-head">
    <h1 tabindex="-1">${h1}</h1>
    <p class="doc-lede">${lede}</p>
  </header>
  ${sections}
  ${check(base)}
</article>`;

export const GUIDES: Guide[] = [
  {
    path: 'docs/npm-download-count',
    title: 'How to check the download count of an npm package · humanloads',
    description: 'Four ways to see npm download stats for any package: weekly downloads, history, per-version counts and the npm API, plus what the numbers really mean.',
    body: (base) =>
      article(
        'How to check the download count of an npm package',
        'The quickest way: <a href="' + base + '">search for the package here</a>. You get its weekly downloads, a 12-month chart and real installs, without signing up.',
        `<section>
    <h2 class="section-title">On npmjs.com</h2>
    <p>Every package page shows <strong>Weekly Downloads</strong> with a small chart. It is a total for the last 7 days, with no breakdown of where the downloads came from.</p>
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
    <p>A package page here shows 12 months week by week, with each release marked. To compare packages, open a page such as
      <a href="${base}compare/react,vue">react vs vue</a> or <a href="${base}compare/jest,vitest">jest vs vitest</a>.</p>
  </section>
  <section>
    <h2 class="section-title">What the number means</h2>
    <p>A download is one served tarball, not one person. Mirrors, security scanners, crawlers and CI all count, so a small package can show hundreds of downloads with almost no users.
      <a href="${base}docs/are-npm-downloads-real">Are npm downloads real?</a> explains how much of the count that can be.</p>
  </section>`,
        base,
      ),
  },
  {
    path: 'docs/are-npm-downloads-real',
    title: 'Are npm downloads real? Why new packages get 100 downloads · humanloads',
    description: 'npm counts every tarball fetch. Why a new package gets 100 downloads on day one, how much of the count is bots, and how to see the real installs.',
    body: (base) =>
      article(
        'Are npm downloads real?',
        'They are real fetches, but not real users. npm itself says its counts <a href="https://blog.npmjs.org/post/92574016600/numeric-precision-matters-how-npm-download-counts-work.html">are not the same as the number of users</a> and that it does not filter out robots.',
        `<section>
    <h2 class="section-title">Why did my new package get 100 downloads?</h2>
    <p>Because you published it. Registry mirrors and security scanners fetch every new version right away.
      <a href="https://tenable.com/blog/how-cyberattackers-inflate-malicious-package-npm-download-counts">Tenable measured</a> about 100–150 automated downloads for each version published. That says nothing about users.</p>
  </section>
  <section>
    <h2 class="section-title">Why does an old package still get downloads every week?</h2>
    <p>Crawlers fetch every published version a few times a week, used or not. A package with many versions can collect a steady count that way even if nobody installs it.</p>
  </section>
  <section>
    <h2 class="section-title">Can download counts be faked?</h2>
    <p>Yes. A script that requests the tarball URL directly counts the same as a real install: Tenable pushed a test package to 17,000 downloads in about an hour. A high count alone is not proof that a package is trusted, so check its dependents and repository too.</p>
  </section>
  <section>
    <h2 class="section-title">How many people use my npm package?</h2>
    <p>Nobody can say exactly, because npm does not record who downloaded what. You can get closer: remove the mirror spikes and the crawler traffic, then look at what is left and at who depends on the package.
      Search for your package <a href="${base}">here</a> to see that, or read <a href="${base}${METHODOLOGY_PATH}">how the estimate works</a>. What is left still includes CI and installs as a dependency of other packages.</p>
  </section>`,
        base,
      ),
  },
  {
    path: DEPRECATED_GUIDE_PATH,
    title: 'Deprecated npm packages list: the most downloaded ones · humanloads',
    description: 'The most downloaded deprecated npm packages, with each maintainer\'s own message, and how to find them in your project. Kept up to date.',
    ready: (ins) => (ins?.deprecated.length ?? 0) >= DEPRECATED_MIN_ROWS,
    body: (base, ins) => {
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
    <p>Usually because other packages still require them. A deprecated package keeps working, and it stays in every lockfile and dependency tree that names it, so most of these downloads probably don't come from anyone choosing it today. Deprecated doesn't always mean dangerous either: many entries here were simply renamed.</p>
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
      );
    },
  },
  {
    path: CHAIN_GUIDE_PATH,
    title: 'Why does is-number have so many npm downloads? · humanloads',
    description: 'A package that checks whether a value is a number gets hundreds of millions of npm downloads a week. Follow the dependency trail that explains it.',
    ready: (ins) => (ins?.chains[CHAIN_EXAMPLE]?.length ?? 0) >= 2,
    body: (base, ins) => {
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
    <p>Installing any package at the end of that trail fetches every package before it. So a build tool used by millions of projects adds a download to each small helper underneath it, on every clean install and every CI run.</p>
  </section>
  <section>
    <h2 class="section-title">Are those real installs?</h2>
    <p>Yes. The tarball really is fetched and installed, so filtering out mirrors and crawlers barely changes a number this size. What it doesn't tell you is that anyone decided to use the package. For a package like this, a download count mostly measures how popular its dependents are.</p>
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
      );
    },
  },
];
