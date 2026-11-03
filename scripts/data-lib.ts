// Pure helpers for scripts/build-data.mjs and scripts/prerender.mjs, kept apart from those scripts' top-level
// network/file work so tests can import them. Only erasable TS syntax: Node runs this file by type stripping.
import type { Calibration, FeaturedRow, RawPackageData, ShieldsBadge } from '../src/core/types.ts';
import { addDays, median } from '../src/core/estimate.ts';
import { esc } from '../src/core/html.ts';
import {
  HOME_DESCRIPTION, HOME_TITLE, REPO_URL, SITE_NAME, packageDescription, packageTitle,
} from '../src/core/seo.ts';
import {
  METHODOLOGY_DESCRIPTION, METHODOLOGY_FAQ, METHODOLOGY_PATH, METHODOLOGY_SECTIONS, METHODOLOGY_TITLE, methodologyBody,
} from '../src/core/methodology.ts';

export { esc };

const FEATURED_SIZE = 8;
const INFLATED_MIN_NPM = 100;
const INFLATED_MIN_RATIO = 0.3;
const OLD_VERSION_DAYS = 14; // same cutoff as estimate.ts step B

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
  return {
    floorPerVersion: median(old),
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

export function selectFeatured(all: FeaturedRow[]): { humans: FeaturedRow[]; inflated: FeaturedRow[] } {
  const humans = [...all].sort((a, b) => b.organicWeekly - a.organicWeekly).slice(0, FEATURED_SIZE);
  // Fewer than FEATURED_SIZE qualifying rows -> a shorter list, never padded with barely inflated ones.
  const inflated = all
    .filter((r) => r.npmWeekly >= INFLATED_MIN_NPM && r.inflation >= INFLATED_MIN_RATIO)
    .sort((a, b) => b.inflation - a.inflation || b.npmWeekly - a.npmWeekly)
    .slice(0, FEATURED_SIZE);
  return { humans, inflated };
}

export function compactCount(n: number): string {
  const short = (x: number, unit: string) => `${(Math.round(x * 10) / 10).toString()}${unit}`;
  if (n >= 999_950) return short(n / 1e6, 'M');
  if (n >= 1000) return short(n / 1e3, 'k');
  return String(n);
}

const COLORS = { high: 'brightgreen', medium: 'yellow', low: 'lightgrey' } as const;

export function badgeFor(row: Pick<FeaturedRow, 'organicWeekly' | 'confidence'>): ShieldsBadge {
  return { schemaVersion: 1, label: 'humans/week', message: `≈ ${compactCount(row.organicWeekly)}`, color: COLORS[row.confidence] };
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
const range = (r: Pick<FeaturedRow, 'low' | 'high'>) =>
  Math.round(r.low) === Math.round(r.high) ? fmt(r.low) : `${fmt(r.low)}–${fmt(r.high)}`;
const botShare = (inflation: number) => (inflation < 0.01 ? 'less than 1%' : `${Math.round(inflation * 100)}%`);

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
}

// The SPA shell with this page's <title>, description, canonical, Open Graph, JSON-LD and static body.
export function withPage(shell: string, page: Page): string {
  const tags = [
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

const masthead = (base: string) =>
  `<header class="masthead"><a class="logo" href="${esc(base)}">human<span>loads</span></a></header>`;

const METHOD_STEPS = `<ol>
        <li>Cut the spike every new version gets from mirrors in its first days.</li>
        <li>Subtract the flat floor robots download from <em>every</em> version each week.</li>
        <li>Show what is left as a range, with an honest confidence level.</li>
      </ol>`;

function website(site: string) {
  return { '@type': 'WebSite', '@id': `${site}#website`, url: site, name: SITE_NAME, description: HOME_DESCRIPTION, inLanguage: 'en' };
}

export interface PackagePageOpts {
  generated?: string; // summary.json timestamp
  related?: string[]; // other prerendered packages to link to
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
    ? `<section class="cards" aria-label="Downloads in the last 7 days">
        <div class="card card-npm">
          <h2 class="card-label">npm says</h2>
          <p class="card-big"><s class="struck">${fmt(r.npmWeekly)}</s><span class="per"> / week</span></p>
          <p class="card-sub">Every tarball fetch: mirrors, scanners, CI and people.</p>
        </div>
        <div class="card card-human">
          <h2 class="card-label">probably humans</h2>
          <p class="card-big">≈ <mark>${range(r)}</mark><span class="per"> / week</span></p>
          <p class="card-point">best guess <strong>${fmt(r.organicWeekly)}</strong>
            <span class="pill pill-${esc(r.confidence)}">${esc(r.confidence)} confidence</span></p>
        </div>
      </section>
      <p class="fineprint">Snapshot from the daily build${asOf ? ` of ${esc(asOf)}` : ''}, last 7 days of npm data. With JavaScript on, this page recomputes it live from the npm API.</p>
      <section>
        <h2 class="section-title">What these numbers mean</h2>
        <p>npm counted ${fmt(r.npmWeekly)} downloads of ${esc(name)} in the last 7 days. That count includes every tarball fetch:
          registry mirrors, security scanners, CI pipelines and crawlers as well as people.
          humanloads estimates that about ${fmt(r.organicWeekly)} of them (likely range ${range(r)}) were real human installs,
          with ${esc(r.confidence)} confidence. That puts ${botShare(r.inflation)} of npm's weekly count down to robots.</p>
      </section>`
    : `<section>
        <h2 class="section-title">What this page shows</h2>
        <p>npm's download count for ${esc(name)} includes every tarball fetch: registry mirrors, security scanners,
          CI pipelines and crawlers as well as people. This page fetches the last 12 months from the npm API and
          estimates how many of those downloads were real human installs, as a weekly range with a confidence level.</p>
      </section>`;

  const related = (opts.related ?? []).filter((n) => n !== name);
  const body = `<div class="view">
    ${masthead(base)}
    <article class="pkg">
      <header class="pkg-head">
        <h1 tabindex="-1"><span class="pkg-name">${esc(name)}</span></h1>
        ${r?.description ? `<p class="pkg-desc">${esc(r.description)}</p>` : ''}
        <ul class="pkg-links"><li><a href="${esc(npmUrl)}">npm</a></li></ul>
      </header>
      ${numbers}
      <section>
        <h2 class="section-title">How the estimate works</h2>
        ${METHOD_STEPS}
        <p class="method"><a href="${esc(base + METHODOLOGY_PATH)}">Read the methodology <span aria-hidden="true">→</span></a></p>
      </section>
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
  return withPage(shell, { title, description, url, body, jsonLd: ld });
}

const span = (r: FeaturedRow) => {
  const low = Math.round(r.low);
  const high = Math.round(r.high);
  return low === high ? compactCount(low) : `${compactCount(low)}–${compactCount(high)}`;
};

// Same markup as the SPA's home cards (src/web/home.ts), so the swap on boot looks alike.
function homeCard(r: FeaturedRow, base: string, bots: boolean): string {
  return `<li><a class="fcard" href="${esc(base + r.name)}">
    <span class="fcard-name">${esc(r.name)}</span>
    ${bots ? `<span class="fcard-tag">${Math.round(r.inflation * 100)}% bots</span>` : ''}
    ${r.description ? `<span class="fcard-desc">${esc(r.description)}</span>` : ''}
    <span class="fcard-nums">
      <s class="struck num"><span class="sr-only">npm says </span>${compactCount(r.npmWeekly)}</s>
      <span class="fcard-human">≈ <mark>${span(r)}</mark> humans</span>
    </span>
    <span class="pill pill-${esc(r.confidence)}">${esc(r.confidence)}</span>
  </a></li>`;
}

export interface Featured {
  generated?: string;
  humans?: FeaturedRow[];
  inflated?: FeaturedRow[];
}

// index.html: the home page with its featured lists as static links, so crawlers find the package pages.
export function homeHtml(shell: string, site: string, featured: Featured | null): string {
  const base = new URL(site).pathname;
  const section = (rows: FeaturedRow[] | undefined, title: string, note: string, bots: boolean) =>
    Array.isArray(rows) && rows.length
      ? `<section class="fcards-sec">
        <h2 class="section-title">${title} <span class="fcards-note hand">${note}</span></h2>
        <ul class="fcards">${rows.slice(0, 6).map((r) => homeCard(r, base, bots)).join('')}</ul>
      </section>`
      : '';
  const asOf = day(featured?.generated);
  const body = `<div class="view">
    <div class="home-top"></div>
    <section class="home">
      <h1 class="home-title" tabindex="-1">human<span class="home-title-mark">loads</span></h1>
      <p class="home-pitch">npm counts every tarball fetch: mirrors, scanners, CI. <span class="hl">We estimate the humans.</span></p>
    </section>
    <div class="featured">
      ${section(featured?.humans, 'Most real humans', 'top by estimated human installs', false)}
      ${section(featured?.inflated, 'Most bot-inflated', 'where npm counts robots the most', true)}
      ${asOf ? `<p class="fineprint">Updated ${esc(asOf)}. Weekly numbers, last 7 days.</p>` : ''}
    </div>
    <aside class="home-note">
      <p class="hand">how it works</p>
      ${METHOD_STEPS}
      <p><a href="${esc(base + METHODOLOGY_PATH)}">Read the methodology</a></p>
    </aside>
  </div>`;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      website(site),
      {
        '@type': 'Dataset',
        '@id': `${site}#dataset`,
        name: 'Estimated human installs of npm packages',
        description:
          'Weekly npm download counts next to an estimate of real human installs, after removing registry mirrors, ' +
          'security scanners and crawlers. Rebuilt daily from the public npm downloads API.',
        url: site,
        isAccessibleForFree: true,
        keywords: ['npm', 'downloads', 'bot traffic', 'package popularity'],
        measurementTechnique: 'Publish-spike removal and per-version crawler floor subtraction',
        variableMeasured: ['npm weekly downloads', 'estimated weekly human installs', 'confidence'],
        ...(featured?.generated && { dateModified: featured.generated }),
        distribution: [
          { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${site}data/summary.json` },
          { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${site}data/featured.json` },
        ],
      },
    ],
  };
  return withPage(shell, { title: HOME_TITLE, description: HOME_DESCRIPTION, url: site, body, jsonLd: ld });
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

// ---------- crawler files ----------

export function sitemapXml(urls: string[], lastmod?: string): string {
  const mod =
    lastmod && !Number.isNaN(Date.parse(lastmod)) ? `<lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc>${mod}</url>`).join('\n')}
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
export function llmsTxt(site: string, pages: { name: string; row?: FeaturedRow }[], generated?: string): string {
  const asOf = day(generated);
  const list = pages
    .map(
      ({ name, row }) =>
        `- [${name}](${site}${name})` +
        (row
          ? `: ~${fmt(row.organicWeekly)} human installs/week (range ${range(row)}, ${row.confidence} confidence) vs ${fmt(row.npmWeekly)} npm downloads`
          : ''),
    )
    .join('\n');
  return `# ${SITE_NAME}

> npm's download counter counts every tarball fetch: registry mirrors, security scanners, CI and crawlers.
> humanloads estimates how many of an npm package's weekly downloads are real human installs, as a range with a confidence level.

## Method

- Every new version gets a burst of downloads from mirrors and scanners in its first days; that spike is removed.
- Crawlers download every published version at a roughly flat weekly rate (the per-version floor); that floor is subtracted.
- What remains is reported as a weekly range with a confidence level (high, medium or low). Small packages get wide, low-confidence ranges.
- Independent evidence of use (dependent packages and repositories, jsDelivr CDN hits, GitHub activity) is shown next to the estimate.
- [Full methodology](${site}${METHODOLOGY_PATH}): the math, the thresholds, the limits and an FAQ

## URLs

- Home: ${site}
- A package: ${site}<package-name>, scoped: ${site}@scope/name
- Compare 2–3 packages: ${site}compare/<a>,<b>[,<c>]
- Pages compute live numbers in the browser from the public npm API. Prerendered pages also carry the daily build's numbers as static HTML.

## Data (JSON, rebuilt daily${asOf ? `, last build ${asOf}` : ''})

- [summary.json](${site}data/summary.json): per package: npmWeekly, organicWeekly (estimated humans), low, high, inflation (bot share, 0–1), confidence
- [featured.json](${site}data/featured.json): the homepage lists, most real humans and most bot-inflated
- [badges/index.json](${site}badges/index.json): packages with a shields.io endpoint badge at ${site}badges/<name>.json (\`@scope/name\` is written \`scope__name\`)

## Package pages

${list}

## Optional

- [Source code](${REPO_URL})
`;
}
