// Per-package facts in plain sentences ("Is X still maintained / used?"), so each page says something only it
// can say. Shared by the SPA and the prerender script: computed from the data both already fetch, no extra calls.
import { addDays, median } from './estimate.ts';
import { clip, esc, rangeText, roundCount } from './html.ts';
import type { ChainStep, Estimate, MarketGrowth, RawPackageData } from './types.ts';

export interface PackageFacts {
  asOf: string; // last day of the download series; "how long ago" is measured from here, so builds are reproducible
  firstPublished?: string;
  lastRelease?: { version: string; day: string };
  lastPublish?: string; // any version, prereleases and backports too: each one brings its own spike
  stableReleasesYear: number;
  prereleasesYear: number;
  medianGapDays: number | null; // between days with a stable release, last 12 months
  maintainers?: number;
  deprecated?: string;
  maintenanceNote?: string;
  growth3m: number | null; // 0.12 = up 12%
  growth11m: number | null;
  adoption: { major: string; isLatest: boolean; share: number; topVersion: string; topShare: number } | null;
  weekdayRatio: number | null;
  mirrorsYear: number;
  crawlersWeekly: number;
  crawlerFloor: number | null;
  monthly?: Monthly | null; // optional: rows built before it existed have none
}

// Complete calendar months, oldest first, as parallel columns (smaller in summary.json than one object per month).
export interface Monthly {
  months: string[]; // YYYY-MM
  npm: number[];
  cleaned: number[]; // publish spikes removed
  low: number[];
  high: number[];
  days: number[]; // days with downloads; outage zeros don't count
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

const MONTHLY_MIN_MONTHS = 3;
const MONTHLY_MIN_MEDIAN = 300; // spike-free downloads a month, about 10 a day: below that the table is mostly noise
const MONTH_MIN_DAYS = 20; // a month with fewer days of data has no per-day average worth comparing

const monthEnd = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);

