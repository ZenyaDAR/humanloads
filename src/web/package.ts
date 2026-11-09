import { awaitingEvidence, estimate } from '../core/estimate.ts';
import { fetchEvidence, fetchPackageData } from '../core/sources.ts';
import {
  PackageNotFoundError, type Calibration, type Estimate, type Evidence, type InsightsFile, type ListsFile, type RawPackageData, type RegistryDoc,
} from '../core/types.ts';
import { adoptionHtml, chainHtml, factsHtml, monthlyHtml, packageFacts } from '../core/insights.ts';
import { LISTS_FILE, LIST_NAMES, categoryRankHtml } from '../core/lists.ts';
import { REPO_URL, peopleAnswerHtml, deprecatedHtml, numberCardsHtml } from '../core/seo.ts';
import { mountChart } from './chart.ts';
import { searchBox } from './home.ts';
import {
  BASE, SITE_URL, esc, fetchStatic, fmt, fmtCompact, METHODOLOGY_URL, navigate, pkgHref, safeName, safeUrl, setPageMeta, timeAgo,
} from './util.ts';
import { compareLinksHtml } from '../core/seo.ts';
import COMPARE_PAIRS from '../../data/compare.json';

const CACHE_TTL = 60 * 60 * 1000;
const VISIBLE_VERSIONS = 12;
const TRACKED_URL = `${REPO_URL}/blob/main/data/tracked.json`;

function readCache(name: string): RawPackageData | null {
  try {
    const hit = JSON.parse(sessionStorage.getItem(`humanloads:${name}`) ?? 'null');
    // Ignore entries with an unexpected shape (older builds, manual edits).
    const ok =
      Array.isArray(hit?.data?.downloads) && hit.data.registry && typeof hit.data.versionsLastWeek === 'object';
    return ok && Date.now() - hit.t < CACHE_TTL ? hit.data : null;
  } catch {
    return null;
  }
}

function writeCache(name: string, data: RawPackageData): void {
  try {
    sessionStorage.setItem(`humanloads:${name}`, JSON.stringify({ t: Date.now(), data }));
  } catch {
    // Storage disabled or full: caching is optional.
  }
}

// Session-cached package data, shared with the compare page.
export async function getData(name: string, force = false): Promise<RawPackageData> {
  const hit = force ? null : readCache(name);
  if (hit) return hit;
  const data = await fetchPackageData(name);
  writeCache(name, data);
  return data;
}

// calibration.json is optional: without it the model uses its built-in floor.
export async function calibration(): Promise<Calibration | undefined> {
  const c = await fetchStatic<Calibration>('data/calibration.json');
  return c && typeof c.floorPerVersion === 'number' ? c : undefined;
}

export function renderPackage(view: HTMLElement, name: string): void {
  void load(view, name, false);
}

// Replace the view's content; if its h1 (the skeleton's, after a route change) had focus, move focus
// to the new h1 so screen-reader and keyboard users are not dropped to <body>.
function paint(view: HTMLElement, html: string): void {
  // Any focused element inside the view (skeleton h1, the "Try again" button) is about to be replaced.
  const hadFocus = view.contains(document.activeElement);
  view.innerHTML = html;
  if (hadFocus) view.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
}

