import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInsights, dependencyChains, deprecatedRows, guideHtml, marketGrowth, topPages } from '../scripts/data-lib.ts';
import { DEPRECATED_GUIDE_PATH, GUIDES } from '../src/core/guides.ts';
import { clip } from '../src/core/html.ts';
import { CHAIN_GUIDE_PATH, chainHtml, factsHtml, type PackageFacts } from '../src/core/insights.ts';
import { dependencyPulls, maintenanceNote, trimRegistry } from '../src/core/sources.ts';
import type { FeaturedRow, InsightsFile } from '../src/core/types.ts';

const SHELL = '<!doctype html><html><head><title>x</title></head><body><div id="app"></div></body></html>';

const facts = (over: Partial<PackageFacts> = {}): PackageFacts => ({
  asOf: '2026-11-01', stableReleasesYear: 3, prereleasesYear: 0, medianGapDays: 90, growth3m: 0.1, growth11m: 0.4,
  adoption: null, weekdayRatio: null, mirrorsYear: 0, crawlersWeekly: 0, crawlerFloor: null,
  lastRelease: { version: '1.0.0', day: '2026-09-01' }, ...over,
});

const row = (name: string, npmWeekly: number, over: Partial<FeaturedRow> = {}): FeaturedRow => ({
  name, npmWeekly, organicWeekly: npmWeekly, low: npmWeekly, high: npmWeekly, inflation: 0, confidence: 'high', facts: facts(), ...over,
});

const top = (version: string, topShare = 0.9) => ({ adoption: { major: version.split('.')[0], isLatest: true, share: topShare, topVersion: version, topShare } });

test('maintenanceNote quotes a project about itself and ignores everything else', () => {
  const moment = '# [Moment.js](https://momentjs.com/)\n\n[![v][a]][b]\n\nA date library.\n\n> ⚠️ Moment.js is a legacy project, now in **maintenance mode**. New features\n> are not being accepted.';
  assert.equal(maintenanceNote('moment', moment), 'Moment.js is a legacy project, now in maintenance mode.');
  assert.equal(maintenanceNote('foo', 'Note: this package is no longer maintained.'), 'this package is no longer maintained.');
  assert.equal(maintenanceNote('@acme/foo', 'foo is unmaintained, sorry.'), 'foo is unmaintained, sorry.');
  for (const text of [
    'Node 12 is no longer supported.',
    'This package is a fork of bar, which is no longer maintained.',
    'bar is unmaintained, use this package instead.',
    'This package is actively maintained.',
    'The project supports maintenance mode for your database.',
    'This project is not maintained by or affiliated with Discord.',
    'This library is not developed by Google.',
    'foo is no longer supported on Node 12.',
    'The package is not maintained for Node 0.10.',
    'This project is no longer maintained by its original author.',
    'This project is no longer maintained. It is now maintained by the community at example.org.',
    // Real READMEs that once matched: anymatch and cli-table3.
    'This module has Bash-parity, please be aware that Windows-style backslashes are not supported as separators.',
    'foo is based on (and api compatible with) the original bar, and baz, which are both unmaintained.',
  ]) {
    assert.equal(maintenanceNote('foo', text), undefined, text);
  }
  assert.equal(maintenanceNote('foo', undefined), undefined);
  assert.equal(maintenanceNote('foo', 'x'.repeat(3000) + '\n\nThis project is unmaintained.'), undefined, 'only the top of the README counts');
});

test('clip cuts on a word boundary and marks the cut', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('much more comprehensive and powerful', 33), 'much more comprehensive and…');
  assert.equal(clip('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
});

test('trimRegistry carries the note, and the maintained answer leads with it over a recent release', () => {
  const reg = trimRegistry({ name: 'foo', 'dist-tags': { latest: '1.0.0' }, time: {}, readme: 'This project is in maintenance mode.' });
  assert.equal(reg.maintenanceNote, 'This project is in maintenance mode.');
  const html = factsHtml('foo', facts({ maintenanceNote: reg.maintenanceNote }));
  assert.match(html, /Only partly, by its own account/);
  assert.doesNotMatch(html, /Most likely yes/);
  assert.match(factsHtml('foo', facts()), /Most likely yes/);
});

