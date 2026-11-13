// The English methodology page, shared by the SPA route and the prerender script, so crawlers and the app
// show the same text. Source of truth for the math: docs/METHODOLOGY.md and src/core/estimate.ts.
import { article } from './guides.ts';

// Not a valid npm package name (a slash without "@scope"), so it can't clash with a package route.
export const METHODOLOGY_PATH = 'docs/methodology';
export const METHODOLOGY_TITLE = 'Methodology: how humanloads estimates real npm installs';
export const METHODOLOGY_DESCRIPTION =
  'What npm download counts include, how humanloads removes mirror spikes and the crawler floor, what remains, and what has not been validated.';

export const METHODOLOGY_SECTIONS = [
  ['what-npm-counts', 'What npm actually counts'],
  ['evidence', 'What bot traffic looks like in real data'],
  ['spikes', 'Step A: cut the publish spikes'],
  ['floor', 'Step B: subtract the crawler floor'],
  ['range', 'Step C: a range, not a number'],
  ['confidence', 'Confidence levels'],
  ['signals', 'Independent evidence of use'],
  ['calibration', 'Calibration'],
  ['limits', 'Known limits'],
  ['faq', 'FAQ'],
] as const;

const h2 = (id: (typeof METHODOLOGY_SECTIONS)[number][0]) =>
  `<h2 class="section-title" id="${id}">${METHODOLOGY_SECTIONS.find(([k]) => k === id)![1]}</h2>`;

export const METHODOLOGY_FAQ: [string, string][] = [
  [
    'Are npm download counts accurate?',
    'They are an accurate count of successful tarball fetches, not of people. Registry mirrors, security scanners, crawlers, CI pipelines and Docker builds all add to it, along with developers. For a small package, mirror spikes and crawlers alone can be most of the number.',
  ],
  [
    'How many npm downloads are bots?',
    'It depends on the package, and only part of it can be measured. A new version gets roughly 100–150 downloads from mirrors and scanners in its first days, and crawlers fetch every published version a few times a week. For a small package those two patterns can be 90% of the count; for a very popular one they are a rounding error. Other automation, such as CI and Docker builds, is not separated.',
  ],
  [
    'Can humanloads tell me how many people use a package?',
    'No, and no public data can: npm does not record who downloaded what. Real installs leave out mirror spikes and the crawler floor, but still include CI runs, Docker builds and installs as a dependency of other packages. That is why a popular package can show hundreds of millions of real installs a week.',
  ],
  [
    'Why is the number for my package so low?',
    'Usually because most of its downloads match the two patterns we remove: a spike right after each release, and the same flat count on every old version. People who install on release day are cut along with the spike, so the top of the range keeps it. Installs served by a private registry mirror never reach npm, so nobody can see them.',
  ],
  [
    'Why does a new package say "too new to tell"?',
    "Under two weeks after the first publish there is no quiet period to compare the release spike with, so mirrors and first users look the same. The range then runs from 0 to the whole week's count, with low confidence.",
  ],
];