async function load(view: HTMLElement, name: string, force: boolean): Promise<void> {
  try {
    if (force || !readCache(name)) paint(view, skeleton(name));
    const [data, cal, insights] = await Promise.all([getData(name, force), calibration(), fetchStatic<InsightsFile>('data/insights.json')]);
    if (!view.isConnected) return; // user navigated away while we were fetching

    const est = estimate(data, { calibration: cal });
    const total = est.daily.reduce((s, d) => s + d.npm, 0);
    paint(
      view,
      `
    <article class="pkg">
      ${header(data.registry, name)}
      ${total === 0 ? zero(name) : body(est, name, data, insights)}
      <section class="evidence" aria-busy="true" aria-labelledby="ev-title">
        <h2 class="section-title" id="ev-title">Independent evidence of use</h2>
        <p class="evidence-lede hand">checking dependents, CDN and GitHub…</p>
      </section>
      <div class="tools">
        <section class="compare-with" aria-labelledby="cmp-title"><h2 class="section-title" id="cmp-title">Compare with…</h2></section>
        <section class="badge-box" hidden></section>
      </div>
      ${compareLinksHtml(BASE, COMPARE_PAIRS.filter((p) => p.includes(name)), esc, `Compare ${name}`)}
      <p class="method"><a href="${METHODOLOGY_URL}">How we filter this <span aria-hidden="true">→</span></a></p>
    </article>`,
    );
    view.querySelector('.compare-with')!.append(
      searchBox('cmp', {
        label: `Package to compare with ${name}`,
        placeholder: 'another package…',
        button: 'Compare',
        onPick: (other) => other !== name && navigate(`${BASE}compare/${name},${other}`),
      }),
    );
    void badge(view.querySelector<HTMLElement>('.badge-box')!, name);
    // After paint, and only for packages in a list: lists.json is not needed for anything else on this page.
    const rankSlot = view.querySelector<HTMLElement>('.rank-slot');
    if (rankSlot) {
      void fetchStatic<ListsFile>(LISTS_FILE).then((lists) => {
        if (rankSlot.isConnected) rankSlot.outerHTML = categoryRankHtml(name, lists, BASE);
      });
    }
    if (total > 0) {
      mountChart(view.querySelector<HTMLElement>('.chart')!, [{ est, label: name, color: '--marker' }]);
      const more = view.querySelector<HTMLButtonElement>('.versions-more');
      more?.addEventListener('click', () => {
        view.querySelectorAll<HTMLElement>('tr[hidden]').forEach((tr) => (tr.hidden = false));
        more.remove();
      });
    }

    // Progressive: the estimate is already on screen; evidence fills in, then refines confidence and notes.
    // Its own try: an evidence failure must not replace the estimate with the error state.
    const evHost = view.querySelector<HTMLElement>('.evidence')!;
    try {
      const ev = await fetchEvidence(name, data.registry);
      if (!view.isConnected) return;
      fillEvidence(evHost, ev);
      const cardsEl = view.querySelector('.cards');
      if (cardsEl) {
        const open = cardsEl.querySelector<HTMLDetailsElement>('.why')?.open; // keep the disclosure as the reader left it
        cardsEl.outerHTML = cards(estimate(data, { calibration: cal, evidence: ev }));
        if (open) view.querySelector<HTMLDetailsElement>('.why')!.open = true;
      }
    } catch {
      const cardsEl = view.querySelector('.cards');
      if (cardsEl) cardsEl.outerHTML = cards(est); // nothing more is coming, so stop saying "checking"
      evHost.removeAttribute('aria-busy');
      const lede = evHost.querySelector('.evidence-lede');
      if (lede) {
        lede.className = 'evidence-lede';
        lede.textContent = 'Usage evidence is unavailable right now.';
      }
    }
  } catch (err) {
    if (!view.isConnected) return;
    if (err instanceof PackageNotFoundError) {
      // A package npm does not know: keep it out of search indexes.
      setPageMeta(`Not found · humanloads`, `npm has no package called ${name}.`, null);
      paint(
        view,
        `
          <section class="state state-missing">
            <h1 tabindex="-1">No package called <code>${esc(name)}</code></h1>
            <p>npm has never heard of it. ${
              name !== name.toLowerCase()
                ? `Did you mean <a href="${BASE}${esc(name.toLowerCase())}">${esc(name.toLowerCase())}</a>?`
                : `Check the spelling, or <a href="${BASE}">search for it</a>.`
            }</p>
          </section>`,
      );
    } else {
      paint(
        view,
        `
          <section class="state state-error" role="alert">
            <h1 tabindex="-1">The npm API did not answer</h1>
            <p>It may be rate limiting us, or you may be offline. Nothing is wrong with <code>${esc(name)}</code>.</p>
            <p class="state-detail">${esc(err instanceof Error ? err.message : String(err))}</p>
            <button type="button" class="btn">Try again</button>
          </section>`,
      );
      view.querySelector('button')!.addEventListener('click', () => void load(view, name, true));
    }
  }
}

