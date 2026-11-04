// The English methodology page, shared by the SPA route and the prerender script, so crawlers and the app
// show the same text. Source of truth for the math: docs/METHODOLOGY.md and src/core/estimate.ts.

// Not a valid npm package name (a slash without "@scope"), so it can't clash with a package route.
export const METHODOLOGY_PATH = 'docs/methodology';
export const METHODOLOGY_TITLE = 'Methodology: how humanloads estimates real npm installs';
export const METHODOLOGY_DESCRIPTION =
  'Why npm download counts overstate usage, and how humanloads removes mirror spikes and crawler floors to estimate weekly human installs as a range.';

export const METHODOLOGY_SECTIONS = [
  ['what-npm-counts', 'What npm actually counts'],
  ['evidence', 'What the bots look like in real data'],
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
    'They are an accurate count of tarball fetches, not of people. Every fetch counts: registry mirrors, security scanners, CI pipelines and crawlers as well as developers. For small packages most of the number is robots.',
  ],
  [
    'How many npm downloads are bots?',
    'It depends on the package. A brand-new version gets roughly 100–150 downloads from mirrors and scanners within days, and crawlers fetch every published version a few times a week. For a small package that can be 90% of the count; for a very popular one it is a rounding error.',
  ],
  [
    'Can humanloads tell me the exact number of users?',
    'No, and nobody can, npm included: npm does not record who downloaded what. humanloads gives an estimate with a range and a confidence level and shows its working.',
  ],
  [
    'Why is the estimate for my package so low?',
    'Usually because most of its downloads match bot patterns: spikes right after each release and the same flat count on every old version. Private and corporate use behind a registry mirror is invisible to everyone and cannot be counted.',
  ],
];

