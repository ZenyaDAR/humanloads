// Runs after `vite build`. Everything absolute comes from SITE_URL (site.config.ts). Writes into dist/:
//   index.html        home with static featured lists, canonical and JSON-LD
//   404.html          the bare SPA shell, noindex (GitHub Pages serves it for any unknown path)
//   lists/<slug>.html ranked lists built on lists.json
//   <name>.html       a page per package in tracked.json + summary.json: meta, JSON-LD and a readable static body.
//                     GitHub Pages serves /<name> from <name>.html with HTTP 200 and no trailing-slash redirect.
//   data/mentions.json  numbers for the packages the guides mention
//   sitemap.xml, robots.txt, llms.txt, and CNAME when SITE_URL is a custom domain
// Numbers come from dist/data/summary.json and featured.json (copied from public/ by vite); without them
// pages get generic text.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isValidPackageName } from '../src/core/sources.ts';
import { customDomain, resolveBadgeApiUrl, resolveSiteUrl } from '../site.config.ts';
import { METHODOLOGY_PATH } from '../src/core/methodology.ts';
import { GUIDES, pickMentions } from '../src/core/guides.ts';
import { LISTS } from '../src/core/lists.ts';
import { comparePath, isIndexable } from '../src/core/seo.ts';
import {
  compareHtml, comparePages, guideHtml, homeHtml, llmsTxt, methodologyHtml, notFoundHtml, prerenderHtml, robotsTxt, sitemapXml,
} from './data-lib.ts';

const SITE = resolveSiteUrl();
const RELATED = 6;
const RESERVED = new Set(['index', '404', 'robots.txt', 'sitemap.xml', 'llms.txt', 'CNAME']);

const dist = new URL('../dist/', import.meta.url);
const readJson = async (url) => (existsSync(url) ? JSON.parse(await readFile(url, 'utf8')) : null);
const shell = await readFile(new URL('index.html', dist), 'utf8');
const tracked = JSON.parse(await readFile(new URL('../data/tracked.json', import.meta.url), 'utf8'));
const summary = await readJson(new URL('data/summary.json', dist));
const featured = await readJson(new URL('data/featured.json', dist));
const insights = await readJson(new URL('data/insights.json', dist));
const listsFile = await readJson(new URL('data/lists.json', dist));
// No prototype: a package called "constructor" with no row must read as undefined, not as Object's constructor.
const packages = Object.assign(Object.create(null), summary?.packages);
const allPairs = JSON.parse(await readFile(new URL('../data/compare.json', import.meta.url), 'utf8'))
  .filter((p) => p.length >= 2 && p.length <= 3 && p.every(isValidPackageName));
const waiting = [...(summary?.pending ?? []), ...(summary?.archived ?? [])];
const { pairs, pages: pagePairs } = comparePages(allPairs, packages, waiting);
const rowDates = (names) => names.map((n) => packages[n]?.updated).filter(Boolean).sort();
const readyLists = LISTS.filter((g) => g.ready(listsFile));

await writeFile(new URL('404.html', dist), notFoundHtml(shell));
await writeFile(new URL('index.html', dist), homeHtml(shell, SITE, featured, pairs));
// Written before the package pages, so a package named "docs" is skipped as a clash below.
await mkdir(new URL('docs/', dist), { recursive: true });
await mkdir(new URL('lists/', dist), { recursive: true });
await writeFile(new URL(`${METHODOLOGY_PATH}.html`, dist), methodologyHtml(shell, SITE));
for (const guide of GUIDES) await writeFile(new URL(`${guide.path}.html`, dist), guideHtml(shell, SITE, guide, insights, packages));
// The same "Mentioned in this article" numbers for guides the SPA renders itself; summary.json is too big to fetch.
if (summary) {
  const mentions = pickMentions([...new Set(GUIDES.flatMap((g) => g.mentions ?? []))], packages);
  await writeFile(new URL('data/mentions.json', dist), JSON.stringify({ generated: summary.generated, rows: Object.fromEntries(mentions.map((r) => [r.name, r])) }));
}
for (const list of LISTS) await writeFile(new URL(`${list.path}.html`, dist), guideHtml(shell, SITE, list, listsFile));

