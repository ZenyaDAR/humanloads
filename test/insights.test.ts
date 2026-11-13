import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimate } from '../src/core/estimate.ts';
import { factsHtml, monthlyHtml, packageFacts, type PackageFacts } from '../src/core/insights.ts';
import { compareTitle, isIndexable, packageTitle } from '../src/core/seo.ts';
import { prerenderHtml } from '../scripts/data-lib.ts';
import type { FeaturedRow, RawPackageData } from '../src/core/types.ts';

const DAY_MS = 86_400_000;
const LAST = Date.parse('2026-10-31T00:00:00Z');
const dayAgo = (n: number) => new Date(LAST - n * DAY_MS).toISOString().slice(0, 10);

// 364 days of flat downloads: `early` per day until 91 days ago (where the 3-month window ends), `late` after that.
function pkg(early: number, late: number, extra: Partial<RawPackageData['registry']> = {}): RawPackageData {
  return {
    name: 'p',
    downloads: Array.from({ length: 364 }, (_, i) => ({ day: dayAgo(363 - i), downloads: 363 - i >= 91 ? early : late })),
    registry: {
      name: 'p',
      'dist-tags': { latest: '2.1.0' },
      time: {
        created: `${dayAgo(1000)}T00:00:00.000Z`,
        '1.0.0': `${dayAgo(1000)}T00:00:00.000Z`,
        '2.0.0': `${dayAgo(300)}T00:00:00.000Z`,
        '2.0.1': `${dayAgo(250)}T00:00:00.000Z`,
        '2.1.0-rc.1': `${dayAgo(210)}T00:00:00.000Z`,
        '2.1.0': `${dayAgo(200)}T00:00:00.000Z`,
      },
      ...extra,
    },
    versionsLastWeek: { '1.0.0': 300, '2.0.0': 500, '2.0.1': 100, '2.1.0-rc.1': 5, '2.1.0': 100 },
  };
}
const factsOf = (d: RawPackageData) => packageFacts(d, estimate(d))!;

test('facts: releases, gaps and the latest release, with pre-releases counted apart', () => {
  const f = factsOf(pkg(1000, 1000));
  assert.equal(f.asOf, dayAgo(0));
  assert.equal(f.firstPublished, dayAgo(1000));
  assert.deepEqual(f.lastRelease, { version: '2.1.0', day: dayAgo(200) });
  assert.equal(f.stableReleasesYear, 3);
  assert.equal(f.prereleasesYear, 1);
  assert.equal(f.medianGapDays, 50);
});

test('facts: same-day releases do not make a zero gap, and a year without releases reads naturally', () => {
  const d = pkg(1000, 1000);
  d.registry.time = { ...d.registry.time, '2.0.2': `${dayAgo(250)}T09:00:00.000Z`, '2.0.3': `${dayAgo(250)}T10:00:00.000Z` };
  assert.equal(factsOf(d).medianGapDays, 50);
  const idle = factsHtml('p', { ...factsOf(d), stableReleasesYear: 0, prereleasesYear: 0, medianGapDays: null });
  assert.match(idle, /There were no stable releases in the last 12 months\./);
});

test('facts text: a flat week does not claim bots, it would contradict the estimate on the same page', () => {
  const html = factsHtml('p', { ...factsOf(pkg(1000, 1000)), weekdayRatio: 1.27 });
  assert.match(html, /1\.27× the downloads of weekends, so there is no clear work-week rhythm/);
  assert.doesNotMatch(html, /automated/);
});

test('titles stay within 70 characters for long scoped names', () => {
  assert.equal(packageTitle('zod'), 'zod npm downloads: weekly stats and real installs · humanloads');
  assert.ok(packageTitle('@abhash-chakraborty/inyon-linux-arm64').length <= 70);
  assert.equal(packageTitle(`@scope/${'x'.repeat(50)}`), `@scope/${'x'.repeat(50)} npm downloads`); // the second fallback
  assert.equal(compareTitle(['react', 'vue']), 'react vs vue: npm downloads and real installs compared · humanloads');
  assert.equal(compareTitle(['@mui/material', '@chakra-ui/react']), '@mui/material vs @chakra-ui/react: npm downloads compared');
});

test('facts: growth compares whole windows and is null for a package too young to compare', () => {
  const up = factsOf(pkg(1000, 1500));
  assert.ok(Math.abs(up.growth3m! - 0.5) < 0.01);
  assert.ok(Math.abs(up.growth11m! - 0.5) < 0.01);
  const young = pkg(1000, 1000);
  young.registry.time = { ...young.registry.time, created: `${dayAgo(150)}T00:00:00.000Z` };
  const f = factsOf(young);
  assert.notEqual(f.growth3m, null);
  assert.equal(f.growth11m, null);
  assert.equal(factsOf(pkg(2, 2)).growth3m, null); // a few downloads a day: a percentage would be noise
});

test('facts: adoption ignores pre-releases and names the leading major', () => {
  const a = factsOf(pkg(1000, 1000)).adoption!;
  assert.equal(a.major, '2');
  assert.equal(a.isLatest, true);
  assert.equal(a.topVersion, '2.0.0');
  assert.ok(a.share > 0.5 && a.share <= 1);
});