function skeleton(name: string): string {
  return `
    <div class="skeleton" aria-busy="true" role="status">
      <h1 class="hand" tabindex="-1">measuring ${esc(name)}…</h1>
      <div class="sk sk-line"></div>
      <div class="sk-cards"><div class="sk sk-card"></div><div class="sk sk-card"></div></div>
      <div class="sk sk-chart"></div>
    </div>`;
}

function header(reg: RegistryDoc, name: string): string {
  const version = reg['dist-tags'].latest;
  const repo = safeUrl(typeof reg.repository === 'string' ? reg.repository : reg.repository?.url);
  const home = safeUrl(reg.homepage);
  const links = [
    reg.license ? `<li>${esc(reg.license)}</li>` : '',
    `<li><a href="https://www.npmjs.com/package/${esc(name)}">npm</a></li>`,
    repo ? `<li><a href="${esc(repo)}">${new URL(repo).hostname === 'github.com' ? 'github' : 'repository'}</a></li>` : '',
    home && home !== repo && !home.startsWith(`${repo}#`) ? `<li><a href="${esc(home)}">homepage</a></li>` : '',
  ];
  return `
    <header class="pkg-head">
      <h1 tabindex="-1"><span class="pkg-name">${esc(name)}</span>${version ? ` <span class="pkg-ver">v${esc(version)}</span>` : ''}</h1>
      ${reg.description ? `<p class="pkg-desc">${esc(reg.description)}</p>` : ''}
      <ul class="pkg-links">${links.join('')}</ul>
      ${reg.deprecated ? deprecatedHtml(reg.deprecated) : ''}
    </header>`;
}

function zero(name: string): string {
  return `
    <section class="state state-zero">
      <p class="hand big-note">Nobody downloaded ${esc(name)} in the last year. Not even the robots.</p>
      <p>npm reports 0 downloads, so there is nothing to estimate yet.</p>
    </section>`;
}

function body(est: Estimate, name: string, data: RawPackageData, insights: InsightsFile | null): string {
  const lastDay = est.daily[est.daily.length - 1]?.day;
  const facts = packageFacts(data, est);
  return `
    ${cards(est, awaitingEvidence(est))}
    ${adoptionHtml(facts)}
    ${lastDay ? `<p class="fineprint">Last 7 days of npm data, through ${esc(lastDay)}. npm publishes counts 1–2 days late.</p>` : ''}

    <figure class="chart-fig">
      <figcaption>
        <h2 class="section-title">Twelve months, week by week</h2>
        <ul class="legend">
          <li><span class="key key-npm" aria-hidden="true"></span>npm downloads</li>
          <li><span class="key key-human" aria-hidden="true"></span>real installs</li>
          <li><span class="key key-band" aria-hidden="true"></span>likely range</li>
          <li><span class="key key-note" aria-hidden="true">v1</span>new version published</li>
        </ul>
      </figcaption>
      <div class="chart"></div>
      <p class="fineprint">The vertical scale is square-root, so small numbers stay visible next to big spikes. Real installs in past weeks are this week's share applied to the spike-free count, not separate measurements.</p>
    </figure>

    ${peopleAnswerHtml(name, { npm: est.lastWeek.npm, organic: est.lastWeek.organic, low: est.lastWeek.low, high: est.lastWeek.high, confidence: est.confidence, tooNew: est.tooNew })}
    ${facts ? factsHtml(name, facts, insights?.market, est.lastWeek.npm) : ''}
    ${monthlyHtml(name, facts)}
    ${LIST_NAMES.includes(name) ? '<div class="rank-slot"></div>' : ''}
    ${chainHtml(name, insights?.chains[name], BASE)}
    ${breakdown(est)}
    ${versions(est, name)}`;
}