// Only whole months inside the series and after the first publish: a partial month would read as a fake drop.
function monthly(est: Estimate, created?: string): Monthly | null {
  const first = est.daily[0]?.day;
  const last = est.daily.at(-1)?.day;
  if (!first || !last || est.tooNew || est.lastWeek.organic < 10) return null;
  const m: Monthly = { months: [], npm: [], cleaned: [], low: [], high: [], days: [] };
  for (const d of est.daily) {
    const month = d.day.slice(0, 7);
    if (`${month}-01` < first || monthEnd(month) > last || (created && month <= created.slice(0, 7))) continue;
    if (m.months.at(-1) !== month) {
      m.months.push(month);
      for (const col of [m.npm, m.cleaned, m.low, m.high, m.days]) col.push(0);
    }
    const i = m.months.length - 1;
    m.npm[i] += d.npm;
    m.cleaned[i] += d.cleaned;
    m.low[i] += d.low;
    m.high[i] += d.high;
    if (d.cleaned > 0) m.days[i]++;
  }
  return m.months.length >= MONTHLY_MIN_MONTHS && median(m.cleaned) >= MONTHLY_MIN_MEDIAN ? m : null;
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
    ...(published.length && { lastPublish: published.at(-1)!.day }),
    stableReleasesYear: stable.length,
    prereleasesYear: thisYear.length - stable.length,
    medianGapDays: gaps.length >= 2 ? Math.round(median(gaps)) : null,
    ...(reg.maintainerCount !== undefined && { maintainers: reg.maintainerCount }),
    ...(reg.deprecated && { deprecated: clip(reg.deprecated, DEPRECATED_MAX) }),
    ...(reg.maintenanceNote && { maintenanceNote: reg.maintenanceNote }),
    growth3m: growth(est, 13, created),
    growth11m: growth(est, 48, created),
    adoption: adoption(est, latest),
    // Below 10 a week the estimate itself is noise, and a rhythm would contradict it (weekday releases cause one).
    weekdayRatio: est.lastWeek.organic >= 10 && !est.tooNew ? (est.signals?.weekdayRatio ?? null) : null,
    mirrorsYear: est.breakdown.mirrorsTotal,
    crawlersWeekly: est.breakdown.crawlersWeekly,
    crawlerFloor: est.breakdown.crawlerFloorPerVersion,
    monthly: monthly(est, created),
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
  // The project's own words beat anything release dates suggest: a project in maintenance mode still ships fixes.
  else if (f.maintenanceNote) out.push(`Only partly, by its own account. Its README says: “${f.maintenanceNote}”`);
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

const MARKET_MIN_PACKAGES = 30;
const MARKET_SAME = 0.1; // closer than this to the median isn't a difference worth a sentence
export const MARKET_MIN_WEEKLY = 1000; // for the median and for comparing with it: small counts swing wildly

// npm's counts rise across the board, so "up 40%" alone can hide a package losing ground. The median is no verdict on
// health: the catalog leans towards what is most downloaded today, which the sentence says.
function marketText(f: PackageFacts, m: MarketGrowth | null | undefined, weekly: number): string {
  if (!m || m.growth11m === null || m.packages < MARKET_MIN_PACKAGES || f.growth11m === null || weekly < MARKET_MIN_WEEKLY) return '';
  const gap = f.growth11m - m.growth11m;
  const place = Math.abs(gap) < MARKET_SAME ? 'about level with that' : gap < 0 ? 'behind that' : 'ahead of that';
  return `For scale, the median of the ${num(m.packages)} packages we track, which lean towards today's most downloaded, is ${trend(m.growth11m)} over 11 months, so this one is ${place}.`;
}

function usedText(f: PackageFacts, market: MarketGrowth | null | undefined, weekly: number): string {
  const out: string[] = [];
  const changes = [
    f.growth3m !== null && `${trend(f.growth3m)} over 3 months`,
    f.growth11m !== null && `${trend(f.growth11m)} over 11 months`,
  ].filter(Boolean);
  // Humans per day are npm's spike-free curve times one ratio, so this must not read as a change in the bot share.
  if (changes.length) out.push(`Downloads with publish spikes removed are ${changes.join(' and ')}.`);
  const scale = marketText(f, market, weekly);
  if (scale) out.push(scale);
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

// One line under the number cards: which versions are in use says more than the total, especially at scale.
export function adoptionHtml(f: PackageFacts | undefined): string {
  const a = f?.adoption;
  // Nearly everything on the latest major says nothing worth a line this high up the page.
  if (!a || (a.isLatest && a.share >= 0.95)) return '';
  return `<p class="adoption">Most used major version: <strong class="num">${esc(a.major)}</strong>${
    a.isLatest ? ', the latest one' : ', <strong>not the latest one</strong>'
  }, with <strong class="num">${pct(a.share)}</strong> of last week's downloads above the crawler floor. Most used single version: ${esc(a.topVersion)}.</p>`;
}

// The trail of a package most of whose downloads seem to arrive through one other package. An ordered list, top to bottom.
export const chainListHtml = (steps: ChainStep[], base: string): string =>
  `<ol class="chain">${steps
    .map((s) => `<li><a href="${esc(base + s.name)}">${esc(s.name)}</a>${s.version ? ` <span class="chain-ver">${esc(s.version)}</span>` : ''} <span class="chain-n">${roundCount(s.weekly)} a week</span></li>`)
    .join('')}</ol>`;

export const CHAIN_GUIDE_PATH = 'docs/why-is-number-has-so-many-downloads';

export function chainHtml(name: string, steps: ChainStep[] | undefined, base: string): string {
  if (!steps || steps.length < 2) return '';
  const n = esc(name);
  return `<section class="insights">
        <h2 class="section-title">Where do the downloads of ${n} come from?</h2>
        <p>Probably mostly through other packages. Each package below requires the one above it, and their weekly downloads on the matching versions line up within about 30%. This is an inference from download counts, not something npm records.</p>
        ${chainListHtml(steps, base)}
        <p>Past ${esc(steps.at(-1)!.name)} the trail splits or we can't follow it. These are still real installs, but the people running them may never have chosen ${n}. <a href="${esc(base + CHAIN_GUIDE_PATH)}">How a package ends up like this</a>.</p>
      </section>`;
}

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' });
const STEADY = 1.1; // busiest over quietest month below this: no "busiest month" sentence

// Month by month, newest first. Change compares spike-free downloads per day, so 28- and 31-day months and outage
// days compare fairly. Real installs are only this week's split applied to each month, which the caption says.
export function monthlyHtml(name: string, f: PackageFacts | undefined): string {
  const m = f?.monthly;
  if (!m?.months.length) return '';
  const perDay = m.cleaned.map((c, i) => (m.days[i] ? c / m.days[i] : 0));
  const comparable = (i: number) => m.days[i] >= MONTH_MIN_DAYS && perDay[i] >= GROWTH_MIN_DAILY;
  const rows = m.months
    .map((month, i) => {
      const spikes = m.npm[i] - m.cleaned[i];
      const share = m.npm[i] ? spikes / m.npm[i] : 0;
      const change = i > 0 && comparable(i) && comparable(i - 1) ? trend(perDay[i] / perDay[i - 1] - 1) : '—';
      return `<tr><th scope="row">${esc(monthName(month))}</th>
          <td class="num" data-label="npm downloads">${num(m.npm[i])}</td>
          <td class="num" data-label="publish spikes removed">${spikes > 0 ? `${num(spikes)} <span class="ev-sub">(${pct(share)})</span>` : '0'}</td>
          <td class="num above" data-label="real installs">${rangeText(m.low[i], m.high[i])}</td>
          <td class="num" data-label="vs month before">${esc(change)}</td></tr>`;
    })
    .reverse()
    .join('');

  const ok = m.months.map((_, i) => i).filter(comparable);
  let summary = '';
  if (ok.length >= 2) {
    const best = ok.reduce((a, b) => (perDay[b] > perDay[a] ? b : a));
    const worst = ok.reduce((a, b) => (perDay[b] < perDay[a] ? b : a));
    const holiday = m.months[worst].endsWith('-12') ? ' (the holiday season)' : '';
    summary = perDay[best] / perDay[worst] < STEADY
      ? 'Once publish spikes are removed, daily downloads stayed within 10% from month to month.'
      : `The busiest month was ${monthName(m.months[best])}, with about ${num(perDay[best])} downloads a day once publish spikes are removed; the quietest was ${monthName(m.months[worst])}${holiday}, with about ${num(perDay[worst])}.`;
  }
  const n = esc(name);
  return `<section class="insights monthly">
        <h2 class="section-title">Monthly downloads of ${n}</h2>
        ${summary ? `<p>${esc(summary)}</p>` : ''}
        <div class="table-wrap"><table class="cmp-table">
          <thead><tr><th scope="col">month</th><th scope="col" class="num">npm downloads</th><th scope="col" class="num">publish spikes removed</th><th scope="col" class="num">real installs</th><th scope="col" class="num">vs month before</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="fineprint">Whole months through ${esc(date(monthEnd(m.months.at(-1)!)))}. Publish spikes are found day by day and summed per month. Real installs apply this week's crawler share to each month's downloads (the upper end also keeps the removed spikes), so they follow npm's curve rather than measure it. The change compares spike-free downloads per day.</p>
      </section>`;
}

export function factsHtml(name: string, f: PackageFacts, market?: MarketGrowth | null, npmWeekly = 0): string {
  const n = esc(name);
  const used = usedText(f, market, npmWeekly);
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
