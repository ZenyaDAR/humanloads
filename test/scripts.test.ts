import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  badgeFor, calibrate, compactCount, esc, homeHtml, llmsTxt, mergeCatalog, notFoundHtml, poolFailure, prerenderHtml, readPrevious, refreshPlan,
  robotsTxt, safeName, selectFeatured, sitemapXml, methodologyHtml, compareHtml, guideHtml,
} from '../scripts/data-lib.ts';
import { GUIDES } from '../src/core/guides.ts';
import { customDomain, resolveSiteUrl } from '../site.config.ts';
import { METHODOLOGY_DESCRIPTION } from '../src/core/methodology.ts';
import { HOME_DESCRIPTION, compareDescription, noiseText, numberCardsHtml, peopleAnswerHtml, packageDescription, quietAtScale, rangeText, roundCount } from '../src/core/seo.ts';
import type { PackageFacts } from '../src/core/insights.ts';
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
    assert.deepEqual(badgeFor({ organicWeekly: 5, confidence }), { schemaVersion: 1, label: 'real installs/week', message: '≈ 5', color });
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

// Settled: published 100 days before the data ends, last release 30 days before.
const settled = (r: FeaturedRow, over: Partial<PackageFacts> = {}): FeaturedRow => ({
  ...r,
  facts: {
    asOf: '2026-11-04', firstPublished: '2026-07-27', lastRelease: { version: '1.0.0', day: '2026-10-05' },
    stableReleasesYear: 1, prereleasesYear: 0, medianGapDays: null, growth3m: null, growth11m: null, adoption: null,
    weekdayRatio: null, mirrorsYear: 0, crawlersWeekly: 0, crawlerFloor: 0, ...over,
  },
});

test('featured: noisiest needs npm >= 100 and noise >= 0.3, sorted by noise then npm', () => {
  const { noisiest } = selectFeatured([
    settled(row('ok-50', 1000, 500)),
    settled(row('edge-30', 100, 70)), // exactly 100 and 0.3: included
    settled(row('tiny', 99, 0)),
    settled(row('barely', 1000, 710)),
    settled(row('ok-90-small', 200, 20)),
    settled(row('ok-90-big', 2000, 200)), // same share, bigger npm wins the tie
  ]);
  assert.deepEqual(noisiest.map((r) => r.name), ['ok-90-big', 'ok-90-small', 'ok-50', 'edge-30']);
});

test('featured: noisiest leaves out fresh releases, young, deprecated, too-new and low-confidence packages', () => {
  const noisy = (name: string) => row(name, 1000, 100);
  const { noisiest } = selectFeatured([
    settled(noisy('keeper')),
    settled(noisy('released-today'), { lastRelease: { version: '2.0.0', day: '2026-11-05' } }),
    settled(noisy('released-recently'), { lastRelease: { version: '2.0.0', day: '2026-10-25' } }),
    settled(noisy('young'), { firstPublished: '2026-10-10' }),
    settled(noisy('nightly-prereleases'), { lastPublish: '2026-11-03' }),
    settled(noisy('abandoned'), { deprecated: 'do not use' }),
    settled({ ...noisy('too-new'), tooNew: true }),
    settled(row('unsure', 1000, 100, 'low')),
    noisy('no-facts'),
  ]);
  assert.deepEqual(noisiest.map((r) => r.name), ['keeper']);
});

test('featured: one package per scope, never padded', () => {
  const rows = [settled(row('@a/x', 1000, 10)), settled(row('@a/y', 1000, 20)), settled(row('@b/z', 1000, 30)), settled(row('plain', 1000, 40))];
  assert.deepEqual(selectFeatured(rows).noisiest.map((r) => r.name), ['@a/x', '@b/z', 'plain']);
  assert.deepEqual(selectFeatured([settled(row('a', 1000, 1000))]).noisiest, []);
});

test('featured: examples are the biggest by npm count', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(`p${i}`, i * 100, 1));
  assert.deepEqual(selectFeatured(rows).examples, ['p5', 'p4', 'p3', 'p2']);
});

// --- Rolling catalog ---

