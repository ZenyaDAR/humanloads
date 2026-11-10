import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BADGE_LIST_MAX, BADGE_PROMOTE_PER_NIGHT, badgeFiles, badgeRefreshPlan, mergeBadgeList, readPrevious } from '../scripts/data-lib.ts';
import { isValidPackageName } from '../src/core/sources.ts';
import type { FeaturedRow } from '../src/core/types.ts';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 10);
const usable = (n: string) => isValidPackageName(n) && n !== 'blocked-pkg';

test('badge list: promoted after requests on two days, kept while requested, dropped after 45 quiet days', () => {
  const log = [
    { name: 'twice', firstSeen: now - 2 * DAY, lastSeen: now - DAY, days: 2 },
    { name: 'once', firstSeen: now - DAY, lastSeen: now - DAY, days: 1 },
    { name: 'known', firstSeen: now - 90 * DAY, lastSeen: now - 3 * DAY, days: 5 },
  ];
  const previous = {
    known: { since: now - 90 * DAY, lastSeen: now - 50 * DAY, days: 3 }, // refreshed by tonight's log
    quiet: { since: now - 90 * DAY, lastSeen: now - 46 * DAY, days: 9 }, // nobody asked for 46 days
    recent: { since: now - 10 * DAY, lastSeen: now - 44 * DAY, days: 2 },
  };
  assert.deepEqual({ ...mergeBadgeList(previous, log, now, usable) }, {
    known: { since: now - 90 * DAY, lastSeen: now - 3 * DAY, days: 5 },
    recent: { since: now - 10 * DAY, lastSeen: now - 44 * DAY, days: 2 },
    twice: { since: now, lastSeen: now - DAY, days: 2 },
  });
});

test('badge list: a hostile or broken log or summary changes nothing it shouldn\'t', () => {
  const previous = { a: { since: 1, lastSeen: now - DAY, days: 2 } };
  for (const log of [null, 'x', { name: 'a' }, [null, 1, { name: 5 }]]) assert.deepEqual({ ...mergeBadgeList(previous, log, now, usable) }, previous);
  const bad = [
    { name: '../etc', lastSeen: now, days: 9 },
    { name: 'blocked-pkg', lastSeen: now, days: 9 },
    { name: 'nan', lastSeen: NaN, days: 9 },
    { name: 'future', lastSeen: now + 400 * DAY, days: 9 },
  ];
  const out = mergeBadgeList({}, bad, now, usable);
  assert.deepEqual(Object.keys(out), ['future']);
  assert.equal(out.future.lastSeen, now, 'a future timestamp is clamped, so it expires on time');
  const fromSummary = mergeBadgeList({ f: { since: now + DAY, lastSeen: now + 400 * DAY, days: 2 } } as any, [], now, usable);
  assert.deepEqual(fromSummary.f, { since: now, lastSeen: now, days: 2 }, 'summary.json timestamps are clamped too');
});

test('badge list: names like "constructor" are ordinary entries', () => {
  const log = ['constructor', 'toString', 'hasOwnProperty'].map((name) => ({ name, lastSeen: now, days: 2 }));
  const out = mergeBadgeList({ constructor: { since: 1, lastSeen: now - DAY, days: 3 } }, log, now, usable);
  assert.deepEqual(Object.keys(out), ['constructor', 'hasOwnProperty', 'toString']);
  assert.deepEqual(out.constructor, { since: 1, lastSeen: now, days: 3 });
  assert.equal((Object as any).lastSeen, undefined);
});

test(`badge list: at most ${BADGE_PROMOTE_PER_NIGHT} new names a night, the most requested first`, () => {
  const log = Array.from({ length: BADGE_PROMOTE_PER_NIGHT + 10 }, (_, i) => ({ name: `p${i}`, lastSeen: now, days: i === 59 ? 30 : 2 }));
  const out = mergeBadgeList({}, log, now, usable);
  assert.equal(Object.keys(out).length, BADGE_PROMOTE_PER_NIGHT);
  assert.ok(out.p59, 'the name requested on the most days gets in');
});

test(`badge list: past ${BADGE_LIST_MAX}, the names requested longest ago go first, by day not by millisecond`, () => {
  const previous = Object.fromEntries(
    Array.from({ length: BADGE_LIST_MAX + 5 }, (_, i) => [`p${i}`, { since: 0, lastSeen: i < BADGE_LIST_MAX ? now : now - 2 * DAY, days: 2 }]),
  );
  const out = mergeBadgeList(previous, [], now, usable);
  assert.equal(Object.keys(out).length, BADGE_LIST_MAX);
  assert.ok(out.p0 && !out[`p${BADGE_LIST_MAX + 4}`]);
  const sameDay = mergeBadgeList(
    { early: { since: 0, lastSeen: now + 60_000, days: 2 }, late: { since: 0, lastSeen: now + 20 * 3600_000, days: 9 } },
    [],
    now + DAY - 1,
    usable,
  );
  assert.deepEqual(Object.keys(sameDay), ['early', 'late']);
});

test('badge refresh plan: names with no row first, then the stalest, within the budget', () => {
  const row = (updated: string) => ({ updated }) as FeaturedRow;
  const previous = { a: row('2026-11-09'), b: row('2026-11-01'), c: row('2026-11-05') };
  assert.deepEqual(badgeRefreshPlan(['a', 'b', 'c', 'new'], previous, 3), ['new', 'b', 'c']);
});

test('badge files: "@a/b" and "a__b" never share a file', () => {
  const { files, clashes } = badgeFiles(['@a/b', 'a__b', 'zod']);
  assert.deepEqual([...files], [['a__b', '@a/b'], ['zod', 'zod']]);
  assert.deepEqual(clashes, ['a__b']);
});

test('readPrevious keeps the badge list, across a model change too', () => {
  const body = { model: 'old', packages: { x: {} }, badgeList: { x: { since: 1, lastSeen: 2, days: 2 } } };
  assert.deepEqual(readPrevious(body, 'new').badgeList, body.badgeList);
  assert.deepEqual(readPrevious({ ...body, badgeList: ['x'] }, 'old').badgeList, {});
});