test('facts: survive every real fixture, and stay JSON-safe', () => {
  for (const dir of ['nervegraph', 'react', 'lodash', 'zod', 'left-pad', 'request', 'is-thirteen', 'nodesecure__scanner']) {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${dir}/${f}`, import.meta.url), 'utf8'));
    const registry = read('registry.json');
    const data = { name: registry.name, downloads: read('downloads.json'), registry, versionsLastWeek: read('versions.json') };
    const f = packageFacts(data, estimate(data))!;
    assert.deepEqual(JSON.parse(JSON.stringify(f)), f, dir);
    const html = factsHtml(registry.name, f) + monthlyHtml(registry.name, f);
    assert.doesNotMatch(html, /NaN|undefined|Infinity|null/, dir);
    assert.match(html, /still maintained\?/, dir);
  }
});

test('monthly: whole months only, sums match the daily series, and none before the first publish', () => {
  const data = pkg(1000, 1000);
  const est = estimate(data);
  const m = packageFacts(data, est)!.monthly!;
  // The series runs 2025-11-02..2026-10-31: November 2025 is partial, October 2026 ends on the last day.
  assert.equal(m.months[0], '2025-12');
  assert.equal(m.months.at(-1), '2026-10');
  assert.equal(m.months.length, 11);
  for (const [i, month] of m.months.entries()) {
    const days = est.daily.filter((d) => d.day.startsWith(month));
    assert.equal(m.npm[i], days.reduce((s, d) => s + d.npm, 0), month);
    assert.equal(m.low[i], days.reduce((s, d) => s + d.low, 0), month);
    assert.equal(m.days[i], days.length, month);
  }
  // A package first published 100 days ago: its first month is partial, and earlier months hold no real data.
  const youngData = pkg(1000, 1000);
  youngData.registry.time.created = `${dayAgo(100)}T00:00:00.000Z`;
  const young = packageFacts(youngData, estimate(youngData))!.monthly!;
  assert.equal(young.months[0], '2026-08'); // created 2026-07-23: July is partial
  assert.ok(young.months.every((mo) => mo > dayAgo(100).slice(0, 7)));
  // Too small to say anything month by month.
  assert.equal(factsOf(pkg(5, 5)).monthly, null);
});

test('monthly text: newest first, an outage day does not read as a drop, old rows without the field render nothing', () => {
  const data = pkg(1000, 1000);
  data.downloads.find((d) => d.day === '2026-09-15')!.downloads = 0;
  const f = factsOf(data);
  assert.equal(f.monthly!.days[f.monthly!.months.indexOf('2026-09')], 29);
  const html = monthlyHtml('p', f);
  assert.ok(html.indexOf('Oct 2026') < html.indexOf('Dec 2025'));
  assert.doesNotMatch(html, /up \d|down \d/); // per-day change on a flat series, outage day left out
  assert.match(html, /within 10%/);
  // A quiet December is named as the holiday season, not left to read as a decline.
  const dip = pkg(1000, 1000);
  for (const d of dip.downloads) if (d.day.startsWith('2025-12')) d.downloads = 500;
  assert.match(monthlyHtml('p', factsOf(dip)), /quietest was Dec 2025 \(the holiday season\)/);
  assert.equal(monthlyHtml('p', { ...f, monthly: undefined }), '');
  assert.equal(monthlyHtml('p', undefined), '');
  assert.doesNotMatch(monthlyHtml('<b>', f), /<b>/);
});

test('facts text: verdict follows the release age and deprecation', () => {
  const base = factsOf(pkg(1000, 1000));
  const at = (day: number, extra: Partial<PackageFacts> = {}) =>
    factsHtml('p', { ...base, lastRelease: { version: '1.0.0', day: dayAgo(day) }, ...extra });
  assert.match(at(10), /Most likely yes/);
  assert.match(at(300), /Less clear/);
  assert.match(at(800), /Probably not actively/);
  assert.match(at(10, { deprecated: 'use q' }), /No: the latest version is marked deprecated/);
  // npm's deprecation message and the package name are untrusted.
  const evil = at(10, { deprecated: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(evil, /<img/);
  assert.doesNotMatch(factsHtml('<b>', base), /<b>/);
});

const SHELL = '<html><head><title>x</title></head><body><div id="app"></div></body></html>';
const row = (organicWeekly: number, facts?: PackageFacts): FeaturedRow => ({
  name: 'p', npmWeekly: organicWeekly * 2, organicWeekly, low: organicWeekly, high: organicWeekly, inflation: 0.5, confidence: 'high', ...(facts && { facts }),
});

test('indexing: pages under 1,000 real installs a week, or without numbers, are noindex', () => {
  assert.equal(isIndexable(undefined), false);
  assert.equal(isIndexable({ organicWeekly: 999 }), false);
  assert.equal(isIndexable({ organicWeekly: 1000 }), true);
  const noindex = /<meta name="robots" content="noindex" \/>/;
  assert.match(prerenderHtml(SHELL, 'p', row(999), 'https://example.test/'), noindex);
  assert.match(prerenderHtml(SHELL, 'p', undefined, 'https://example.test/'), noindex);
  assert.doesNotMatch(prerenderHtml(SHELL, 'p', row(1000), 'https://example.test/'), noindex);
});

test('prerender: facts appear on the page, and old summaries without facts still render', () => {
  const f = factsOf(pkg(1000, 1000));
  assert.match(prerenderHtml(SHELL, 'p', row(5000, f), 'https://example.test/'), /Is p still maintained\?[\s\S]*Is p still used\?[\s\S]*Monthly downloads of p/);
  assert.doesNotMatch(prerenderHtml(SHELL, 'p', row(5000), 'https://example.test/'), /still maintained/);
});