const inCatalog = (name: string, updated: string, organic = 10): FeaturedRow => ({ ...row(name, 100, organic), updated });
const catalogOf = (...rows: FeaturedRow[]) => Object.fromEntries(rows.map((r) => [r.name, r]));
const NOW = '2026-11-05T00:00:00.000Z';
const merge = (previous: Record<string, FeaturedRow>, fresh: FeaturedRow[], opts: { gone?: string[]; blocked?: string[]; keep?: string[]; max?: number } = {}) =>
  mergeCatalog(previous, new Map(fresh.map((r) => [r.name, r])), {
    gone: new Set(opts.gone), blocked: new Set(opts.blocked), keep: new Set(opts.keep), now: NOW, max: opts.max,
  });

test('refreshPlan: required names first, then new names and the stalest rows sharing the budget', () => {
  const previous = catalogOf(inCatalog('newer', '2026-11-04'), inCatalog('oldest', '2026-10-01'), inCatalog('older', '2026-10-20'));
  assert.deepEqual(refreshPlan(['must'], ['new1', 'new2', 'new3', 'older'], previous, 5), ['must', 'new1', 'new2', 'oldest', 'older']);
});

test('refreshPlan: spare budget goes to more new names, and required names always run', () => {
  assert.deepEqual(refreshPlan([], ['a', 'a', 'b', 'c'], {}, 3), ['a', 'b', 'c']);
  assert.deepEqual(refreshPlan(['x', 'y', 'z'], ['a'], {}, 2), ['x', 'y', 'z']);
});

test('refreshPlan: every row gets refreshed in rotation', () => {
  let previous = catalogOf(...Array.from({ length: 10 }, (_, i) => inCatalog(`p${i}`, `2026-10-${10 + i}`)));
  const seen = new Set<string>();
  for (let night = 0; night < 4; night++) {
    for (const name of refreshPlan([], [], previous, 3)) {
      seen.add(name);
      previous = { ...previous, [name]: inCatalog(name, `2026-11-0${night + 1}`) };
    }
  }
  assert.equal(seen.size, 10);
});

test('refreshPlan: an object-prototype name is an ordinary new name', () => {
  assert.deepEqual(refreshPlan([], ['constructor'], {}, 3), ['constructor']);
});

test('readPrevious: rows carry over only within a model version; other names stay pending', () => {
  const rows = catalogOf(inCatalog('a', '2026-11-01'));
  assert.deepEqual(readPrevious({ model: 'v2', packages: rows, pending: ['b'], archived: ['c'] }, 'v2'), { rows, pending: ['b'], archived: ['c'], badgeList: {} });
  assert.deepEqual(readPrevious({ model: 'v1', packages: rows, pending: ['b'], archived: ['c'] }, 'v2'), { rows: {}, pending: ['a', 'b'], archived: ['c'], badgeList: {} });
  assert.deepEqual(readPrevious({ packages: rows }, 'v2'), { rows: {}, pending: ['a'], archived: [], badgeList: {} }); // the format before versions
});

test('readPrevious: a file without packages is an error, not an empty catalog', () => {
  assert.throws(() => readPrevious({}, 'v2'));
  assert.throws(() => readPrevious(null, 'v2'));
});

test('mergeCatalog: a row fetched tonight is not evicted the same night', () => {
  const previous = catalogOf(inCatalog('old-small', '2026-11-01', 5), inCatalog('old-big', '2026-11-01', 500));
  const merged = merge(previous, [inCatalog('new-tiny', NOW, 1)], { max: 2 });
  assert.deepEqual(Object.keys(merged).sort(), ['new-tiny', 'old-big']);
});

test('badge and llms.txt never read "0" for a package too new to tell', () => {
  assert.equal(badgeFor({ organicWeekly: 0, confidence: 'low', tooNew: true }).message, 'too new');
  const llms = llmsTxt('https://example.test/', [{ name: 'p', row: { ...row('p', 607, 0, 'low'), high: 607, tooNew: true } }]);
  assert.match(llms, /p\): too new to tell, \(range 0–607/);
});

test('mergeCatalog: yesterday\'s pages survive a night they are not refreshed', () => {
  const merged = merge(catalogOf(inCatalog('kept', '2026-11-01')), [inCatalog('new', NOW)]);
  assert.deepEqual(Object.keys(merged).sort(), ['kept', 'new']);
});

test('mergeCatalog: fresh rows replace old ones; unpublished and blocked names leave', () => {
  const previous = catalogOf(inCatalog('a', '2026-11-01'), inCatalog('gone', '2026-11-01'), inCatalog('bad', '2026-11-01'));
  const merged = merge(previous, [inCatalog('a', NOW)], { gone: ['gone'], blocked: ['bad'] });
  assert.deepEqual(Object.keys(merged), ['a']);
  assert.equal(merged.a.updated, NOW);
});