test('used text compares growth with the median package, only given enough packages', () => {
  const market = { growth11m: 0.7, packages: 100 };
  const slow = factsHtml('foo', facts({ growth11m: 0.4 }), market, 5000);
  assert.match(slow, /median of the 100 packages we track, which lean towards today&#39;s most downloaded, is up 70%/);
  assert.match(slow, /so this one is behind that/);
  assert.match(factsHtml('foo', facts({ growth11m: 0.75 }), market, 5000), /about level with that/);
  assert.match(factsHtml('foo', facts({ growth11m: 2 }), market, 5000), /ahead of that/);
  assert.doesNotMatch(factsHtml('foo', facts(), { growth11m: 0.7, packages: 5 }, 5000), /median/);
  assert.doesNotMatch(factsHtml('foo', facts({ growth11m: null }), market, 5000), /median/);
  assert.doesNotMatch(factsHtml('foo', facts(), market, 35), /median/, 'a small count swings too much to compare');
});

test('dependencyPulls counts required dependencies only, per range, and ignores small ones', () => {
  const doc = {
    versions: {
      '2.0.0': { dependencies: { a: '^1.0.0', opt: '^1.0.0', tiny: '1' }, optionalDependencies: { opt: '^1.0.0' }, peerDependencies: { peer: '1' } },
      '1.0.0': { dependencies: { a: '^0.9.0', constructor: '1' } },
      '0.9.0': {},
    },
  };
  const pulls = dependencyPulls(doc, { '2.0.0': 90_000, '1.0.0': 20_000, '0.9.0': 500, gone: 7 });
  assert.deepEqual(pulls.a, { weekly: 110_000, range: '^1.0.0', rangeWeekly: 90_000 });
  assert.ok(Object.hasOwn(pulls, 'constructor')); // a dependency name, not an inherited property
  assert.ok(Object.hasOwn(pulls, 'tiny'));
  assert.ok(!Object.hasOwn(pulls, 'opt'));
  assert.ok(!Object.hasOwn(pulls, 'peer'));
  assert.equal(dependencyPulls({}, { '1.0.0': 5 }).a, undefined);
  assert.deepEqual(dependencyPulls({ versions: { '1.0.0': { dependencies: { small: '1' } } } }, { '1.0.0': 9_999 }), {}, 'below the minimum');
  const dep = { dependencies: { a: '1', b: '1' } };
  assert.deepEqual(Object.keys(dependencyPulls({ versions: { '1.0.0': { ...dep, bundleDependencies: ['a'] } } }, { '1.0.0': 90_000 })), ['b']);
  assert.deepEqual(Object.keys(dependencyPulls({ versions: { '1.0.0': { ...dep, bundledDependencies: ['b'] } } }, { '1.0.0': 90_000 })), ['a']);
  assert.deepEqual(dependencyPulls({ versions: { '1.0.0': { ...dep, bundleDependencies: true } } }, { '1.0.0': 90_000 }), {});
});

test('dependencyChains follows a single parent while the versions line up, and stops at a fork', () => {
  const child = row('is-number', 1_000_000, { facts: facts(top('7.0.0', 0.9)) });
  const mid = row('to-regex-range', 950_000, {
    facts: facts(top('5.0.1', 0.95)),
    pulls: { 'is-number': { weekly: 950_000, range: '^7.0.0', rangeWeekly: 900_000 } },
  });
  const up = row('fill-range', 930_000, {
    facts: facts(top('7.1.1', 0.95)),
    pulls: { 'to-regex-range': { weekly: 930_000, range: '^5.0.1', rangeWeekly: 900_000 } },
  });
  const a = row('a', 800_000, { pulls: { 'fill-range': { weekly: 600_000, range: '^7.0.0', rangeWeekly: 600_000 } } });
  const b = row('b', 500_000, { pulls: { 'fill-range': { weekly: 400_000, range: '^7.0.0', rangeWeekly: 400_000 } } });
  const chains = dependencyChains([child, mid, up, a, b]);
  assert.deepEqual(chains['is-number'].map((s) => s.name), ['is-number', 'to-regex-range', 'fill-range']);
  assert.equal(chains['is-number'][0].version, '7.0.0');
  assert.equal(chains['fill-range'], undefined, 'two big parents: a fork, no claim');
});

test('dependencyChains makes no claim when versions disagree, numbers differ, or the package is small', () => {
  const parent = (range: string, n: number) => row('p', n, { pulls: { c: { weekly: n, range, rangeWeekly: n } } });
  const c = row('c', 1_000_000, { facts: facts(top('7.0.0', 1)) });
  assert.deepEqual(Object.keys(dependencyChains([c, parent('^6.0.0', 1_000_000)])), [], 'range misses the top version');
  assert.deepEqual(Object.keys(dependencyChains([c, parent('^7.0.0', 400_000)])), [], 'parent explains too little');
  assert.deepEqual(Object.keys(dependencyChains([c, parent('^7.0.0', 2_000_000)])), [], 'parent far bigger than the child');
  assert.deepEqual(Object.keys(dependencyChains([row('c', 50_000, { facts: facts(top('7.0.0', 1)) }), parent('^7.0.0', 50_000)])), [], 'too small');
  assert.deepEqual(Object.keys(dependencyChains([c, parent('^7.0.0', 1_000_000)])), ['c']);
  // Its top version matches the parent, but that version is a small part of the package: typescript-eslint and its parser.
  const spread = row('c', 180_000_000, { facts: facts(top('8.0.0', 0.08)) });
  const narrow = row('p', 114_000_000, { pulls: { c: { weekly: 114_000_000, range: '8.0.0', rangeWeekly: 14_400_000 } } });
  assert.deepEqual(Object.keys(dependencyChains([spread, narrow])), [], 'parent explains under half of the downloads');
  // A cycle must end, not hang.
  const x = row('x', 1_000_000, { facts: facts(top('1.0.0', 1)), pulls: { y: { weekly: 1_000_000, range: '^1.0.0', rangeWeekly: 1_000_000 } } });
  const y = row('y', 1_000_000, { facts: facts(top('1.0.0', 1)), pulls: { x: { weekly: 1_000_000, range: '^1.0.0', rangeWeekly: 1_000_000 } } });
  assert.deepEqual(dependencyChains([x, y]).x.map((s) => s.name), ['x', 'y']);
});

test('chainHtml says it is an inference, escapes names and needs two steps', () => {
  assert.equal(chainHtml('a', undefined, '/'), '');
  assert.equal(chainHtml('a', [{ name: 'a', weekly: 1 }], '/'), '');
  const html = chainHtml('a<b', [{ name: 'a<b', version: '1.0.0', weekly: 1_500_000 }, { name: 'p', weekly: 1_400_000 }], '/');
  assert.match(html, /an inference from download counts/);
  assert.match(html, /a&lt;b/);
  assert.match(html, /1\.5M a week/);
  assert.match(html, new RegExp(`href="/${CHAIN_GUIDE_PATH}"`));
});

test('deprecatedRows: biggest first, without @types stubs, small packages or anything still alive', () => {
  const d = (name: string, n: number) => row(name, n, { facts: facts({ deprecated: `${name} is retired` }) });
  const rows = deprecatedRows([d('small', 9_999), d('b', 20_000), d('@types/x', 9_000_000), row('alive', 9_000_000), d('a', 50_000)]);
  assert.deepEqual(rows.map((r) => r.name), ['a', 'b']);
  assert.deepEqual(rows[0], { name: 'a', npmWeekly: 50_000, message: 'a is retired', lastRelease: '2026-09-01' });
});

test('marketGrowth takes the median of packages big enough to measure', () => {
  const m = marketGrowth([
    row('a', 5000, { facts: facts({ growth11m: 0.1 }) }),
    row('b', 5000, { facts: facts({ growth11m: 0.5 }) }),
    row('c', 5000, { facts: facts({ growth11m: 0.9 }) }),
    row('tiny', 10, { facts: facts({ growth11m: 50 }) }),
    row('new', 5000, { facts: facts({ growth11m: null }) }),
  ]);
  assert.deepEqual(m, { growth11m: 0.5, packages: 3 });
  assert.deepEqual(marketGrowth([]), { growth11m: null, packages: 0 });
});

test('topPages walks the whole ranking and stays in bounds', () => {
  const seen = new Set<number>();
  for (let day = 20_000; day < 20_006; day++) {
    const pages = topPages(day);
    assert.equal(pages.length, 5);
    for (const p of pages) {
      assert.ok(p >= 1 && p <= 30, String(p));
      seen.add(p);
    }
  }
  assert.equal(seen.size, 30);
});

test('data-backed guides stay out of indexes until there is data, and escape what maintainers wrote', () => {
  const guide = (path: string) => GUIDES.find((g) => g.path === path)!;
  const site = 'https://example.test/';
  for (const path of [DEPRECATED_GUIDE_PATH, CHAIN_GUIDE_PATH]) {
    const html = guideHtml(SHELL, site, guide(path), null);
    assert.match(html, /name="robots" content="noindex"/, path);
    assert.equal(html.match(/<h1/g)?.length, 1);
  }
  const deprecated = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, npmWeekly: 1_000_000, message: '<script>x</script> gone', lastRelease: '2020-01-02' }));
  const insights: InsightsFile = {
    generated: '2026-11-01T00:00:00Z', market: { growth11m: null, packages: 0 }, deprecated,
    chains: { 'is-number': [{ name: 'is-number', version: '7.0.0', weekly: 200_000_000 }, { name: 'to-regex-range', weekly: 190_000_000 }] },
  };
  const list = guideHtml(SHELL, site, guide(DEPRECATED_GUIDE_PATH), insights);
  assert.doesNotMatch(list, /noindex/);
  assert.match(list, /about <strong>10M<\/strong> times a week/);
  assert.match(list, /&lt;script&gt;x&lt;\/script&gt; gone/);
  assert.doesNotMatch(list, /<script>x/);
  assert.match(list, /href="\/p3"/);
  assert.match(list, /Jan 2020/);
  const chain = guideHtml(SHELL, site, guide(CHAIN_GUIDE_PATH), insights);
  assert.doesNotMatch(chain, /noindex/);
  assert.match(chain, /about <strong>200M<\/strong> downloads last week/);
  assert.match(chain, /href="\/to-regex-range"/);
  assert.match(chain, /npm explain is-number/);
  assert.deepEqual(Object.keys(buildInsights([], 'now')), ['generated', 'market', 'deprecated', 'chains']);
});
