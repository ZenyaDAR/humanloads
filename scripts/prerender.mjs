// Runs after `vite build`. Everything absolute comes from SITE_URL (site.config.ts). Writes into dist/:
//   index.html        home with static featured lists, canonical and JSON-LD
//   404.html          the bare SPA shell, noindex (GitHub Pages serves it for any unknown path)
//   <name>.html       a page per package in tracked.json + summary.json: meta, JSON-LD and a readable static body.
//                     GitHub Pages serves /<name> from <name>.html with HTTP 200 and no trailing-slash redirect.
//   sitemap.xml, robots.txt, llms.txt, and CNAME when SITE_URL is a custom domain
// Numbers come from dist/data/summary.json and featured.json (copied from public/ by vite); without them
// pages get generic text.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isValidPackageName } from '../src/core/sources.ts';
import { customDomain, resolveSiteUrl } from '../site.config.ts';
import { METHODOLOGY_PATH } from '../src/core/methodology.ts';
import { homeHtml, llmsTxt, methodologyHtml, notFoundHtml, prerenderHtml, robotsTxt, sitemapXml } from './data-lib.ts';

const SITE = resolveSiteUrl();
const RELATED = 6;
const RESERVED = new Set(['index', '404', 'robots.txt', 'sitemap.xml', 'llms.txt', 'CNAME']);

const dist = new URL('../dist/', import.meta.url);
const readJson = async (url) => (existsSync(url) ? JSON.parse(await readFile(url, 'utf8')) : null);
const shell = await readFile(new URL('index.html', dist), 'utf8');
const tracked = JSON.parse(await readFile(new URL('../data/tracked.json', import.meta.url), 'utf8'));
const summary = await readJson(new URL('data/summary.json', dist));
const featured = await readJson(new URL('data/featured.json', dist));
const packages = summary?.packages ?? {};

await writeFile(new URL('404.html', dist), notFoundHtml(shell));
await writeFile(new URL('index.html', dist), homeHtml(shell, SITE, featured));
// Written before the package pages, so a package named "docs" is skipped as a clash below.
await mkdir(new URL('docs/', dist), { recursive: true });
await writeFile(new URL(`${METHODOLOGY_PATH}.html`, dist), methodologyHtml(shell, SITE));

// Biggest first: the sitemap, llms.txt and the "Other packages" links read in that order.
const names = [...new Set([...tracked, ...Object.keys(packages)])]
  .filter((name) => {
    if (!isValidPackageName(name)) return false; // never let a name escape dist/
    // A name that matches a built file or folder (data, badges, assets, og.png...) can't get a page.
    const clash = RESERVED.has(name) || existsSync(new URL(name, dist)) || existsSync(new URL(`${name}.html`, dist));
    if (clash) console.warn(`prerender: skip ${name}, it clashes with a built file`);
    return !clash;
  })
  .sort((a, b) => (packages[b]?.organicWeekly ?? -1) - (packages[a]?.organicWeekly ?? -1));

for (const [i, name] of names.entries()) {
  // The next few names, wrapping around: every page links to others and gets links back.
  const related = Array.from({ length: Math.min(RELATED, names.length - 1) }, (_, k) => names[(i + 1 + k) % names.length]);
  const html = prerenderHtml(shell, name, packages[name], SITE, { generated: summary?.generated, related });
  const file = new URL(`${name}.html`, dist);
  await mkdir(new URL('.', file), { recursive: true });
  await writeFile(file, html);
}

await writeFile(new URL('sitemap.xml', dist), sitemapXml([SITE, SITE + METHODOLOGY_PATH, ...names.map((n) => SITE + n)], summary?.generated));
await writeFile(new URL('robots.txt', dist), robotsTxt(SITE));
await writeFile(
  new URL('llms.txt', dist),
  llmsTxt(SITE, names.map((name) => ({ name, row: packages[name] })), summary?.generated),
);
const domain = customDomain(SITE);
if (domain) await writeFile(new URL('CNAME', dist), domain + '\n');

console.log(
  `prerender: ${SITE} home + methodology + ${names.length} package pages${summary ? '' : ' (no summary.json, generic text)'}` +
    `, sitemap, robots.txt, llms.txt${domain ? `, CNAME ${domain}` : ''}`,
);
