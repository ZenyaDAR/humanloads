// Per-package facts in plain sentences ("Is X still maintained / used?"), so each page says something only it
// can say. Shared by the SPA and the prerender script: computed from the data both already fetch, no extra calls.
import { addDays, median } from './estimate.ts';
import { esc } from './html.ts';
import type { Estimate, RawPackageData } from './types.ts';

export interface PackageFacts {
  asOf: string; // last day of the download series; "how long ago" is measured from here, so builds are reproducible
  firstPublished?: string;
  lastRelease?: { version: string; day: string };
  stableReleasesYear: number;
  prereleasesYear: number;
  medianGapDays: number | null; // between days with a stable release, last 12 months
  maintainers?: number;
  deprecated?: string;
  growth3m: number | null; // 0.12 = up 12%
  growth11m: number | null;
  adoption: { major: string; isLatest: boolean; share: number; topVersion: string; topShare: number } | null;
  weekdayRatio: number | null;
  mirrorsYear: number;
  crawlersWeekly: number;
  crawlerFloor: number | null;
}

const DAY_MS = 86_400_000;
const GROWTH_WINDOW = 28; // whole weeks, so weekday rhythm cancels out
const GROWTH_MIN_DAYS = 14;
const GROWTH_MIN_DAILY = 5; // below this a percentage is noise
const ADOPTION_MIN = 50; // weekly downloads above the crawler floor
const RHYTHM_RATIO = 1.3; // same cutoff as estimate.ts
const DEPRECATED_MAX = 200;

const isPrerelease = (v: string) => v.includes('-');
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
// Late December downloads collapse every year; comparing against them would report fake growth.
const isHoliday = (day: string) => day.slice(5) >= '12-20' || day.slice(5) <= '01-03';

// Average per day of the 28-day window ending `offset` days before the series end. Outage zeros and holidays are
// skipped; a window starting before the package existed gives null, never "up 10,000%".
function windowAverage(est: Estimate, offset: number, created?: string): number | null {
  const end = est.daily.length - offset;
  const start = end - GROWTH_WINDOW;
  if (start < 0 || (created && est.daily[start].day < created)) return null;
  const days = est.daily.slice(start, end).filter((d) => d.cleaned > 0 && !isHoliday(d.day));
  return days.length < GROWTH_MIN_DAYS ? null : days.reduce((s, d) => s + d.cleaned, 0) / days.length;
}

function growth(est: Estimate, weeksBack: number, created?: string): number | null {
  const now = windowAverage(est, 0, created);
  const then = windowAverage(est, weeksBack * 7, created);
  return now === null || then === null || then < GROWTH_MIN_DAILY ? null : now / then - 1;
}

function adoption(est: Estimate, latest?: string): PackageFacts['adoption'] {
  const rows = est.versions.filter((r) => !isPrerelease(r.version));
  const total = rows.reduce((s, r) => s + r.aboveFloor, 0);
  if (!latest || total < ADOPTION_MIN) return null;
  const byMajor = new Map<string, number>();
  for (const r of rows) {
    const major = r.version.split('.')[0];
    byMajor.set(major, (byMajor.get(major) ?? 0) + r.aboveFloor);
  }
  const [major, sum] = [...byMajor].sort((a, b) => b[1] - a[1])[0];
  const top = rows.reduce((a, b) => (b.aboveFloor > a.aboveFloor ? b : a));
  return { major, isLatest: major === latest.split('.')[0], share: sum / total, topVersion: top.version, topShare: top.aboveFloor / total };
}

