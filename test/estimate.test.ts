import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { awaitingEvidence, estimate } from '../src/core/estimate.ts';
import type { Calibration, Confidence, DailyDownloads, Estimate, Evidence, RawPackageData } from '../src/core/types.ts';

const FIXTURES = ['nervegraph', 'react', 'lodash', 'zod', 'left-pad', 'request', 'is-thirteen', 'nodesecure__scanner'];

// Mirrors scripts/fetch-fixture.mjs: downloads.json, registry.json, versions.json per package dir.
function loadFixture(dir: string): RawPackageData {
  const read = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${dir}/${f}`, import.meta.url), 'utf8'));
  const registry = read('registry.json');
  return { name: registry.name, downloads: read('downloads.json'), registry, versionsLastWeek: read('versions.json') };
}

const DAY_MS = 86_400_000;
const START = Date.parse('2026-01-05T00:00:00Z'); // a Monday
const dayAt = (i: number) => new Date(START + i * DAY_MS).toISOString().slice(0, 10);
const isoAt = (i: number) => dayAt(i) + 'T12:00:00.000Z';

// n days; value(i) gets the day index. Weekends (i % 7 in 5,6) are scaled by `weekend`.
function series(n: number, value: (i: number) => number, weekend = 0.6): DailyDownloads[] {
  return Array.from({ length: n }, (_, i) => ({
    day: dayAt(i),
    downloads: Math.round(value(i) * (i % 7 >= 5 ? weekend : 1)),
  }));
}

function raw(
  downloads: DailyDownloads[],
  time: Record<string, string> = {},
  versionsLastWeek: Record<string, number> = {},
): RawPackageData {
  return {
    name: 'synthetic',
    downloads,
    registry: { name: 'synthetic', 'dist-tags': {}, time: { created: isoAt(0), modified: isoAt(0), ...time } },
    versionsLastWeek,
  };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

function assertInvariants(e: Estimate, inputLength: number, label: string): void {
  assert.equal(e.daily.length, inputLength, `${label}: daily length`);
  const lw = e.lastWeek;
  assert.ok(lw.low <= lw.organic && lw.organic <= lw.high, `${label}: lastWeek low<=organic<=high ${JSON.stringify(lw)}`);
  for (const d of e.daily) {
    assert.ok(d.low <= d.organic && d.organic <= d.high, `${label} ${d.day}: low<=organic<=high ${JSON.stringify(d)}`);
    assert.ok(d.organic >= 0 && d.organic <= d.npm, `${label} ${d.day}: 0<=organic<=npm ${JSON.stringify(d)}`);
    assert.ok(d.cleaned <= d.npm, `${label} ${d.day}: cleaned<=npm ${JSON.stringify(d)}`);
  }
  const last7 = e.daily.slice(-7);
  for (const k of ['npm', 'organic', 'low', 'high'] as const) {
    assert.equal(lw[k], sum(last7.map((d) => d[k])), `${label}: lastWeek.${k} equals sum of last 7 days`);
  }
  for (const [k, v] of Object.entries(e.breakdown)) {
    if (v === null) continue;
    assert.ok(Number.isFinite(v) && v >= 0, `${label}: breakdown.${k}=${v}`);
  }
}

function assertVersionsNewestFirst(e: Estimate, time: Record<string, unknown>, label: string): void {
  const t = e.versions.map((v) => {
    const iso = time[v.version];
    return typeof iso === 'string' ? iso : '';
  });
  for (let i = 1; i < t.length; i++) assert.ok(t[i - 1] >= t[i], `${label}: versions newest first at ${i}`);
}

// --- Fixtures ---

for (const dir of FIXTURES) {
  test(`fixture ${dir}: invariants hold`, () => {
    const data = loadFixture(dir);
    const e = estimate(data);
    assertInvariants(e, data.downloads.length, dir);
    assertVersionsNewestFirst(e, data.registry.time, dir);
  });
}

test('fixture nervegraph: organic is 0-6 per week with low confidence', () => {
  const e = estimate(loadFixture('nervegraph'));
  assert.ok(e.lastWeek.organic >= 0 && e.lastWeek.organic <= 6, `organic=${e.lastWeek.organic}`);
  assert.equal(e.confidence, 'low');
});

test('fixture nervegraph: the weekly range has width (count noise)', () => {
  const lw = estimate(loadFixture('nervegraph')).lastWeek;
  assert.ok(lw.high > lw.low, JSON.stringify(lw));
});

for (const dir of ['react', 'lodash', 'zod']) {
  test(`fixture ${dir}: organic is at least 90% of npm; high confidence needs evidence`, () => {
    const data = loadFixture(dir);
    const e = estimate(data);
    assert.ok(e.lastWeek.organic >= 0.9 * e.lastWeek.npm, `organic=${e.lastWeek.organic} npm=${e.lastWeek.npm}`);
    assert.equal(e.confidence, 'medium');
    assert.equal(estimate(data, { evidence: evidence({ dependentPackages: 5 }) }).confidence, 'high');
  });
}

// --- Step A: publish spikes ---

const FLAT = (i: number) => 5 + (i % 3 === 0 ? 1 : 0); // ~5/day with a little jitter
const PUBLISH_DAY = 60;

test('spike removal: most of a +300 publish-day spike goes to mirrors', () => {
  const s = series(120, FLAT);
  s[PUBLISH_DAY].downloads += 300;
  const e = estimate(raw(s, { '1.0.0': isoAt(PUBLISH_DAY) }));
  assert.ok(e.breakdown.mirrorsTotal >= 270 && e.breakdown.mirrorsTotal <= 305, `mirrorsTotal=${e.breakdown.mirrorsTotal}`);
});

test('spike removal: nothing goes to mirrors without a publish', () => {
  const e = estimate(raw(series(120, FLAT)));
  assert.equal(e.breakdown.mirrorsTotal, 0);
});

test('spike removal: a spike on a day with no publish is left alone', () => {
  const s = series(120, FLAT);
  s[PUBLISH_DAY].downloads += 300;
  assert.equal(estimate(raw(s)).breakdown.mirrorsTotal, 0);
});

test('spike removal: steady growth with regular publishes is not clipped', () => {
  const s = series(200, (i) => 50 + 5 * i);
  const time: Record<string, string> = {};
  for (let i = 10; i < 200; i += 14) time[`1.${i}.0`] = isoAt(i);
  const e = estimate(raw(s, time));
  const growth = s.at(-1)!.downloads - s[0].downloads;
  assert.ok(e.breakdown.mirrorsTotal <= 0.01 * growth, `mirrorsTotal=${e.breakdown.mirrorsTotal} growth=${growth}`);
});

// Popular package with a 2.5x weekday/weekend swing and two runs of npm outages, as in October 2026. Most weekdays nearby
// are gone, so a fallback that ignores the weekday lands on weekend levels. Fails on the old fallback: it cut 6,000.
const WEEKDAY = 2500;
const outageBefore = (publishAt: number, days: number) => {
  const s = Array.from({ length: days }, (_, i) => ({ day: dayAt(i), downloads: i % 7 >= 5 ? 1000 : WEEKDAY }));
  for (let i = publishAt - 14; i <= publishAt - 4; i++) if (i !== publishAt - 10 && i !== publishAt - 9) s[i].downloads = 0;
  return s;
};

test('spike removal: outages around a publish do not clip an ordinary weekday', () => {
  // Regression: axios lost 21% when the neighbouring-day fallback mixed in weekend levels. Series ends before +7 exists.
  const publishAt = 56 + 1; // a Tuesday
  const e = estimate(raw(outageBefore(publishAt, publishAt + 6), { '1.0.0': isoAt(publishAt) }));
  assert.equal(e.breakdown.mirrorsTotal, 0);
});

test('spike removal: a level that rose recently is not clipped against older weeks', () => {
  const publishAt = 57;
  const s = Array.from({ length: publishAt + 6 }, (_, i) => ({ day: dayAt(i), downloads: i < publishAt - 16 ? 100 : 300 }));
  s[publishAt - 7].downloads = 0;
  s[publishAt - 14].downloads = 0;
  assert.equal(estimate(raw(s, { '1.0.0': isoAt(publishAt) })).breakdown.mirrorsTotal, 0);
});

test('spike removal: a real spike is still cut when the nearby weekdays are outages', () => {
  const publishAt = 57;
  const s = outageBefore(publishAt, publishAt + 6);
  s[publishAt].downloads = 20 * WEEKDAY;
  const e = estimate(raw(s, { '1.0.0': isoAt(publishAt) }));
  assert.equal(e.breakdown.mirrorsTotal, 19 * WEEKDAY);
});

test('range: the upper bound keeps a spike cut in the last week, which may hold real users', () => {
  const s = series(60, () => 100, 1);
  s[57].downloads = 5000;
  const time: Record<string, string> = { '2.0.0': isoAt(57) };
  const v: Record<string, number> = { '2.0.0': 5500 };
  for (let i = 0; i < 5; i++) [time[`0.${i}.0`], v[`0.${i}.0`]] = [isoAt(i), 3];
  const e = estimate(raw(s, time, v));
  assert.equal(e.breakdown.mirrorsTotal, 4900);
  assert.ok(e.lastWeek.organic <= 700, JSON.stringify(e.lastWeek));
  assert.ok(e.lastWeek.high >= 5500, JSON.stringify(e.lastWeek));
  assertInvariants(e, s.length, 'kept spike');
});

// --- New packages ---

const newPackage = () =>
  raw(
    [...Array.from({ length: 58 }, (_, i) => ({ day: dayAt(i), downloads: 0 })), { day: dayAt(58), downloads: 607 }],
    { '1.0.0': isoAt(58) },
    { '1.0.0': 607 },
  );

test('too new: no fake zero, the range reaches the whole count', () => {
  const e = estimate(newPackage());
  assert.equal(e.tooNew, true);
  assert.equal(e.confidence, 'low');
  assert.equal(e.lastWeek.low, 0);
  assert.equal(e.lastWeek.high, 607);
  assert.ok(e.notes.some((n) => n.includes('too little history')), JSON.stringify(e.notes));
});

test('too new: days before the first publish are not called npm outages', () => {
  assert.ok(!estimate(newPackage()).notes.some((n) => n.includes('outage')));
});

test('too new: zeros after the first spike are not called npm outages', () => {
  const s = Array.from({ length: 60 }, (_, i) => ({ day: dayAt(i), downloads: i >= 50 && i < 54 ? 150 : 0 }));
  assert.ok(!estimate(raw(s, { '1.0.0': isoAt(50) })).notes.some((n) => n.includes('outage')));
});

test('too new: the top of the range is the whole count even when per-version counts lag or are missing', () => {
  const s = Array.from({ length: 60 }, (_, i) => ({ day: dayAt(i), downloads: i >= 57 ? 60 : 0 }));
  for (const versions of [{}, { '1.0.0': 100 }] as Record<string, number>[]) {
    const lw = estimate(raw(s, { '1.0.0': isoAt(57) }, versions)).lastWeek;
    assert.equal(lw.high, 180, JSON.stringify(lw));
    assert.equal(lw.low, 0, JSON.stringify(lw));
  }
});

test('too new: no weekday rhythm from a few real days', () => {
  const s = Array.from({ length: 60 }, (_, i) => ({ day: dayAt(i), downloads: i >= 52 && i % 7 < 5 ? 500 : 0 }));
  const time = { '1.0.0': isoAt(52) };
  assert.ok(!estimate(raw(s, time, { '1.0.0': 2000 })).notes.some((n) => n.includes('Weekday')));
});

test('too new: evidence cannot raise confidence', () => {
  assert.equal(estimate(newPackage(), { evidence: RICH_EVIDENCE }).confidence, 'low');
});

test('too new: ends two weeks after the first publish', () => {
  const s = Array.from({ length: 30 }, (_, i) => ({ day: dayAt(i), downloads: 5 }));
  const lastDay = 29;
  assert.equal(estimate(raw(s, { '1.0.0': isoAt(lastDay - 13) })).tooNew, true);
  assert.equal(estimate(raw(s, { '1.0.0': isoAt(lastDay - 14) })).tooNew, false);
});

test('range: a count of zero still has an upper bound (exact 95% Poisson is 3.69)', () => {
  const s = series(60, () => 30, 1);
  const time: Record<string, string> = {};
  const v: Record<string, number> = {};
  for (let i = 0; i < 5; i++) [time[`0.${i}.0`], v[`0.${i}.0`]] = [isoAt(i), 42];
  const lw = estimate(raw(s, time, v)).lastWeek;
  assert.equal(lw.organic, 0);
  assert.equal(lw.high, 4);
});

// --- Inflation by direct tarball requests ---

test('pumped package: a flat stream on one version never reaches high without independent evidence', () => {
  const time: Record<string, string> = {};
  const v: Record<string, number> = {};
  for (let i = 0; i < 3; i++) [time[`1.0.${i}`], v[`1.0.${i}`]] = [isoAt(i), i === 2 ? 1094 : 3];
  const s = series(120, () => 200, 0.25); // a plausible weekday rhythm is easy to fake too
  const e = estimate(raw(s, time, v));
  assert.ok(e.lastWeek.organic >= 1000, JSON.stringify(e.lastWeek));
  assert.equal(e.confidence, 'medium');
  const checked = estimate(raw(s, time, v), { evidence: evidence({ dependentPackages: 0, dependentRepos: 0, cdnHitsMonth: 0 }) });
  assert.equal(checked.confidence, 'medium');
  assert.ok(checked.notes.some((n) => n.includes('No independent evidence')), JSON.stringify(checked.notes));
  for (const failed of [evidence(), evidence({ dependentRepos: 0, cdnHitsMonth: 0 })]) {
    assert.ok(
      estimate(raw(s, time, v), { evidence: failed }).notes.some((n) => n.includes('unavailable')),
      'a failed source must not read as "no evidence"',
    );
  }
});

test('awaitingEvidence: true only where evidence could lift medium to high', () => {
  assert.equal(awaitingEvidence(estimate(loadFixture('react'))), true);
  assert.equal(awaitingEvidence(estimate(loadFixture('react'), { evidence: RICH_EVIDENCE })), false);
  assert.equal(awaitingEvidence(estimate(loadFixture('nervegraph'))), false);
});

test('rhythm note: not shown when the filtered count is noise', () => {
  const time: Record<string, string> = {};
  const v: Record<string, number> = {};
  for (let i = 0; i < 5; i++) [time[`0.${i}.0`], v[`0.${i}.0`]] = [isoAt(i), 20];
  const e = estimate(raw(series(70, () => 20, 0.2), time, v));
  assert.ok(e.lastWeek.organic < 10, JSON.stringify(e.lastWeek));
  assert.ok((e.signals?.weekdayRatio ?? 0) > 2);
  assert.ok(!e.notes.some((n) => n.includes('Weekday')), JSON.stringify(e.notes));
});

// --- Step B: crawler floor ---

test('crawler floor: old versions at 3 and latest at 5 give floor 3 and ~2 organic', () => {
  const n = 60;
  const time: Record<string, string> = {};
  const versionsLastWeek: Record<string, number> = {};
  for (let v = 0; v < 5; v++) {
    time[`0.${v}.0`] = isoAt(v);
    versionsLastWeek[`0.${v}.0`] = 3;
  }
  time['1.0.0'] = isoAt(n - 30);
  versionsLastWeek['1.0.0'] = 5;
  // Daily total matches the per-version total: 5*3 + 5 = 20 per week.
  const s = Array.from({ length: n }, (_, i) => ({ day: dayAt(i), downloads: i % 7 === 6 ? 2 : 3 }));
  const e = estimate(raw(s, time, versionsLastWeek));
  assert.equal(e.breakdown.crawlerFloorPerVersion, 3);
  assert.ok(Math.abs(e.lastWeek.organic - 2) <= 1, `organic=${e.lastWeek.organic}`);
});

test('crawler floor: fewer than 3 old versions gives null floor and low confidence', () => {
  const s = series(60, () => 1000, 1); // flat: no weekday rhythm, which would raise confidence to medium
  const e = estimate(
    raw(s, { '0.1.0': isoAt(0), '0.2.0': isoAt(1), '1.0.0': isoAt(55) }, { '0.1.0': 3, '0.2.0': 3, '1.0.0': 6000 }),
  );
  assert.equal(e.breakdown.crawlerFloorPerVersion, null);
  assert.equal(e.confidence, 'low');
});

test('outage zero in the last week does not saturate the ratio', () => {
  const s = Array.from({ length: 60 }, (_, i) => ({ day: dayAt(i), downloads: 1000 }));
  s[57].downloads = 0; // npm outage: reported 0, but per-version counts still include that day
  const time: Record<string, string> = {};
  const versionsLastWeek: Record<string, number> = {};
  for (let v = 0; v < 5; v++) {
    time[`0.${v}.0`] = isoAt(v);
    versionsLastWeek[`0.${v}.0`] = 3;
  }
  time['1.0.0'] = isoAt(20);
  versionsLastWeek['1.0.0'] = 6500; // 6497 organic of ~7000 real downloads, ~0.93
  const e = estimate(raw(s, time, versionsLastWeek));
  assertInvariants(e, s.length, 'outage');
  // Without the fill the ratio is min(1, 6497/6000) = 1 and organic equals the whole cleaned week.
  assert.ok(e.lastWeek.organic < e.lastWeek.npm, JSON.stringify(e.lastWeek));
  assert.ok(Math.abs(e.lastWeek.organic - 5569) <= 2, `organic=${e.lastWeek.organic}`);
  assert.equal(e.daily[57].npm, 0);
  assert.ok(e.notes.some((n) => n.includes('outage')), JSON.stringify(e.notes));
});

// --- Edge cases: never throw, invariants still hold ---

const edgeCases: [string, RawPackageData][] = [
  ['empty downloads', raw([], { '1.0.0': isoAt(0) }, { '1.0.0': 3 })],
  ['all-zero downloads', raw(series(30, () => 0), { '1.0.0': isoAt(3) }, { '1.0.0': 0 })],
  ['empty versionsLastWeek', raw(series(30, FLAT), { '1.0.0': isoAt(3) }, {})],
  ['time with only created/modified', raw(series(30, FLAT), {}, { '1.0.0': 10 })],
  ['single version', raw(series(30, FLAT), { '1.0.0': isoAt(0) }, { '1.0.0': 30 })],
  ['time has versions missing from versionsLastWeek', raw(series(30, FLAT), { '1.0.0': isoAt(0), '1.1.0': isoAt(10) }, { '1.1.0': 30 })],
  ['versionsLastWeek has versions missing from time', raw(series(30, FLAT), { '1.0.0': isoAt(0) }, { '1.0.0': 10, '2.0.0': 20 })],
];

for (const [label, data] of edgeCases) {
  test(`edge case does not throw: ${label}`, () => {
    const e = estimate(data);
    assertInvariants(e, data.downloads.length, label);
    assertVersionsNewestFirst(e, data.registry.time, label);
  });
}

// --- Options: calibration, evidence, signals (stages 2-4) ---

const evidence = (e: Partial<Evidence> = {}): Evidence => ({
  dependentPackages: null,
  dependentRepos: null,
  topDependents: [],
  cdnHitsMonth: null,
  github: null,
  codeSearchUrl: '',
  ...e,
});
const RICH_EVIDENCE = evidence({ dependentPackages: 1000, dependentRepos: 1000, cdnHitsMonth: 1e6 });
const CALIBRATION: Calibration = { floorPerVersion: 50, updated: '2026-10-01T00:00:00Z', source: 'canary' };
const RICH = evidence({ dependentPackages: 1000, dependentRepos: 1000, cdnHitsMonth: 1e6 });

// Floor not measurable (2 old versions), ~1000/day, enough organic for medium. weekend=1 means no rhythm.
const unmeasurable = (weekend = 1) =>
  raw(
    series(60, () => 1000, weekend),
    { '0.1.0': isoAt(0), '0.2.0': isoAt(1), '1.0.0': isoAt(55) },
    { '0.1.0': 100, '0.2.0': 100, '1.0.0': 6800 },
  );
// Floor measured (5 old versions at 3), ~100/day: organic between 10 and 1000, so confidence medium.
const measuredMedium = () => {
  const time: Record<string, string> = {};
  const v: Record<string, number> = {};
  for (let i = 0; i < 5; i++) [time[`0.${i}.0`], v[`0.${i}.0`]] = [isoAt(i), 3];
  [time['1.0.0'], v['1.0.0']] = [isoAt(20), 685];
  return raw(series(60, () => 100, 1), time, v);
};

for (const dir of FIXTURES) {
  test(`options: estimate(${dir}) equals estimate(${dir}, {}) and with undefined options`, () => {
    const data = loadFixture(dir);
    const base = estimate(data);
    assert.deepEqual(estimate(data, {}), base);
    assert.deepEqual(estimate(data, undefined), base);
  });

  test(`options: invariants hold on ${dir} with calibration and evidence`, () => {
    const data = loadFixture(dir);
    const e = estimate(data, { calibration: CALIBRATION, evidence: RICH });
    assertInvariants(e, data.downloads.length, dir);
    assertVersionsNewestFirst(e, data.registry.time, dir);
  });
}

test('calibration is ignored when the package floor is measurable', () => {
  const data = measuredMedium();
  const base = estimate(data);
  const cal = estimate(data, { calibration: CALIBRATION });
  assert.deepEqual(cal.lastWeek, base.lastWeek);
  assert.deepEqual(cal.breakdown, base.breakdown);
  assert.deepEqual(cal.notes, base.notes);
});

test('calibration replaces the global floor when the package floor is not measurable', () => {
  const base = estimate(unmeasurable());
  const cal = estimate(unmeasurable(), { calibration: CALIBRATION });
  assert.equal(cal.breakdown.crawlerFloorPerVersion, null);
  assert.equal(base.breakdown.crawlersWeekly, 9); // 3 per version x 3 versions
  assert.equal(cal.breakdown.crawlersWeekly, 150); // 50 per version x 3 versions
  assert.ok(cal.lastWeek.organic < base.lastWeek.organic, `${cal.lastWeek.organic} vs ${base.lastWeek.organic}`);
  assert.ok(cal.notes.some((n) => n.includes('calibrated on canary canary')), JSON.stringify(cal.notes));
  assert.ok(base.notes.some((n) => n.includes('global default')), JSON.stringify(base.notes));
});

const ratioCases: [string, RawPackageData, number | null][] = [
  ['empty series', raw([]), null],
  ['under 4 weeks of data', raw(series(20, () => 100, 0.5)), null],
  ['all zeros', raw(series(70, () => 0)), null],
  ['weekday twice the weekend', raw(series(70, () => 100, 0.5)), 2],
  ['flat', raw(series(70, () => 100, 1)), 1],
];
for (const [label, data, expected] of ratioCases) {
  test(`signals.weekdayRatio: ${label} -> ${expected}`, () => {
    assert.equal(estimate(data).signals?.weekdayRatio, expected);
  });
}

test('signals.weekdayRatio stays finite when every weekend is zero', () => {
  const r = estimate(raw(series(70, () => 10, 0))).signals?.weekdayRatio;
  assert.ok(typeof r === 'number' && Number.isFinite(r) && r > 1, String(r));
});

const raiseCases: [string, Evidence | undefined, number, Confidence][] = [
  ['no evidence, no rhythm stays low', undefined, 1, 'low'],
  ['all-null evidence stays low', evidence(), 1, 'low'],
  ['5 dependent packages raises to medium', evidence({ dependentPackages: 5 }), 1, 'medium'],
  ['4 dependent packages stays low', evidence({ dependentPackages: 4 }), 1, 'low'],
  ['10 dependent repos raises to medium', evidence({ dependentRepos: 10 }), 1, 'medium'],
  ['9 dependent repos stays low', evidence({ dependentRepos: 9 }), 1, 'low'],
  ['1000 CDN hits raises to medium', evidence({ cdnHitsMonth: 1000 }), 1, 'medium'],
  ['999 CDN hits stays low', evidence({ cdnHitsMonth: 999 }), 1, 'low'],
  ['weekday rhythm alone raises to medium', undefined, 0.5, 'medium'],
  ['evidence on an unmeasured floor stays below high', RICH, 1, 'medium'],
  ['rich evidence plus rhythm never reaches high', RICH, 0.5, 'medium'],
];
for (const [label, ev, weekend, expected] of raiseCases) {
  test(`confidence raise (unmeasured floor): ${label}`, () => {
    const e = estimate(unmeasurable(weekend), ev ? { evidence: ev } : {});
    assert.ok(e.lastWeek.organic >= 1000, `precondition organic=${e.lastWeek.organic}`);
    assert.equal(e.confidence, expected);
  });
}

test('confidence raise: under 10 organic a week stays low despite rich evidence', () => {
  const e = estimate(loadFixture('nervegraph'), { evidence: RICH });
  assert.ok(e.lastWeek.organic < 10);
  assert.equal(e.confidence, 'low');
});

test('confidence raise: medium with a measured floor never becomes high', () => {
  const data = measuredMedium();
  assert.equal(estimate(data).confidence, 'medium');
  assert.equal(estimate(data, { evidence: RICH }).confidence, 'medium');
});

for (const [label, data] of [
  ['react', () => loadFixture('react')],
  ['measured medium', measuredMedium],
] as const) {
  test(`confidence is never lowered by missing or weak evidence: ${label}`, () => {
    const base = estimate(data()).confidence;
    assert.equal(base, 'medium');
    for (const ev of [evidence(), evidence({ dependentPackages: 0, dependentRepos: 0, cdnHitsMonth: 0 })]) {
      assert.equal(estimate(data(), { evidence: ev }).confidence, base);
    }
  });
}