test('mergeCatalog: rows nobody could refresh for weeks leave, except required ones', () => {
  const previous = catalogOf(inCatalog('stale', '2026-09-01'), inCatalog('stale-kept', '2026-09-01'), inCatalog('ok', '2026-10-15'));
  assert.deepEqual(Object.keys(merge(previous, [], { keep: ['stale-kept'] })).sort(), ['ok', 'stale-kept']);
});

test('mergeCatalog: past the cap the smallest by npm count leave first, never the required ones', () => {
  const sized = (name: string, npm: number, organic: number): FeaturedRow => ({ ...row(name, npm, organic), updated: '2026-11-01' });
  // "noisy" has the fewest real installs, but it is what the homepage list is made of.
  const previous = catalogOf(sized('tiny-kept', 10, 1), sized('small', 100, 90), sized('mid', 200, 180), sized('noisy', 5000, 5));
  assert.deepEqual(Object.keys(merge(previous, [], { keep: ['tiny-kept'], max: 2 })).sort(), ['noisy', 'tiny-kept']);
});

// --- Rounding and cards ---

test('noiseText: one wording everywhere', () => {
  assert.equal(noiseText(1000, 999.5), 'under 1%');
  assert.equal(noiseText(1000, 100), '90%');
  assert.equal(noiseText(607, 0, true), 'unknown yet');
  assert.equal(noiseText(0, 0), 'unknown yet');
});

test('cards: while evidence is loading the pill does not claim a level', () => {
  const html = numberCardsHtml({ npm: 5000, organic: 4000, low: 3900, high: 4100, confidence: 'medium', checking: true });
  assert.match(html, /checking evidence/);
  assert.doesNotMatch(html, /medium confidence/);
});

test('the people question is answered without inventing a number of people', () => {
  const huge = peopleAnswerHtml('pkg', { npm: 733_000_000, organic: 732_999_000, low: 732_000_000, high: 733_000_000, confidence: 'high' });
  assert.match(huge, /How many people use pkg\?/);
  assert.match(huge, /Nobody can count people exactly/);
  assert.match(huge, /far smaller/);
  const small = peopleAnswerHtml('pkg', { npm: 1000, organic: 100, low: 80, high: 120, confidence: 'medium' });
  assert.match(small, /about 80–120 look like real installs/);
  assert.match(small, /Noise is 90%/);
  assert.match(peopleAnswerHtml('pkg', { npm: 607, organic: 0, low: 0, high: 607, confidence: 'low', tooNew: true }), /too new/);
});

