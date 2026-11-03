import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  badgeFor, calibrate, compactCount, esc, homeHtml, llmsTxt, notFoundHtml, poolFailure, prerenderHtml, robotsTxt, safeName,
  selectFeatured, sitemapXml, methodologyHtml,
} from '../scripts/data-lib.ts';
import { customDomain, resolveSiteUrl } from '../site.config.ts';
import type { Confidence, FeaturedRow, RawPackageData } from '../src/core/types.ts';

// --- Badges ---

const messages: [number, string][] = [
  [0, '0'],
  [999, '999'],
  [1000, '1k'],
  [1049, '1k'],
  [1050, '1.1k'],
  [12_345, '12.3k'],
  [999_949, '999.9k'],
  [999_950, '1M'], // would otherwise print "1000k"
  [2_460_000, '2.5M'],
  [446_650_334, '446.7M'],
];
for (const [n, expected] of messages) {
  test(`badge message for ${n} is "≈ ${expected}"`, () => {
    assert.equal(compactCount(n), expected);
    assert.equal(badgeFor({ organicWeekly: n, confidence: 'high' }).message, `≈ ${expected}`);
  });
}

for (const [confidence, color] of [['high', 'brightgreen'], ['medium', 'yellow'], ['low', 'lightgrey']] as const) {
  test(`badge color for ${confidence} confidence is ${color}`, () => {
    assert.deepEqual(badgeFor({ organicWeekly: 5, confidence }), { schemaVersion: 1, label: 'humans/week', message: '≈ 5', color });
  });
}

test('safeName flattens scoped names', () => {
  assert.equal(safeName('@scope/name'), 'scope__name');
  assert.equal(safeName('react'), 'react');
});

// --- Featured ---

const row = (name: string, npmWeekly: number, organicWeekly: number, confidence: Confidence = 'medium'): FeaturedRow => ({
  name,
  npmWeekly,
  organicWeekly,
  low: organicWeekly,
  high: organicWeekly,
  inflation: npmWeekly > 0 ? 1 - organicWeekly / npmWeekly : 0,
  confidence,
});

test('featured: inflated needs npm >= 100 and inflation >= 0.3, sorted by inflation then npm', () => {
  const { inflated } = selectFeatured([
    row('ok-50', 1000, 500), // inflation 0.5
    row('edge-30', 100, 70), // exactly 100 and 0.3: included
    row('tiny', 99, 0), // npm below 100
    row('barely', 1000, 710), // inflation 0.29
    row('ok-90-small', 200, 20), // 0.9
    row('ok-90-big', 2000, 200), // 0.9, bigger npm wins the tie
  ]);
  assert.deepEqual(inflated.map((r) => r.name), ['ok-90-big', 'ok-90-small', 'ok-50', 'edge-30']);
});

test('featured: humans are the top 8 by organic and lists are never padded', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(`p${i}`, 1000, i * 10));
  const { humans, inflated } = selectFeatured(rows);
  assert.deepEqual(humans.map((r) => r.name), ['p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4']);
  assert.equal(inflated.length, 8);
  assert.deepEqual(selectFeatured([row('a', 1000, 1000)]).inflated, []);
});

// --- Calibration ---

const DAY_MS = 86_400_000;
const START = Date.parse('2026-06-01T00:00:00Z');
const dayAt = (i: number) => new Date(START + i * DAY_MS).toISOString().slice(0, 10);

test('calibrate: floor is the median of old versions', () => {
  const downloads = Array.from({ length: 70 }, (_, i) => ({ day: dayAt(i), downloads: 2 }));
  const time: Record<string, string> = { created: dayAt(0) + 'T00:00:00Z' };
  // Weekly publishes; each adds 100 on its publish day.
  for (let w = 0; w < 9; w++) {
    time[`0.${w}.0`] = dayAt(w * 7) + 'T10:00:00Z';
    downloads[w * 7].downloads += 100;
  }
  const versionsLastWeek: Record<string, number> = { '0.0.0': 3, '0.1.0': 4, '0.2.0': 5, '0.8.0': 120 };
  const data: RawPackageData = { name: 'canary', downloads, registry: { name: 'canary', 'dist-tags': {}, time }, versionsLastWeek };
  const c = calibrate(data, 'canary');
  assert.ok(c);
  // Old (published > 14 days before the last day): 0.0-0.6, missing ones count as 0 -> median of [3,4,5,0,0,0,0] = 0.
  assert.equal(c.floorPerVersion, 0);
  assert.equal(c.source, 'canary');
  assert.deepEqual(Object.keys(c).sort(), ['floorPerVersion', 'source', 'updated']);
});