// The two number cards. Re-rendered on its own once evidence arrives (confidence and notes may change).
function cards(est: Estimate, checking = false): string {
  const w = est.lastWeek;
  const notes = est.notes.length ? `<ul class="notes">${est.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  return numberCardsHtml(
    { npm: w.npm, organic: w.organic, low: w.low, high: w.high, confidence: est.confidence, tooNew: est.tooNew, checking },
    notes + rhythm(est),
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const JITTER = [0.6, -0.4, 0.3, -0.7, 0.5, -0.3, 0.4]; // fixed wobble: the drawing is stable across renders

// Mon..Sun average of the cleaned series over the last 8 weeks, as a tiny hand-drawn bar chart.
function rhythm(est: Estimate): string {
  const ratio = est.signals?.weekdayRatio;
  // Same cutoff as the notes in estimate.ts: below it the filtered count is noise, so a rhythm would contradict it.
  if (ratio == null || est.tooNew || est.lastWeek.organic < 10) return '';
  const sums = Array<number>(7).fill(0);
  const counts = Array<number>(7).fill(0);
  for (const d of est.daily.slice(-56)) {
    const i = (new Date(`${d.day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    sums[i] += d.cleaned;
    counts[i]++;
  }
  const avg = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  const max = Math.max(1, ...avg);
  const bars = avg
    .map((v, i) => {
      const h = Math.max(1, (v / max) * 19);
      const x = 3 + i * 9;
      const j = JITTER[i];
      return `<path class="${i >= 5 ? 'rb-end' : 'rb-day'}" d="M${x} 23 L${x + j * 0.5} ${(23 - h).toFixed(1)} L${x + 6 + j} ${(23 - h + j * 0.6).toFixed(1)} L${x + 6} 23 Z"/>`;
    })
    .join('');
  const label = `Average daily downloads by weekday, last 8 weeks: ${avg.map((v, i) => `${WEEKDAYS[i]} ${fmt(v)}`).join(', ')}.`;
  return `<p class="rhythm">
      <svg class="rhythm-svg" viewBox="0 0 68 26" width="68" height="26" role="img" aria-label="${esc(label)}">${bars}<path class="rb-base" d="M0 23.5 Q 34 22.6 68 23.8"/></svg>
      <span class="hand">weekday rhythm ×${ratio.toFixed(1)}</span>
    </p>`;
}

// ---------- evidence: "Who actually uses it" ----------

const NA = '<span class="na" title="Unavailable: this source did not answer">—<span class="sr-only"> (unavailable)</span></span>';
const count = (n: number | null | undefined) => (n == null ? NA : `<strong class="num">${fmt(n)}</strong>`);