// Body of the page; `base` is the site's base path ("/" on a domain root).
export function methodologyBody(base: string): string {
  return `<article class="pkg doc">
  <header class="pkg-head">
    <h1 tabindex="-1">How humanloads estimates real installs</h1>
    <p class="doc-lede">The rule of the project: we show an <strong>estimate with an honest margin of error</strong>, not an exact
      number of users. Nobody has the exact number, npm included.</p>
  </header>
  <nav class="doc-toc" aria-label="On this page"><ol>${METHODOLOGY_SECTIONS.map(([id, t]) => `<li><a href="#${id}">${t}</a></li>`).join('')}</ol></nav>

  <section>
    ${h2('what-npm-counts')}
    <p>The npm downloads API reports how many times a package's <code>.tgz</code> tarball was served successfully each day.
      It does not look at uniqueness, IP address, user agent or client type. So the count includes:</p>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Source</th><th scope="col">How it shows up in the data</th></tr></thead>
      <tbody>
        <tr><td>Registry mirrors (Artifactory, Nexus, npmmirror, Verdaccio proxies…)</td><td>A spike on the day a version is published, fading over 2–4 days</td></tr>
        <tr><td>Security scanners and crawlers</td><td>A flat floor: <em>every</em> version gets about the same downloads each week</td></tr>
        <tr><td>Other projects' CI</td><td>Steady downloads of one pinned version, often on weekdays</td></tr>
        <tr><td>Developers</td><td>Uneven, mostly the latest version and versions pinned in lockfiles</td></tr>
        <tr><td>Inflation</td><td>Direct requests to the tarball URL, indistinguishable from the rest</td></tr>
      </tbody>
    </table></div>
  </section>

  <section>
    ${h2('evidence')}
    <p>On a small real package with a handful of users, each release day showed 114–147 downloads per new version,
      and the background between releases was 0–11 a day. In one week its six versions got exactly 3, 3, 3, 3, 3 and 5
      downloads: a robot that fetches every version once in a while. Only 2 downloads of the latest version stood above
      that floor, so about 2 of 20 weekly downloads looked human. This matches Tenable's research of roughly
      100–150 automated downloads for every new version.</p>
  </section>

  <section>
    ${h2('spikes')}
    <p>Inputs are public: daily downloads (<code>api.npmjs.org/downloads/range</code>), publish dates from the registry
      (<code>registry.npmjs.org/&lt;pkg&gt;</code>) and last week's downloads per version (<code>api.npmjs.org/versions/&lt;pkg&gt;/last-week</code>).</p>
    <ol>
      <li>Every publish day opens a window of that day plus the next 3.</li>
      <li>For each day in a window, the background is the larger of two medians: the same weekday 1–2 weeks before, and
        the same weekday 1–2 weeks after. Zero days (npm API outages) and days inside other windows are skipped.</li>
      <li>A day counts as a spike only if it is more than <strong>2×</strong> its background. Then it is cut down to the background;
        the difference goes to mirrors and scanners.</li>
    </ol>
    <p>Comparing with the same weekday keeps the weekly rhythm; taking the larger of “before” and “after” never cuts real
      growth; the 2× threshold lets normal ups and downs through. Simpler baselines failed on real packages: one that publishes
      canaries daily had no quiet days to compare with, and one with a 2.5× weekday/weekend swing lost every weekday.</p>
  </section>

  <section>
    ${h2('floor')}
    <ol>
      <li>Take last week's downloads of every version older than 14 days (newer ones are still in their spike).
        The crawler floor <em>f</em> is a low percentile of those counts.</li>
      <li>Human downloads ≈ the sum over versions of <code>max(0, downloads − f)</code>, minus the spike removed in step A
        for the same 7 days.</li>
      <li>That week's share of human downloads is applied to the cleaned daily series to draw the chart.</li>
      <li>With fewer than 3 old versions the floor can't be measured. Then it comes from calibration (below) or a default of 3
        per version, and the page says so.</li>
    </ol>
  </section>

  <section>
    ${h2('range')}
    <p>The result is always a <strong>range</strong>. Its edges come from different floor percentiles (10th for the
      best guess, 25th for the low end, the minimum for the high end), widened by counting noise: about ±2√n for a weekly
      count of n, roughly a 95% Poisson interval. For a package with 2 human installs a week that reads “≈ 0–5”;
      for a large package the band is negligible.</p>
  </section>

  <section>
    ${h2('confidence')}
    <ul>
      <li><strong>low</strong>: fewer than 10 human installs a week (noise is as big as the signal), or the floor could not be measured.</li>
      <li><strong>high</strong>: 1,000 or more a week with a measured floor.</li>
      <li><strong>medium</strong>: everything else.</li>
    </ul>
    <p>Low becomes medium (with at least 10 a week) when there is independent evidence of use, or when weekday traffic is at
      least 1.3× weekend traffic over the last 8 weeks: people work in a weekly rhythm, robots don't. CI also runs on
      weekdays, so the rhythm never lifts a package to high. Missing evidence never lowers confidence.</p>
  </section>

  <section>
    ${h2('signals')}
    <p>Downloads are not the only trace of use. Each package page also shows:</p>
    <ul>
      <li><strong>Dependent packages and repositories</strong> (ecosyste.ms, deps.dev): published packages and public projects that list it.</li>
      <li><strong>CDN hits</strong> (jsDelivr): websites loading it from a CDN.</li>
      <li><strong>GitHub activity</strong>: stars, forks and issues from other people.</li>
    </ul>
    <p>Thresholds for raising confidence: 5 dependent packages, 10 dependent repositories or 1,000 monthly CDN hits.
      Stars show interest, not installs, so they never count. All of these are lower bounds: private code is invisible.</p>
  </section>

  <section>
    ${h2('calibration')}
    <p>A canary package that nobody uses gets a new version regularly. Everything it downloads is pure bot noise, so its
      old versions measure the crawler floor directly. When a package's own floor can't be measured, the canary's floor is used
      instead of the default.</p>
  </section>

  <section>
    ${h2('limits')}
    <ul>
      <li>Private and corporate use behind a registry mirror is invisible in principle.</li>
      <li>Inflation by direct tarball requests can't be told apart from real traffic.</li>
      <li>For very popular packages the floor drowns in the volume, so the estimate barely changes the number. That is correct.</li>
      <li>npm data lags by 1–2 days.</li>
    </ul>
  </section>

  <section>
    ${h2('faq')}
    <dl class="doc-faq">${METHODOLOGY_FAQ.map(([q, a]) => `<dt>${q}</dt><dd>${a}</dd>`).join('')}</dl>
  </section>

  <p class="method"><a href="${base}">Check a package <span aria-hidden="true">→</span></a></p>
</article>`;
}