test('guides and the home FAQ: within search limits, in the sitemap route, with valid structured data', () => {
  for (const g of GUIDES) {
    assert.ok(g.title.length <= 75, g.title);
    assert.ok(g.description.length >= 25 && g.description.length <= 160, `${g.description.length}: ${g.description}`);
    assert.match(g.path, /^docs\//); // a slash without @scope can't be a package name
    const html = guideHtml(SHELL, 'https://example.test/', g);
    assert.equal(html.match(/<h1/g)?.length, 1);
    assert.match(html, new RegExp(`rel="canonical" href="https://example.test/${g.path}"`));
    assert.deepEqual(ldOf(html)[0]['@graph'].map((n: { '@type': string }) => n['@type']), ['WebSite', 'TechArticle', 'BreadcrumbList']);
  }
  const home = homeHtml(SHELL, 'https://example.test/', { popular: ['zod'] });
  assert.match(home, /href="\/zod"/);
  assert.match(home, /How many people use my npm package\?/);
  assert.ok(ldOf(home)[0]['@graph'].some((n: { '@type': string }) => n['@type'] === 'FAQPage'));
});

test('roundCount keeps exact numbers under 1,000 and three digits above', () => {
  assert.equal(roundCount(0), '0');
  assert.equal(roundCount(999), '999');
  assert.equal(roundCount(1234), '1.23K');
  assert.equal(roundCount(733_319_207), '733M');
});

test('rangeText collapses when both ends round alike', () => {
  assert.equal(rangeText(733_265_046, 733_323_330), '733M');
  assert.equal(rangeText(0, 5), '0–5');
  assert.equal(rangeText(1024, 1100), '1.02K–1.1K');
});

test('cards: at scale there is no best guess, only how little was filtered', () => {
  assert.equal(quietAtScale(733_323_330, 733_319_207), true);
  assert.equal(quietAtScale(144_088_077, 113_188_691), false); // a real 21% difference stays visible
  assert.equal(quietAtScale(5000, 5000), false);
  const html = numberCardsHtml({ npm: 733_323_330, organic: 733_319_207, low: 733_265_046, high: 733_323_330, confidence: 'high' });
  assert.match(html, /≈ <mark>733M<\/mark>/);
  assert.match(html, /noise under 1%/);
  assert.doesNotMatch(html, /best guess|733,319,207|humans/);
  assert.match(html, /not a head count/);
});

test('cards: a new package reads "too new to tell", not "0"', () => {
  const html = numberCardsHtml({ npm: 607, organic: 0, low: 0, high: 607, confidence: 'low', tooNew: true });
  assert.match(html, /too new to tell/);
  assert.match(html, /<mark>0–607<\/mark>/);
  assert.doesNotMatch(html, /best guess/);
});

test('no page labels a number as humans', () => {
  const r = settled(row('pkg', 5000, 4000, 'high'));
  const pages = [
    prerenderHtml(SHELL, 'pkg', r, 'https://example.test/'),
    prerenderHtml(SHELL, 'pkg', undefined, 'https://example.test/'),
    homeHtml(SHELL, 'https://example.test/', { examples: ['pkg'], noisiest: [r] }),
    compareHtml(SHELL, ['a', 'b'], [r, r], 'https://example.test/'),
    compareHtml(SHELL, ['a', 'b'], [r, undefined], 'https://example.test/'),
    llmsTxt('https://example.test/', [{ name: 'pkg', row: r }]),
  ];
  for (const page of pages) {
    assert.doesNotMatch(page.replace(/human<span[^>]*>loads|humanloads|class="[^"]*"/g, ''), /\bhumans?\b/i, page.slice(0, 200));
  }
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

test('calibrate: ignores an implausibly high floor, keeps the ceiling itself', () => {
  const withFloor = (weekly: number): RawPackageData => ({
    name: 'c',
    downloads: [{ day: dayAt(70), downloads: weekly }],
    registry: { name: 'c', 'dist-tags': {}, time: { '1.0.0': dayAt(0) + 'T00:00:00Z' } },
    versionsLastWeek: { '1.0.0': weekly },
  });
  assert.equal(calibrate(withFloor(100), 'c')?.floorPerVersion, 100);
  assert.equal(calibrate(withFloor(101), 'c'), null);
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
  assert.match(html, /pkg npm downloads: 1,234 a week on npm, about 400 real installs after removing mirrors and crawlers \(high confidence\)/);
});

test('prerender: big numbers are compact in the description', () => {
  const html = prerenderHtml(SHELL, 'pkg', { ...row('pkg', 446_662_406, 446_650_334), low: 446_608_065, high: 446_662_406 }, 'https://example.test/');
  assert.match(html, /446\.7M a week on npm, about 447M real installs/);
});

test('prerender: without summary numbers the description is generic', () => {
  const html = prerenderHtml(SHELL, 'pkg', undefined, 'https://example.test/');
  assert.match(html, /Check pkg npm downloads and real installs/);
});

test('prerender: "$&" in a name is not expanded by String#replace', () => {
  // Names are validated before this point, but the title replacement must stay literal regardless.
  const html = prerenderHtml(SHELL, '$&x', undefined, 'https://example.test/');
  assert.match(html, /<title>\$&amp;x npm downloads/);
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
  const html = homeHtml(SHELL, 'https://example.test/', { generated: 'x', noisiest: [{ ...row('a', 10, 5), description: '</script><b>' }] });
  assert.equal(ldOf(html).length, 1);
  assert.doesNotMatch(html.split('application/ld+json')[1], /<\/script><b>/);
});

test('home: canonical is the site root, featured cards link to package pages', () => {
  const html = homeHtml(SHELL, 'https://example.test/', { generated: '2026-11-03T00:00:00Z', noisiest: [row('zod', 100, 90)] });
  assert.match(html, /<link rel="canonical" href="https:\/\/example.test\/" \/>/);
  assert.match(html, /<a class="fcard" href="\/zod">/);
  const dataset = ldOf(html)[0]['@graph'][1];
  assert.equal(dataset['@type'], 'Dataset');
  assert.ok(dataset.license && dataset.creator.name); // optional in Search Console, but flagged when missing
});

test('meta descriptions stay within 160 characters, even with very long package names', () => {
  const long = `@${'a'.repeat(100)}/${'b'.repeat(100)}`;
  const row = { organicWeekly: 1_500_000, low: 1_400_000, high: 1_600_000, npmWeekly: 2_000_000, confidence: 'medium' as Confidence };
  const all = [
    HOME_DESCRIPTION, METHODOLOGY_DESCRIPTION,
    packageDescription(long), packageDescription(long, row),
    packageDescription('@typescript-eslint/typescript-estree', row),
    compareDescription([long, 'b']), compareDescription([long, 'b'], [row, row]),
    compareDescription(['express', 'fastify', 'koa'], [row, row, row]),
  ];
  for (const d of all) assert.ok(d.length >= 25 && d.length <= 160, `${d.length}: ${d}`);
  // Names short enough to fit keep the whole sentence, not a clipped one.
  assert.doesNotMatch(packageDescription('@typescript-eslint/typescript-estree', row), /…$/);
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
  const perUrl = sitemapXml(['https://example.test/a'], '2026-11-03T00:00:00Z', { 'https://example.test/a': '2026-10-20T00:00:00Z' });
  assert.match(perUrl, /<lastmod>2026-10-20<\/lastmod>/); // a row's own refresh date beats the build date
  const robots = robotsTxt('https://example.test/');
  assert.match(robots, /User-agent: GPTBot/);
  assert.match(robots, /User-agent: ClaudeBot/);
  assert.match(robots, /Sitemap: https:\/\/example.test\/sitemap.xml/);
  assert.doesNotMatch(robots, /Disallow/);
  const llms = llmsTxt('https://example.test/', [{ name: 'zod', row: row('zod', 1000, 900, 'high') }]);
  assert.match(llms, /^# humanloads\n\n> /);
  assert.match(llms, /- \[zod\]\(https:\/\/example.test\/zod\): ~900 real installs\/week/);
  assert.match(llms, /https:\/\/example.test\/data\/summary.json/);
  assert.doesNotMatch(llms, /## README badge/);
  const withBadge = llmsTxt('https://example.test/', [], undefined, [], [], 'https://badge.example.test/');
  assert.match(withBadge, /\(https:\/\/img\.shields\.io\/endpoint\?url=https:\/\/badge\.example\.test\/badge\/<package-name>\)\]\(https:\/\/example\.test\/<package-name>\)/);
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
  assert.match(html, /<h1[^>]*>How humanloads filters npm downloads<\/h1>/);
  assert.match(html, /href="\/sub\/"/); // links stay under the base path
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
  const types = ld['@graph'].map((n: { '@type': string }) => n['@type']);
  assert.deepEqual(types, ['WebSite', 'TechArticle', 'FAQPage', 'BreadcrumbList']);
});

test('compareHtml: canonical, numbers side by side, answer by real installs, JSON-LD about both', () => {
  const html = compareHtml(SHELL, ['a', 'b'], [row('a', 5000, 4000, 'high'), row('b', 9000, 1000, 'medium')], 'https://example.test/sub/', {
    others: [['c', 'd']],
  });
  assert.match(html, /<link rel="canonical" href="https:\/\/example.test\/sub\/compare\/a,b" \/>/);
  assert.match(html, /<title>a vs b: npm downloads and real installs compared/);
  assert.match(html, /a vs b npm downloads: 5,000 vs 9,000 a week on npm, about 4K vs 1K real installs after removing/);
  assert.match(html, /By real installs, /);
  assert.match(html, /<strong>a<\/strong> is ahead of b by about 4\.0×/);
  assert.match(html, /href="\/sub\/compare\/c,d"/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
  assert.deepEqual(ld['@graph'][1].about.map((x: { name: string }) => x.name), ['a', 'b']);
});

test('compareHtml: a missing number falls back to generic text without a table', () => {
  const html = compareHtml(SHELL, ['a', 'b'], [row('a', 5000, 4000), undefined], 'https://example.test/');
  assert.doesNotMatch(html, /cmp-table/);
  assert.match(html, /a vs b: npm weekly downloads compared week by week/);
});
