import type { Confidence, DailyEstimate, Estimate, EstimateOptions, Publish, RawPackageData, VersionRow } from './types.ts';

// ponytail: constant guess (matches the floor observed on a small real package); used only when neither the package's
// own floor nor canary calibration (opts.calibration) is available.
export const GLOBAL_FLOOR_PER_VERSION = 3;

// Bump when numbers from older builds must not be carried over (scripts/build-data.mjs).
export const MODEL_VERSION = 'v3';

const SPIKE_DAYS = 3; // window [p, p+3]
// Background day offsets relative to a window day.
const SAME_WEEKDAY_BEFORE = [-14, -7];
const SAME_WEEKDAY_AFTER = [7, 14];
const NEAR_OFFSETS = Array.from({ length: 28 }, (_, i) => (i < 14 ? i - 14 : i - 13)); // -14..-1, 1..14
// ponytail: a window day counts as a spike only above 2x background, so the weekday rhythm of popular
// packages isn't clipped as "mirrors". Mirror spikes (~100-150 per version) that are smaller than the
// package's own daily volume are left in; tune with canary data in stage 3.
const SPIKE_FACTOR = 2;
const OLD_VERSION_DAYS = 14;
// ponytail: the low end of Tenable's 100-150 automated downloads per new version (2026). A floor for the spike that
// step A may miss when publishes overlap. Measure it on the canary (calibrate()) if it needs to be exact.
const BOT_HITS_PER_NEW_VERSION = 100;
// Count noise on the weekly bounds: n ± NOISE_Z·√n is a ~95% Poisson band, so the range never collapses
// to a single value when all old versions sit on the same floor.
const NOISE_Z = 2;
// √0 would give no band at all; the exact 95% Poisson upper bound for a count of 0 is 3.69.
const ZERO_COUNT_UPPER = 4;
// ponytail: a zero day among the last 7 is treated as an npm outage only when its background is at least
// this high; for small packages a real 0 is plausible (Poisson P(0) = e^-b), so it is left alone.
const OUTAGE_MIN_BACKGROUND = 10;
// Weekday rhythm (stage 3): humans work Mon-Fri, bots don't care.
const RHYTHM_WEEKS = 8;
const RHYTHM_MIN_WEEKS = 4;
const RHYTHM_RATIO = 1.3;
// Independent evidence that counts as real use (stage 2).
const EVIDENCE_MIN = { dependentPackages: 5, dependentRepos: 10, cdnHitsMonth: 1000 };
const DAY_MS = 86_400_000;
const fmt = (n: number) => n.toLocaleString('en-US');

export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