function fillEvidence(host: HTMLElement, ev: Evidence): void {
  const gh = ev.github;
  const repoUrl = gh && /^[\w.-]+\/[\w.-]+$/.test(gh.repo) ? `https://github.com/${gh.repo}` : null;
  const pushed = gh ? timeAgo(gh.pushedAt) : '';
  const code = safeUrl(ev.codeSearchUrl);
  const stats: [string, string, string][] = [
    ['dependent packages', count(ev.dependentPackages), 'on npm'],
    ['dependent repos', count(ev.dependentRepos), 'open-source repositories'],
    ['jsDelivr hits', count(ev.cdnHitsMonth), 'last month, from browsers'],
    [
      'GitHub',
      gh ? `<strong class="num">★ ${fmtCompact(gh.stars)}</strong> <span class="ev-sub">· ${fmtCompact(gh.forks)} forks</span>` : NA,
      gh
        ? `${repoUrl ? `<a href="${esc(repoUrl)}">${esc(gh.repo)}</a>` : esc(gh.repo)}${pushed ? ` · pushed ${esc(pushed)}` : ''}`
        : 'stars and forks',
    ],
  ];
  const top = (ev.topDependents ?? []).slice(0, 12);
  host.removeAttribute('aria-busy');
  host.innerHTML = `
    <h2 class="section-title" id="ev-title">Independent evidence of use</h2>
    <p class="evidence-lede">Download counts are easy to inflate. These numbers are harder to fake.</p>
    <dl class="ev-grid">
      ${stats.map(([dt, dd, sub]) => `<div class="ev"><dt>${dt}</dt><dd>${dd}</dd><dd class="ev-sub">${sub}</dd></div>`).join('')}
    </dl>
    ${
      top.length
        ? `<p class="ev-top-title hand">some packages that depend on it</p>
           <ul class="ev-top">${top
             .map(
               (d) =>
                 `<li><a class="tag" href="${esc(pkgHref(d.name))}">${esc(d.name)}</a>${
                   d.downloads != null ? `<span class="ev-sub"> ${fmtCompact(d.downloads)} downloads</span>` : ''
                 }</li>`,
             )
             .join('')}</ul>`
        : ''
    }
    ${code ? `<p class="ev-code"><a href="${esc(code)}">Search GitHub for usages <span aria-hidden="true">→</span></a></p>` : ''}`;
}

// ---------- README badge ----------

async function badge(host: HTMLElement, name: string): Promise<void> {
  const index = await fetchStatic<string[]>('badges/index.json');
  if (!host.isConnected) return;
  host.hidden = false;
  if (!Array.isArray(index) || !index.includes(name)) {
    host.innerHTML = `
      <h2 class="section-title">Want a badge?</h2>
      <p class="badge-ask">README badges are built for tracked packages. Add <code>${esc(name)}</code> to the list with a
        <a href="${TRACKED_URL}">one-line pull request</a>.</p>`;
    return;
  }
  const json = `${SITE_URL}badges/${safeName(name)}.json`;
  const img = `https://img.shields.io/endpoint?url=${encodeURIComponent(json)}`;
  const md = `[![real installs per week](${img})](${SITE_URL}${name})`;
  // The preview is drawn from our own badge JSON (the same file shields.io reads), so it shows
  // the real numbers even before a deploy and costs no third-party request.
  const data = await fetchStatic<{ label: string; message: string; color: string }>(`badges/${safeName(name)}.json`);
  if (!host.isConnected) return;
  const preview = data
    ? `<span class="shield" role="img" aria-label="Badge preview: ${esc(data.label)} ${esc(data.message)}">
        <span class="shield-l">${esc(data.label)}</span><span class="shield-r shield-${esc(data.color)}">${esc(data.message)}</span></span>`
    : '';
  host.innerHTML = `
    <h2 class="section-title">Add a badge to your README</h2>
    <div class="badge-row">
      ${preview}
      <button type="button" class="btn btn-quiet">Copy markdown</button>
      <p class="badge-status" aria-live="polite"></p>
    </div>
    <p class="fineprint">The badge is rebuilt nightly, so it can trail the live numbers above by a day or two.</p>
    <details class="badge-more"><summary>Show markdown</summary><code class="badge-md">${esc(md)}</code></details>`;
  const code = host.querySelector<HTMLElement>('.badge-md')!;
  const status = host.querySelector<HTMLElement>('.badge-status')!;
  host.querySelector('button')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(md);
      status.textContent = 'Copied.';
    } catch {
      // No Clipboard API (plain http, old browser, permission denied): select the text so Ctrl+C works.
      host.querySelector('details')!.open = true;
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      status.textContent = 'Selected. Press Ctrl+C (⌘C on Mac) to copy.';
    }
  });
}

// ---------- breakdown and versions ----------