// --- Data run health ---

test('poolFailure: a failed tracked package fails the run', () => {
  assert.match(poolFailure(['a', 'b', 'c'], new Set(['a', 'c']), ['b']) ?? '', /tracked packages failed: b/);
});

test('poolFailure: more than half the pool failing fails the run', () => {
  assert.match(poolFailure(['a', 'b', 'c'], new Set(['a']), []) ?? '', /2\/3 packages failed/);
});

test('poolFailure: permanent 404s (even tracked ones) do not fail the run', () => {
  assert.equal(poolFailure(['a', 'b', 'c'], new Set(['a']), ['b'], new Set(['b', 'c'])), null);
});

test('poolFailure: 404s are not counted toward the half-pool rule, transient failures are', () => {
  // 1 of 4 is a 404, 2 are transient: 2/4 is not more than half.
  assert.equal(poolFailure(['a', 'b', 'c', 'd'], new Set(['a']), [], new Set(['b'])), null);
  // A tracked transient failure still fails next to a 404.
  assert.match(poolFailure(['a', 'b'], new Set([]), ['a'], new Set(['b'])) ?? '', /tracked packages failed: a/);
});

test('poolFailure: exactly half failing, or tracked names outside a --limit pool, is fine', () => {
  assert.equal(poolFailure(['a', 'b'], new Set(['a']), []), null);
  // "z" is tracked but not in the limited pool, so it can't count as lost.
  assert.equal(poolFailure(['a', 'b'], new Set(['a', 'b']), ['z']), null);
});

test('calibrate: returns null without data', () => {
  const empty: RawPackageData = { name: 'c', downloads: [], registry: { name: 'c', 'dist-tags': {}, time: {} }, versionsLastWeek: {} };
  assert.equal(calibrate(empty, 'c'), null);
});

// --- Prerender ---

const SHELL = `<html><head>
    <title>humanloads</title>
    <meta name="description" content="generic" />
    <meta property="og:title" content="generic" />
    <meta property="og:image" content="og.svg" />
  </head><body><div id="app"></div></body></html>`;
const EVIL = '"><script>alert(1)</script>';