// Body of the page; `base` is the site's base path ("/" on a domain root).
export function methodologyBody(base: string): string {
  return article(
    'How humanloads filters npm downloads',
    `We report <strong>real installs</strong>: npm's count without the publish spikes from mirrors and scanners, and without
      the crawler floor, the flat weekly count every version gets from crawlers. <strong>This is not a count of people.</strong> CI runs, Docker builds and
      installs as a dependency of other packages are installs too. They all remain, and public data can't separate them. The filter changes the number most for small packages, where those two patterns can be most of the count.`,
    `
  <section>
    ${h2('what-npm-counts')}
    <p>The npm downloads API reports how many times a package's <code>.tgz</code> tarball was served successfully each day.
      It ignores uniqueness, IP address, user agent and client type. So the count includes:</p>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Source</th><th scope="col">How it shows up in the data</th></tr></thead>
      <tbody>
        <tr><td>Registry mirrors (Artifactory, Nexus, npmmirror, Verdaccio proxies…)</td><td>A spike on the day a version is published, fading over 2–4 days</td></tr>
        <tr><td>Security scanners and crawlers</td><td>A flat floor: <em>every</em> version gets about the same downloads each week</td></tr>
        <tr><td>Other projects' CI</td><td>Steady downloads of one pinned version, often on weekdays</td></tr>
        <tr><td>Developers</td><td>Uneven, mostly the latest version and versions pinned in lockfiles</td></tr>
        <tr><td>Direct tarball requests, including deliberate inflation</td><td>Indistinguishable from the rest</td></tr>
      </tbody>
    </table></div>
  </section>

  <section>
    ${h2('evidence')}
    <p>On a small real package, each release day showed 114–147 downloads per new version, and the background between
      releases was 0–11 a day. In one week its six versions got exactly 3, 3, 3, 3, 3 and 5 downloads: the pattern of a crawler
      that fetches every version. Only 2 downloads of the latest version stood above that floor, so about 2 of 20 weekly
      downloads were left after filtering. This matches Tenable's research of roughly 100–150 automated downloads for every
      new version.</p>
  </section>

  <section>
    ${h2('spikes')}
    <p>Inputs are public: daily downloads (<code>api.npmjs.org/downloads/range</code>), publish dates from the registry
      (<code>registry.npmjs.org/&lt;pkg&gt;</code>) and last week's downloads per version (<code>api.npmjs.org/versions/&lt;pkg&gt;/last-week</code>).</p>
    <ol>
      <li>Every publish day opens a window of that day plus the next 3.</li>
      <li>For each day in a window, the background is the larger of two medians: the same weekday 1–2 weeks before, and
        the same weekday 1–2 weeks after. Zero days (npm API outages) are skipped, and so are days inside other windows unless
        nothing else is left. If both sides are empty, weekdays are compared with other weekdays within two weeks, and weekends
        with weekends; a package too young even for that falls back to any non-zero day within two weeks.</li>
      <li>A day counts as a spike only if it is more than <strong>2×</strong> its background. Then it is cut down to the background,
        and the difference is attributed to mirrors and scanners.</li>
    </ol>
    <p>Comparing with the same weekday keeps the weekly rhythm. Taking the larger of “before” and “after” keeps a lasting rise.
      The 2× threshold lets normal ups and downs through, which also means a mirror spike smaller than the package's own daily
      volume stays in. A short burst of real users on release day looks exactly like a mirror spike and gets cut, so the top of
      the range keeps the whole spike. Simpler baselines failed on real packages: one that publishes canaries daily had no quiet
      days to compare with, and one with a 2.5× weekday/weekend swing lost every weekday.</p>
  </section>

  <section>
    ${h2('floor')}
    <ol>
      <li>Take last week's downloads of every version older than 14 days (newer ones are still in their spike).
        The crawler floor <em>f</em> is the 10th percentile of those counts.</li>
      <li>Real installs ≈ the sum over versions of <code>max(0, downloads − f)</code>, minus the spike removed in step A
        for the same 7 days. When versions come out every day for weeks, step A has no quiet days to compare with and
        cuts nothing, so we take off at least 100 per version published in the last 10 days instead: the low end of the
        bot traffic Tenable measured. The top of the range keeps those downloads.</li>
      <li>That week's share of real installs is applied to the spike-free daily series to draw the chart. Zero days in the last
        7 with a background of 10 or more are treated as npm outages and filled with the background, for this share only.</li>
      <li>With fewer than 3 old versions the floor can't be measured. Then it comes from calibration (below) or a default of 3
        per version, bracketed by 0 and twice that value for the range, and the page says so.</li>
      <li>Under two weeks after the first publish there is too little history to separate noise from first users. The page says
        “too new to tell” and the range runs up to the whole week's count.</li>
    </ol>
  </section>

  <section>
    ${h2('range')}
    <p>The result is always a <strong>range</strong>. Its edges come from different floor percentiles (10th for the
      best guess, 25th for the low end, the minimum for the high end), widened by counting noise: about ±2√n for a weekly
      count of n, roughly a 95% Poisson interval. The high end also keeps any spike cut in those 7 days. A package with 2 filtered
      downloads a week reads “≈ 0–5”. The range covers only these sources of error, not CI or other automation. A narrow range is
      not a sign of accuracy, so large numbers are rounded to three significant digits, and when noise is under 1% of a count of
      1M or more a week, the page shows only that.</p>
  </section>

  <section>
    ${h2('confidence')}
    <ul>
      <li><strong>low</strong>: fewer than 10 real installs a week (noise is as big as the signal), a package too new to tell,
        or a floor that could not be measured.</li>
      <li><strong>high</strong>: 1,000 or more a week, a measured floor <em>and</em> independent evidence of use.</li>
      <li><strong>medium</strong>: everything else.</li>
    </ul>
    <p>Confidence is about how well the noise filter works for this package, not about whether the downloads come from people.
      A steady stream of direct tarball requests passes both filters, so volume alone never earns high: without independent
      evidence a package stops at medium. An unmeasured floor rises from low to medium (with at least 10 a week) on independent
      evidence, or when weekday traffic is at least 1.3× weekend traffic over the last 8 full weeks. That rhythm is weak
      evidence: CI and weekday releases have it too.</p>
  </section>

  <section>
    ${h2('signals')}
    <p>Downloads are not the only trace of use. Each package page also shows:</p>
    <ul>
      <li><strong>Dependent packages and repositories</strong> (ecosyste.ms): published packages and public projects that list it.</li>
      <li><strong>CDN hits</strong> (jsDelivr): requests for it through the jsDelivr CDN last month.</li>
      <li><strong>GitHub activity</strong>: stars, forks, open issues and the last push to its repository.</li>
    </ul>
    <p>Thresholds for raising confidence: 5 dependent packages, 10 dependent repositories or 1,000 monthly CDN hits.
      Stars show interest, not installs, so they never count. These are signals, not proof: harder to fake than downloads,
      not impossible. They are also lower bounds, since private code is invisible.</p>
  </section>

  <section>
    ${h2('calibration')}
    <p>An empty canary package that nobody uses gets a new patch version once a week. All its downloads come from mirrors,
      scanners and crawlers, so the median weekly downloads of its old versions measure the crawler floor directly. When a
      package's own floor can't be measured, the canary's floor replaces the default of 3. A reading above 100 per version is
      ignored as implausible, and until the canary has old versions to measure, the default stays.</p>
  </section>

  <section>
    ${h2('limits')}
    <ul>
      <li><strong>Not validated against real user counts.</strong> The canary only shows that an unused package comes out near zero.
        Nothing yet checks the numbers against packages with a known audience.</li>
      <li>CI, Docker builds and dependency installs are not removed. For very popular packages they are most of the count, so
        the filter barely changes npm's number, and that number says little about people. Trends can reflect automation too.</li>
      <li>Traffic served by private and corporate mirrors (Artifactory, Nexus, company proxies) never reaches npm, so nobody can see it.</li>
      <li>Direct requests to the tarball URL can't be told apart from real traffic. Independent evidence limits how much confidence such a package can get.</li>
      <li>npm publishes its data 1–2 days late.</li>
      <li>Packages under two weeks old are “too new to tell”: the range is wide and confidence is low.</li>
    </ul>
  </section>

  <section>
    ${h2('faq')}
    <dl class="doc-faq">${METHODOLOGY_FAQ.map(([q, a]) => `<dt>${q}</dt><dd>${a}</dd>`).join('')}</dl>
  </section>

`,
    base,
    {
      kicker: 'journal / methodology',
      path: METHODOLOGY_PATH,
      tldr: [
        "Real installs are npm's count without the publish spikes from mirrors and scanners, and without the crawler floor.",
        '<strong>This is not a count of people:</strong> CI runs, Docker builds and installs as a dependency of other packages all remain.',
        'The result is a range with a confidence level for the noise filter, and it has not been validated against real user counts.',
      ],
    },
  );
}