function breakdown(est: Estimate): string {
  // Year totals that add up exactly to npm's count: spikes removed, then floor, then what remains.
  const mirrors = est.daily.reduce((s, d) => s + Math.max(0, d.npm - d.cleaned), 0);
  const humans = est.daily.reduce((s, d) => s + Math.min(d.organic, d.cleaned), 0);
  const crawlers = est.daily.reduce((s, d) => s + Math.max(0, d.cleaned - d.organic), 0);
  const total = mirrors + crawlers + humans || 1;
  const b = est.breakdown;
  const parts = [
    { key: 'mirrors', label: 'mirrors & scanners', value: mirrors, extra: 'spikes right after each publish' },
    { key: 'crawlers', label: 'crawlers', value: crawlers, extra: `about ${fmt(b.crawlersWeekly)} / week` },
    { key: 'humans', label: 'CI, dependency installs and people', value: humans, extra: `about ${fmt(b.organicWeekly)} / week` },
  ];
  return `
    <section class="breakdown">
      <h2 class="section-title">Where the downloads went</h2>
      <p class="breakdown-lede">All ${fmt(Math.round(total))} npm downloads of the last 12 months, sorted by what most likely made them. Crawlers and real installs use this week's split for the whole year, so treat them as a rough guide.</p>
      <div class="bar" aria-hidden="true">
        ${parts
          .filter((p) => p.value > 0)
          .map((p) => `<span class="seg seg-${p.key}" style="flex-grow:${(p.value / total).toFixed(5)}"></span>`)
          .join('')}
      </div>
      <dl class="bar-legend">
        ${parts
          .map(
            (p) => `<div><dt><span class="key seg-${p.key}" aria-hidden="true"></span>${p.label}</dt>
              <dd><strong>${fmt(p.value)}</strong> · ${Math.round((p.value / total) * 100)}% · ${esc(p.extra)}</dd></div>`,
          )
          .join('')}
      </dl>
    </section>`;
}

function versions(est: Estimate, name: string): string {
  const rows = est.versions;
  if (!rows.length) return '';
  const f = est.breakdown.crawlerFloorPerVersion;
  const max = Math.max(1, ...rows.map((r) => r.downloads));
  const floorPct = f === null ? null : Math.min(100, (f / max) * 100);
  const floorText =
    f === null
      ? `Too few versions to measure the crawler floor for ${esc(name)}, so a global estimate is used.`
      : `Crawler floor: <strong class="num">${fmt(f)}</strong> fetches per version per week. Robots download every version about this often, used or not. Only what sits above the dashed line is left after filtering.`;
  return `
    <section class="versions">
      <h2 class="section-title">By version, last 7 days</h2>
      <p class="versions-lede">${floorText}</p>
      <div class="table-wrap">
        <table style="${floorPct === null ? '' : `--floor:${floorPct.toFixed(2)}%`}">
          <thead><tr><th scope="col">version</th><th scope="col" class="num">downloads</th><th scope="col" class="num">above floor</th><th scope="col" class="bar-col"><span class="sr-only">chart</span></th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r, i) => `<tr${i >= VISIBLE_VERSIONS ? ' hidden' : ''}>
                  <th scope="row">${esc(r.version)}</th>
                  <td class="num">${fmt(r.downloads)}</td>
                  <td class="num${r.aboveFloor > 0 ? ' above' : ''}">${fmt(r.aboveFloor)}</td>
                  <td class="bar-col" aria-hidden="true"><span class="vbar">
                    <span class="vbar-floor" style="width:${(((r.downloads - r.aboveFloor) / max) * 100).toFixed(2)}%"></span><span class="vbar-above" style="width:${((r.aboveFloor / max) * 100).toFixed(2)}%"></span>
                  </span></td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
      ${rows.length > VISIBLE_VERSIONS ? `<button type="button" class="btn btn-quiet versions-more">Show all ${rows.length} versions</button>` : ''}
    </section>`;
}