test('esc escapes all HTML-significant characters', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('prerender: a malicious description and confidence are escaped', () => {
  const r = { ...row('pkg', 1000, 400), description: EVIL, confidence: EVIL as Confidence };
  const html = prerenderHtml(SHELL, 'pkg', r, 'https://example.test/');
  // The only script is the JSON-LD block; the payload never appears unescaped.
  assert.doesNotMatch(html, /<script>alert/);
  assert.equal(html.match(/<script/g)?.length, 1);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test('prerender: per-package tags replace the shell ones and og:image stays', () => {
  const html = prerenderHtml(SHELL, 'pkg', row('pkg', 1234, 400, 'high'), 'https://example.test/');
  assert.equal(html.match(/<title>/g)?.length, 1);
  assert.equal(html.match(/name="description"/g)?.length, 1);
  assert.equal(html.match(/property="og:title"/g)?.length, 1);
  assert.doesNotMatch(html, /content="generic"/);
  assert.match(html, /og:image" content="og.svg"/);
  assert.match(html, /<meta property="og:url" content="https:\/\/example.test\/pkg" \/>/);
  assert.match(html, /~400 human installs a week \(range 400–400, high confidence\) vs 1,234 npm downloads/);
});

test('prerender: without summary numbers the description is generic', () => {
  const html = prerenderHtml(SHELL, 'pkg', undefined, 'https://example.test/');
  assert.match(html, /How many of pkg&#39;s npm downloads are real human installs\?/);
});

test('prerender: "$&" in a name is not expanded by String#replace', () => {
  // Names are validated before this point, but the title replacement must stay literal regardless.
  const html = prerenderHtml(SHELL, '$&x', undefined, 'https://example.test/');
  assert.match(html, /<title>\$&amp;x: /);
});

const ldOf = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test('prerender: canonical, a static body inside #app and valid JSON-LD with a breadcrumb', () => {
  const html = prerenderHtml(SHELL, '@scope/pkg', row('@scope/pkg', 1234, 400, 'high'), 'https://example.test/sub/', {
    generated: '2026-11-03T15:43:12.558Z',
    related: ['other', '@scope/pkg'],
  });
  assert.equal(html.match(/rel="canonical"/g)?.length, 1);
  assert.match(html, /<link rel="canonical" href="https:\/\/example.test\/sub\/@scope\/pkg" \/>/);
  assert.match(html, /<div id="app"><div class="view">[\s\S]*<h1[^>]*><span class="pkg-name">@scope\/pkg<\/span><\/h1>/);
  assert.match(html, /npm counted 1,234 downloads of @scope\/pkg/);
  assert.match(html, /href="\/sub\/other"/); // related links use the base path
  assert.doesNotMatch(html, /href="\/sub\/@scope\/pkg"/); // never links to itself
  const [ld] = ldOf(html);
  const types = ld['@graph'].map((n: { '@type': string }) => n['@type']);
  assert.deepEqual(types, ['WebSite', 'WebPage', 'BreadcrumbList']);
  assert.equal(ld['@graph'][2].itemListElement[1].item, 'https://example.test/sub/@scope/pkg');
});

test('prerender: JSON-LD cannot be closed by a hostile description', () => {
  const html = homeHtml(SHELL, 'https://example.test/', { generated: 'x', humans: [{ ...row('a', 10, 5), description: '</script><b>' }] });
  assert.equal(ldOf(html).length, 1);
  assert.doesNotMatch(html.split('application/ld+json')[1], /<\/script><b>/);
});

test('home: canonical is the site root, featured cards link to package pages', () => {
  const html = homeHtml(SHELL, 'https://example.test/', { generated: '2026-11-03T00:00:00Z', humans: [row('zod', 100, 90)] });
  assert.match(html, /<link rel="canonical" href="https:\/\/example.test\/" \/>/);
  assert.match(html, /<a class="fcard" href="\/zod">/);
  assert.equal(ldOf(html)[0]['@graph'][1]['@type'], 'Dataset');
});

test('404 page: noindex, no canonical, no og:url', () => {
  const shell = SHELL.replace('<title>', '<link rel="canonical" href="https://example.test/" />\n<meta property="og:url" content="x" />\n<title>');
  const html = notFoundHtml(shell);
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  assert.doesNotMatch(html, /canonical|og:url/);
});

test('sitemap, robots.txt and llms.txt use the site URL', () => {
  const xml = sitemapXml(['https://example.test/', 'https://example.test/a&b'], '2026-11-03T15:43:12.558Z');
  assert.match(xml, /<url><loc>https:\/\/example.test\/a&amp;b<\/loc><lastmod>2026-11-03<\/lastmod><\/url>/);
  const robots = robotsTxt('https://example.test/');
  assert.match(robots, /User-agent: GPTBot/);
  assert.match(robots, /User-agent: ClaudeBot/);
  assert.match(robots, /Sitemap: https:\/\/example.test\/sitemap.xml/);
  assert.doesNotMatch(robots, /Disallow/);
  const llms = llmsTxt('https://example.test/', [{ name: 'zod', row: row('zod', 1000, 900, 'high') }]);
  assert.match(llms, /^# humanloads\n\n> /);
  assert.match(llms, /- \[zod\]\(https:\/\/example.test\/zod\): ~900 human installs\/week/);
  assert.match(llms, /https:\/\/example.test\/data\/summary.json/);
});

test('site config: default, trailing slash and custom domain', () => {
  assert.equal(resolveSiteUrl(''), resolveSiteUrl(undefined));
  assert.equal(resolveSiteUrl(''), 'https://humanloads.dev/');
  assert.equal(resolveSiteUrl('https://example.com'), 'https://example.com/');
  assert.equal(resolveSiteUrl(' https://example.com/x?q=1 '), 'https://example.com/x/');
  assert.throws(() => resolveSiteUrl('ftp://example.com/'));
  assert.equal(customDomain('https://example.com/'), 'example.com');
  assert.equal(customDomain(resolveSiteUrl('')), 'humanloads.dev');
  assert.equal(customDomain('https://user.github.io/repo/'), null);
});

test('methodologyHtml: canonical under the base, static article, TechArticle + FAQPage JSON-LD', () => {
  const html = methodologyHtml(SHELL, 'https://example.test/sub/', '2026-11-03T00:00:00Z');
  assert.match(html, /<link rel="canonical" href="https:\/\/example.test\/sub\/docs\/methodology" \/>/);
  assert.match(html, /<h1[^>]*>How humanloads estimates real installs<\/h1>/);
  assert.match(html, /href="\/sub\/"/); // links stay under the base path
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
  const types = ld['@graph'].map((n: { '@type': string }) => n['@type']);
  assert.deepEqual(types, ['WebSite', 'TechArticle', 'FAQPage', 'BreadcrumbList']);
});