// Also before the package pages: a package named "compare" would clash with this folder.
// Rows rotate, so a page's numbers are as old as its oldest row.
for (const p of pagePairs) {
  const i = pairs.indexOf(p);
  const others = Array.from({ length: Math.min(6, pairs.length - (i < 0 ? 0 : 1)) }, (_, k) => pairs[(i + 1 + k) % pairs.length]);
  const html = compareHtml(shell, p, p.map((n) => packages[n]), SITE, { generated: rowDates(p)[0] ?? summary?.generated, others });
  const file = new URL(`${comparePath(p)}.html`, dist);
  await mkdir(new URL('.', file), { recursive: true });
  await writeFile(file, html);
}

// Biggest first: the sitemap, llms.txt and the "Other packages" links read in that order.
// `pending` and `archived` names keep their page with generic text; isIndexable keeps it out of indexes.
const names = [...new Set([...tracked, ...Object.keys(packages), ...waiting])]
  .filter((name) => {
    if (!isValidPackageName(name)) return false; // never let a name escape dist/
    // A name that matches a built file or folder (data, badges, assets, og.png...) can't get a page.
    const clash = RESERVED.has(name) || existsSync(new URL(name, dist)) || existsSync(new URL(`${name}.html`, dist));
    if (clash) console.warn(`prerender: skip ${name}, it clashes with a built file`);
    return !clash;
  })
  .sort((a, b) => (packages[b]?.organicWeekly ?? -1) - (packages[a]?.organicWeekly ?? -1));

// Pages kept out of search indexes still get built, but stay out of the sitemap, llms.txt and "Other packages".
const indexable = names.filter((name) => isIndexable(packages[name]));

for (const name of names) {
  // The next few indexable names, wrapping around: every page links to others and gets links back.
  const i = indexable.indexOf(name);
  const related = Array.from({ length: Math.min(RELATED, indexable.length - (i < 0 ? 0 : 1)) }, (_, k) => indexable[(i + 1 + k) % indexable.length]);
  const comparisons = pairs.filter((p) => p.includes(name));
  const html = prerenderHtml(shell, name, packages[name], SITE, { generated: packages[name]?.updated ?? summary?.generated, related, comparisons, insights, lists: listsFile });
  const file = new URL(`${name}.html`, dist);
  await mkdir(new URL('.', file), { recursive: true });
  await writeFile(file, html);
}

await writeFile(new URL('sitemap.xml', dist), sitemapXml(
    [SITE, SITE + METHODOLOGY_PATH, ...GUIDES.filter((g) => !g.ready || g.ready(insights)).map((g) => SITE + g.path), ...readyLists.map((g) => SITE + g.path), ...pairs.map((p) => SITE + comparePath(p)), ...indexable.map((n) => SITE + n)],
    summary?.generated,
    Object.fromEntries([
      ...indexable.map((n) => [SITE + n, packages[n]?.updated]),
      ...pairs.map((p) => [SITE + comparePath(p), rowDates(p).at(-1)]),
    ]),
  ));
await writeFile(new URL('robots.txt', dist), robotsTxt(SITE));
await writeFile(
  new URL('llms.txt', dist),
  llmsTxt(SITE, indexable.map((name) => ({ name, row: packages[name] })), summary?.generated, pairs, readyLists, resolveBadgeApiUrl()),
);
const domain = customDomain(SITE);
if (domain) await writeFile(new URL('CNAME', dist), domain + '\n');

console.log(
  `prerender: ${SITE} home + methodology + ${readyLists.length}/${LISTS.length} lists + ${pairs.length}/${pagePairs.length} comparisons + ${names.length} package pages (${indexable.length} indexable)${summary ? '' : ' (no summary.json, generic text)'}` +
    `, sitemap, robots.txt, llms.txt${domain ? `, CNAME ${domain}` : ''}`,
);