export function packageFacts(data: RawPackageData, est: Estimate): PackageFacts | undefined {
  const asOf = est.daily.at(-1)?.day;
  if (!asOf) return undefined;
  const reg = data.registry;
  const published = Object.entries(reg.time)
    .filter((e): e is [string, string] => e[0] !== 'created' && e[0] !== 'modified' && typeof e[1] === 'string' && !isNaN(Date.parse(e[1])))
    .map(([version, iso]) => ({ version, day: new Date(iso).toISOString().slice(0, 10) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const yearAgo = addDays(asOf, -365);
  const thisYear = published.filter((p) => p.day > yearAgo && p.day <= asOf);
  const stable = thisYear.filter((p) => !isPrerelease(p.version));
  // Between release days: backports shipped together would otherwise read as "0 days apart".
  const releaseDays = [...new Set(stable.map((p) => p.day))];
  const gaps = releaseDays.slice(1).map((d, i) => daysBetween(releaseDays[i], d));

  const latest = reg['dist-tags'].latest;
  const lastRelease = published.find((p) => p.version === latest) ?? published.filter((p) => !isPrerelease(p.version)).at(-1);
  const created = typeof reg.time.created === 'string' && !isNaN(Date.parse(reg.time.created))
    ? new Date(reg.time.created).toISOString().slice(0, 10)
    : published[0]?.day;

  return {
    asOf,
    ...(created && { firstPublished: created }),
    ...(lastRelease && { lastRelease }),
    stableReleasesYear: stable.length,
    prereleasesYear: thisYear.length - stable.length,
    medianGapDays: gaps.length >= 2 ? Math.round(median(gaps)) : null,
    ...(reg.maintainerCount !== undefined && { maintainers: reg.maintainerCount }),
    ...(reg.deprecated && { deprecated: reg.deprecated.slice(0, DEPRECATED_MAX) }),
    growth3m: growth(est, 13, created),
    growth11m: growth(est, 48, created),
    adoption: adoption(est, latest),
    weekdayRatio: est.signals?.weekdayRatio ?? null,
    mirrorsYear: est.breakdown.mirrorsTotal,
    crawlersWeekly: est.breakdown.crawlersWeekly,
    crawlerFloor: est.breakdown.crawlerFloorPerVersion,
  };
}

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const date = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const trend = (g: number) => (Math.abs(g) < 0.05 ? 'about flat' : `${g > 0 ? 'up' : 'down'} ${num(Math.abs(g) * 100)}%`);

function maintainedText(f: PackageFacts): string {
  const out: string[] = [];
  const age = f.lastRelease ? daysBetween(f.lastRelease.day, f.asOf) : null;
  if (f.deprecated) out.push(`No: the latest version is marked deprecated on npm, with the message “${f.deprecated}”.`);
  else if (age !== null && age <= 180) out.push('Most likely yes, going by its releases.');
  else if (age !== null && age <= 365) out.push('Less clear: the last release is more than six months old.');
  else if (age !== null) out.push('Probably not actively: there has been no release in over a year, though that can also mean it is simply finished.');

  if (f.lastRelease) out.push(`The latest version, ${f.lastRelease.version}, came out on ${date(f.lastRelease.day)}.`);
  const pre = f.prereleasesYear ? plural(f.prereleasesYear, 'pre-release') : '';
  if (f.stableReleasesYear) {
    const gap = f.medianGapDays !== null ? `, typically ${plural(f.medianGapDays, 'day')} apart` : '';
    out.push(`The last 12 months saw ${plural(f.stableReleasesYear, 'stable release')}${gap}${pre ? `, plus ${pre}` : ''}.`);
  } else {
    out.push(`There were no stable releases in the last 12 months${pre ? `, only ${pre}` : ''}.`);
  }
  if (f.firstPublished) out.push(`It was first published on ${date(f.firstPublished)}.`);
  if (f.maintainers) out.push(`npm lists ${plural(f.maintainers, 'maintainer')}.`);
  return out.join(' ');
}

function usedText(f: PackageFacts): string {
  const out: string[] = [];
  const changes = [
    f.growth3m !== null && `${trend(f.growth3m)} over 3 months`,
    f.growth11m !== null && `${trend(f.growth11m)} over 11 months`,
  ].filter(Boolean);
  // Humans per day are npm's spike-free curve times one ratio, so this must not read as a change in the bot share.
  if (changes.length) out.push(`Downloads with publish spikes removed are ${changes.join(' and ')}.`);
  if (f.adoption) {
    const a = f.adoption;
    out.push(
      `Last week, ${pct(a.share)} of downloads above the crawler floor were on major version ${a.major}` +
        `${a.isLatest ? ', the latest one' : ', not the latest one'}; the most used single version was ${a.topVersion}, with ${pct(a.topShare)}.`,
    );
  }
  if (f.weekdayRatio !== null) {
    out.push(
      f.weekdayRatio >= RHYTHM_RATIO
        ? `Weekdays get ${f.weekdayRatio.toFixed(1)}× the downloads of weekends, which fits people at work, though CI follows the same rhythm.`
        : `Weekdays get ${f.weekdayRatio.toFixed(2)}× the downloads of weekends, so there is no clear work-week rhythm.`,
    );
  }
  if (f.mirrorsYear > 0) out.push(`Over the last 12 months, ${num(f.mirrorsYear)} downloads arrived in publish spikes and were attributed to mirrors.`);
  if (f.crawlerFloor !== null && f.crawlersWeekly > 0) {
    out.push(`Crawlers account for about ${num(f.crawlersWeekly)} downloads a week, roughly ${num(f.crawlerFloor)} per version.`);
  }
  return out.join(' ');
}

export function factsHtml(name: string, f: PackageFacts): string {
  const n = esc(name);
  const used = usedText(f);
  return `<section class="insights">
        <h2 class="section-title">Is ${n} still maintained?</h2>
        <p>${esc(maintainedText(f))}</p>
      </section>${
        used
          ? `
      <section class="insights">
        <h2 class="section-title">Is ${n} still used?</h2>
        <p>${esc(used)}</p>
      </section>`
          : ''
      }`;
}