const isWeekend = (day: string): boolean => [0, 6].includes(new Date(day + 'T00:00:00Z').getUTCDay());

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Linear-interpolated percentile of an ascending array.
function percentile(sorted: number[], p: number): number {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

// Mean weekday / mean weekend of the cleaned series over the last RHYTHM_WEEKS full Mon-Sun weeks (UTC).
// ponytail: npm outage zeros are not excluded here; they are rare and land on any weekday.
function weekdayRatio(days: string[], cleaned: number[]): number | null {
  const lastDay = days.at(-1);
  if (!lastDay) return null;
  const lastSunday = addDays(lastDay, -new Date(lastDay + 'T00:00:00Z').getUTCDay());
  const from = addDays(lastSunday, -7 * RHYTHM_WEEKS + 1);
  const wd: number[] = [];
  const we: number[] = [];
  days.forEach((d, i) => {
    if (d < from || d > lastSunday) return;
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    (dow === 0 || dow === 6 ? we : wd).push(cleaned[i]);
  });
  if (wd.length + we.length < 7 * RHYTHM_MIN_WEEKS || !we.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const [w, e] = [mean(wd), mean(we)];
  if (e === 0 && w < 1) return null;
  // A zero weekend mean is treated as one download over the weekends so the ratio stays finite (JSON-safe).
  return Math.round((w / Math.max(e, 1 / we.length)) * 100) / 100;
}

// Medium only because evidence has not arrived yet: the app shows "checking" here instead of a grade that may flip to high.
export const awaitingEvidence = (e: Estimate): boolean =>
  e.confidence === 'medium' && e.lastWeek.organic >= 1000 && e.breakdown.crawlerFloorPerVersion !== null;

export function estimate(data: RawPackageData, opts: EstimateOptions = {}): Estimate {
  const notes: string[] = [];
  const series = data.downloads ?? [];
  const time = data.registry?.time ?? {};
  const versionsLastWeek = data.versionsLastWeek ?? {};

  // Publish day per version (unpublished docs carry a non-string `time.unpublished`, skip anything odd).
  const publishedAt = (v: string) => (typeof time[v] === 'string' ? time[v] : '');
  const publishDay: Record<string, string> = {};
  for (const [v, iso] of Object.entries(time)) {
    if (v === 'created' || v === 'modified' || typeof iso !== 'string' || isNaN(Date.parse(iso))) continue;
    publishDay[v] = new Date(iso).toISOString().slice(0, 10);
  }
  const byDay = new Map<string, string[]>();
  for (const [v, day] of Object.entries(publishDay)) byDay.set(day, [...(byDay.get(day) ?? []), v]);
  const publishes: Publish[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, versions]) => ({ day, versions }));

  // Step A: cap each publish window at the background around it.
  const npmByDay = new Map(series.map((d) => [d.day, d.downloads]));
  const windowOf = (p: Publish) => Array.from({ length: SPIKE_DAYS + 1 }, (_, i) => addDays(p.day, i));
  const inWindow = new Set(publishes.flatMap(windowOf));
  // Zeros are skipped: npm's API reports outage days as 0 (react, zod: Oct 13-15 2026). Days inside other
  // publish windows are used only when nothing else is left (react publishes canaries almost daily).
  const backgroundValues = (day: string, offsets: number[]): number[] => {
    const days = offsets.map((n) => addDays(day, n));
    const pick = (ds: string[]) => ds.map((d) => npmByDay.get(d) ?? 0).filter((n) => n > 0);
    const clean = pick(days.filter((d) => !inWindow.has(d)));
    return clean.length ? clean : pick(days);
  };
  const clipped = new Set<string>();
  const cleaned = series.map(({ day, downloads }) => {
    if (!inWindow.has(day)) return downloads;
    // Background = the higher of two medians: same weekday 1-2 weeks before, and 1-2 weeks after.
    // Same weekday because popular packages swing ~2.5x between weekdays and weekends (CI). Higher side
    // because a mirror spike is transient (both sides low), while a level shift such as growth or holidays
    // leaves one side high and must not be clipped.
    const before = backgroundValues(day, SAME_WEEKDAY_BEFORE);
    const after = backgroundValues(day, SAME_WEEKDAY_AFTER);
    // Both sides missing (series end + outage days): days of the same kind within two weeks. Any neighbouring
    // day would mix in weekend levels and clip an ordinary weekday (axios lost 21% this way). Only a young
    // package with no such day falls back to any non-zero day.
    const sameKind = before.length || after.length ? [] : backgroundValues(day, NEAR_OFFSETS.filter((n) => isWeekend(addDays(day, n)) === isWeekend(day)));
    const b =
      before.length || after.length
        ? Math.max(median(before), median(after))
        : median(sameKind.length ? sameKind : backgroundValues(day, NEAR_OFFSETS));
    if (downloads <= SPIKE_FACTOR * b) return downloads;
    clipped.add(day);
    return Math.round(b);
  });
  const spikesRemoved = publishes.filter((p) => windowOf(p).some((d) => clipped.has(d))).length;
  const mirrorsTotal = Math.round(series.reduce((s, d, i) => s + d.downloads - cleaned[i], 0));
  if (spikesRemoved) notes.push(`${spikesRemoved} publish ${spikesRemoved === 1 ? 'spike' : 'spikes'} removed (${fmt(mirrorsTotal)} downloads attributed to mirrors and scanners)`);

  // Step B: crawler floor from per-version weekly downloads.
  const lastDay = series.at(-1)?.day;
  const oldCutoff = lastDay ? addDays(lastDay, -OLD_VERSION_DAYS) : '';
  // With under two weeks of history there is no background to compare a spike with, so the numbers can't tell
  // noise from first users. Say so instead of reporting "0".
  const firstPublish = Object.values(publishDay).sort()[0];
  const tooNew = firstPublish !== undefined && oldCutoff !== '' && firstPublish > oldCutoff;
  if (tooNew) notes.push(`First published ${firstPublish}: too little history to separate noise from real use`);
  const versionNames = Object.keys(versionsLastWeek);
  const counts = versionNames.map((v) => versionsLastWeek[v] || 0);
  const old = versionNames
    .filter((v) => publishDay[v] !== undefined && publishDay[v] < oldCutoff)
    .map((v) => versionsLastWeek[v] || 0)
    .sort((a, b) => a - b);

  let crawlerFloorPerVersion: number | null = null;
  let floors: { point: number; low: number; high: number };
  if (old.length >= 3) {
    crawlerFloorPerVersion = percentile(old, 0.1);
    floors = { point: crawlerFloorPerVersion, low: percentile(old, 0.25), high: old[0] };
  } else {
    // ponytail: without a measured floor, bracket the assumed one with [0, 2x] for the bounds.
    const cal = opts.calibration;
    const f = cal ? cal.floorPerVersion : GLOBAL_FLOOR_PER_VERSION;
    floors = { point: f, low: 2 * f, high: 0 };
    notes.push(
      `Only ${old.length} ${old.length === 1 ? 'version is' : 'versions are'} older than ${OLD_VERSION_DAYS} days, too few to measure the crawler floor, so it is assumed to be ${fmt(f)} per version` +
        (cal ? ` (calibrated on canary ${cal.source}, ${cal.updated.slice(0, 10)})` : ' (global default)'),
    );
  }

  const last7 = Math.max(0, series.length - 7);
  const sumLast7 = (xs: number[]) => xs.slice(last7).reduce((s, x) => s + x, 0);
  const cleanedWeek = sumLast7(cleaned);
  // Fresh versions' per-version counts still contain the publish spike Step A removed from the daily series,
  // so take the same amount off the per-version organic sum to stay on the cleaned scale.
  const mirrorsLastWeek = sumLast7(series.map((d) => d.downloads)) - cleanedWeek;
  // Download pumping (Tenable 2026): with publishes every day for weeks, step A has no clean background and cuts
  // nothing. Versions whose publish window reaches into the last 7 days carry their bot fetches anyway, so take
  // at least BOT_HITS_PER_NEW_VERSION off each of them (no more than it got above the floor).
  const spikeCutoff = lastDay ? addDays(lastDay, -6 - SPIKE_DAYS) : '';
  const fresh = versionNames.filter((v) => publishDay[v] !== undefined && publishDay[v] >= spikeCutoff);
  const botsFor = (f: number) => fresh.reduce((s, v) => s + Math.min(BOT_HITS_PER_NEW_VERSION, Math.max(0, (versionsLastWeek[v] || 0) - f)), 0);
  // The upper bound skips this: like a cut spike, the bot share is assumed, and real users may be in it.
  const organicFor = (f: number, bots = true) =>
    Math.max(0, counts.reduce((s, v) => s + Math.max(0, v - f), 0) - Math.max(mirrorsLastWeek, bots ? botsFor(f) : 0));
  const pumpedExtra = Math.round(botsFor(floors.point) - mirrorsLastWeek);
  if (pumpedExtra > 0 && pumpedExtra >= 0.1 * cleanedWeek)
    notes.push(
      `${fresh.length} new versions reached into the last week. Each new version draws about ${BOT_HITS_PER_NEW_VERSION} automated downloads, so ${fmt(pumpedExtra)} more are attributed to mirrors and scanners`,
    );
  // npm outage days report 0 in the daily series while per-version counts still include them, which would
  // saturate the ratio. Fill such zeros with their background in the denominator only; daily values stay.
  let outageDays = 0;
  const ratioWeek = cleaned.slice(last7).reduce((s, c, i) => {
    if (c > 0) return s + c;
    // Zeros before the first publish are not outages, and a new package's only background is its own spike.
    if (tooNew || (firstPublish !== undefined && series[last7 + i].day < firstPublish)) return s;
    const b = median(backgroundValues(series[last7 + i].day, NEAR_OFFSETS));
    if (b < OUTAGE_MIN_BACKGROUND) return s;
    outageDays++;
    return s + Math.round(b);
  }, 0);
  if (outageDays) notes.push(`${outageDays} of the last 7 days look like npm outages (reported as 0). For the ratio, they count at the level of nearby days`);
  const ratio = (f: number, bots = true) => (ratioWeek > 0 ? Math.min(1, organicFor(f, bots) / ratioWeek) : 0);
  const r = { point: ratio(floors.point), low: ratio(floors.low), high: ratio(floors.high, false) };
  // Add count noise to the weekly bounds, then turn them back into ratios on the cleaned scale.
  if (cleanedWeek > 0) {
    const n = r.point * cleanedWeek;
    const lowWeekly = Math.max(0, Math.min(r.low * cleanedWeek, n - Math.ceil(NOISE_Z * Math.sqrt(n))));
    const noise = n > 0 ? Math.ceil(NOISE_Z * Math.sqrt(n)) : ZERO_COUNT_UPPER;
    const highWeekly = Math.min(cleanedWeek, Math.max(r.high * cleanedWeek, n + noise));
    r.low = lowWeekly / cleanedWeek;
    r.high = highWeekly / cleanedWeek;
  }
  // No background and possibly no per-version counts yet: every download so far could be real, or none.
  if (tooNew) [r.low, r.high] = [0, 1];

  // Cumulative rounding: rounding each day on its own erases small packages (2/week spread over days of
  // 0.3 each rounds to 0 every day). Rounding the running total keeps any window's sum within 1 of exact.
  const roundedDaily = (value: (cleanedDay: number, i: number) => number) => {
    let acc = 0;
    return cleaned.map((c, i) => {
      const prev = Math.round(acc);
      acc += value(c, i);
      return Math.round(acc) - prev;
    });
  };
  const [orgD, lowD] = [roundedDaily((c) => c * r.point), roundedDaily((c) => c * r.low)];
  // A cut spike may hold real users (a release announcement looks the same), so the upper bound keeps all of it.
  const highD = roundedDaily((c, i) => c * r.high + series[i].downloads - c);
  const daily: DailyEstimate[] = series.map((d, i) => ({
    day: d.day,
    npm: d.downloads,
    cleaned: cleaned[i],
    organic: orgD[i],
    // Bounds are rounded independently, so clamp them around the point estimate per day.
    low: Math.min(lowD[i], orgD[i]),
    high: Math.max(highD[i], orgD[i]),
  }));
  const lastWeek = {
    npm: sumLast7(daily.map((d) => d.npm)),
    organic: sumLast7(daily.map((d) => d.organic)),
    low: sumLast7(daily.map((d) => d.low)),
    high: sumLast7(daily.map((d) => d.high)),
  };

  const withDownloads = counts.filter((v) => v > 0).length;
  const crawlersWeekly = Math.round(Math.min(floors.point * withDownloads, cleanedWeek));
  if (crawlerFloorPerVersion !== null) {
    notes.push(
      crawlerFloorPerVersion > 0
        ? `Old versions got about ${fmt(Math.round(crawlerFloorPerVersion))} downloads each last week, used or not. That is the crawler floor, subtracted from all ${fmt(withDownloads)} versions with downloads`
        : `Old versions show no crawler floor (some got 0 downloads last week)`,
    );
  }

  // Step C: confidence.
  const ev = opts.evidence;
  const evidenceNotes: string[] = [];
  if (ev) {
    if ((ev.dependentPackages ?? 0) >= EVIDENCE_MIN.dependentPackages)
      evidenceNotes.push(`${fmt(ev.dependentPackages!)} published packages depend on it`);
    if ((ev.dependentRepos ?? 0) >= EVIDENCE_MIN.dependentRepos)
      evidenceNotes.push(`${fmt(ev.dependentRepos!)} public repositories depend on it`);
    if ((ev.cdnHitsMonth ?? 0) >= EVIDENCE_MIN.cdnHitsMonth)
      evidenceNotes.push(`${fmt(ev.cdnHitsMonth!)} jsDelivr CDN hits last month`);
  }
  const enoughToJudge = lastWeek.organic >= 10;
  const ratioWd = weekdayRatio(series.map((d) => d.day), cleaned);
  const rhythm = enoughToJudge && !tooNew && ratioWd !== null && ratioWd >= RHYTHM_RATIO;

  let confidence: Confidence = 'medium';
  if (tooNew) {
    confidence = 'low';
  } else if (!enoughToJudge) {
    confidence = 'low';
    notes.push(`Under 10 real installs a week: at this size the noise is as large as the signal`);
  } else if (crawlerFloorPerVersion === null) {
    // Rhythm is easy to fake and CI has it too, so it and evidence lift an unmeasured floor to medium at most.
    confidence = evidenceNotes.length || rhythm ? 'medium' : 'low';
  } else if (lastWeek.organic >= 1000) {
    // A steady stream of direct tarball requests passes both filters, so volume alone never earns "high".
    if (evidenceNotes.length) {
      confidence = 'high';
      notes.push(`Over 1,000 real installs a week, a measured crawler floor and independent evidence of use`);
    } else if (ev) {
      // "None found" is a claim about every source, so one failed source makes it "unavailable".
      const checked = ev.dependentPackages !== null && ev.dependentRepos !== null && ev.cdnHitsMonth !== null;
      notes.push(checked ? `No independent evidence of use found, so confidence stops at medium` : `Independent evidence is unavailable, so confidence stops at medium`);
    }
  }
  notes.push(...evidenceNotes);
  if (rhythm) notes.push(`Weekday traffic is ${ratioWd!.toFixed(1)}× weekend. That fits work hours, but CI and weekday releases look the same`);

  const versions: VersionRow[] = versionNames
    .map((v) => {
      const downloads = versionsLastWeek[v] || 0;
      return { version: v, downloads, aboveFloor: Math.round(Math.max(0, downloads - floors.point)) };
    })
    .sort((a, b) => publishedAt(b.version).localeCompare(publishedAt(a.version)));

  return {
    model: MODEL_VERSION,
    tooNew,
    daily,
    publishes,
    lastWeek,
    breakdown: { mirrorsTotal, crawlerFloorPerVersion, crawlersWeekly, organicWeekly: lastWeek.organic },
    versions,
    confidence,
    notes,
    signals: { weekdayRatio: ratioWd },
  };
}
