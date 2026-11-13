import { addDays, awaitingEvidence, estimate } from '../core/estimate.ts';
import { fetchEvidence, fetchPackageData, isValidPackageName, parseGithubRepo } from '../core/sources.ts';
import {
  PackageNotFoundError, type Calibration, type Estimate, type Evidence, type InsightsFile, type ListsFile, type RawPackageData, type RegistryDoc, type ShieldsBadge,
} from '../core/types.ts';
import { badgeOf } from '../core/badge.ts';
import { chainHtml, factsHtml, maintainedPanelHtml, monthlyHtml, packageFacts, type PackageFacts } from '../core/insights.ts';
import { LISTS_FILE, LIST_NAMES, categoryRankHtml, categoryRankLineHtml } from '../core/lists.ts';
import { checkMark } from '../core/layout.ts';
import { GUIDES } from '../core/guides.ts';
import { FILTERED_NOTE, REPO_URL, comparePath, peopleAnswerHtml, deprecatedHtml, numberCardsHtml } from '../core/seo.ts';
import { mountChart } from './chart.ts';
import { searchBox } from './home.ts';
import {
  BADGE_API, BASE, SITE_URL, esc, fetchStatic, fmt, fmtCompact, fmtDate, METHODOLOGY_URL, navigate, pkgHref, safeName, safeUrl, setPageMeta, timeAgo,
} from './util.ts';
import COMPARE_PAIRS from '../../data/compare.json';

const CACHE_TTL = 60 * 60 * 1000;
const CACHE_PREFIX = 'humanloads:v2:'; // v2: the registry doc carries readme, dependencies and package facts
const VISIBLE_VERSIONS = 12;
const TRACKED_URL = `${REPO_URL}/blob/main/data/tracked.json`;
const JOURNAL_GUIDE = GUIDES.find((g) => g.path === 'docs/are-npm-downloads-real') ?? GUIDES[0];

function readCache(name: string): RawPackageData | null {
  try {
    const hit = JSON.parse(sessionStorage.getItem(CACHE_PREFIX + name) ?? 'null');
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
    sessionStorage.setItem(CACHE_PREFIX + name, JSON.stringify({ t: Date.now(), data }));
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

// staticBody: the prerendered page body, shown instead of the skeleton and kept if the npm API fails.
export function renderPackage(view: HTMLElement, name: string, staticBody?: string): void {
  if (staticBody) view.innerHTML = staticBody;
  void load(view, name, false, !!staticBody);
}

// Replace the view's content; if its h1 (the skeleton's, after a route change) had focus, move focus
// to the new h1 so screen-reader and keyboard users are not dropped to <body>.
function paint(view: HTMLElement, html: string): void {
  // Any focused element inside the view (skeleton h1, the "Try again" button) is about to be replaced.
  const hadFocus = view.contains(document.activeElement);
  view.innerHTML = html;
  if (hadFocus) view.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
}

async function load(view: HTMLElement, name: string, force: boolean, hasStatic = false): Promise<void> {
  try {
    if (!hasStatic && (force || !readCache(name))) paint(view, skeleton(name));
    const [data, cal, insights] = await Promise.all([getData(name, force), calibration(), fetchStatic<InsightsFile>('data/insights.json')]);
    if (!view.isConnected) return; // user navigated away while we were fetching

    const est = estimate(data, { calibration: cal });
    const total = est.daily.reduce((s, d) => s + d.npm, 0);
    const facts = packageFacts(data, est);
    paint(
      view,
      `
    <article class="pkg">
      ${header(data.registry, name)}
      <div class="pkg-grid">
        <div class="pkg-main">
          ${total === 0 ? zero(name) : body(est, name, data.registry, facts, insights)}
        </div>
        ${sidebar(data.registry, name, facts)}
      </div>
    </article>`,
    );
    // The box goes right under the title, above the ready-made "vs" links.
    view.querySelector('.compare-with .sheet-title')!.after(
      searchBox('cmp', {
        label: `Package to compare with ${name}`,
        placeholder: 'another package…',
        button: 'Compare',
        onPick: (other) => other !== name && navigate(`${BASE}compare/${name},${other}`),
      }),
    );
    wireInstall(view.querySelector<HTMLElement>('.install')!, name);
    wireTabs(view, { readme: () => void fillReadme(view.querySelector<HTMLElement>('.readme')!, data.registry) });
    // The badge preview follows the estimate: evidence below can raise confidence, as the badge service does.
    let latest = est;
    void badge(view.querySelector<HTMLElement>('.badge-box')!, name, () => latest);
    // After paint, and only for packages in a list: lists.json is not needed for anything else on this page.
    if (LIST_NAMES.includes(name)) {
      void fetchStatic<ListsFile>(LISTS_FILE).then((lists) => {
        const rankSlot = view.querySelector<HTMLElement>('.rank-slot');
        if (rankSlot) rankSlot.outerHTML = categoryRankHtml(name, lists, BASE);
        view.querySelector('#mt-h')?.parentElement?.insertAdjacentHTML('beforeend', categoryRankLineHtml(name, lists, BASE));
      });
    }
    if (total > 0) {
      const setRange = mountChart(view.querySelector<HTMLElement>('.chart')!, [{ est, label: name, color: '--blue' }]);
      view.querySelectorAll<HTMLButtonElement>('.range button').forEach((b) =>
        b.addEventListener('click', () => {
          view.querySelectorAll('.range button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
          setRange(Number(b.dataset.weeks));
        }),
      );
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
      const count = view.querySelector('#tab-dependents .tab-count');
      if (count && ev.dependentPackages != null) count.textContent = fmtCompact(ev.dependentPackages);
      latest = estimate(data, { calibration: cal, evidence: ev });
      const cardsEl = view.querySelector('.cards');
      if (cardsEl) cardsEl.outerHTML = cards(latest, false, ev);
      fillEvidenceFacts(view, ev);
      const live = view.querySelector('.badge-box .shield[data-live]');
      if (live) live.outerHTML = shieldHtml(badgeOf(latest), true);
    } catch {
      const cardsEl = view.querySelector('.cards');
      if (cardsEl) cardsEl.outerHTML = cards(est); // nothing more is coming, so stop saying "checking"
      evHost.removeAttribute('aria-busy');
      const lede = evHost.querySelector('.evidence-lede');
      if (lede) {
        lede.className = 'evidence-lede';
        lede.textContent = 'Could not load dependents, CDN and GitHub data. Reload the page to try again.';
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
    } else if (hasStatic) {
      return; // the prerendered snapshot stays: older numbers beat an error page
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

// Same boxes as the real page, so it doesn't jump when the data arrives.
function skeleton(name: string): string {
  return `
    <div class="skeleton" aria-busy="true" role="status">
      <h1 class="hand" tabindex="-1">measuring ${esc(name)}…</h1>
      <div class="sk sk-line"></div>
      <div class="row-a"><div class="sk sk-card"></div><div class="sk sk-chart"></div></div>
    </div>`;
}

function header(reg: RegistryDoc, name: string): string {
  const version = reg['dist-tags'].latest;
  const published = version && typeof reg.time[version] === 'string' ? timeAgo(reg.time[version] as string) : '';
  const repo = safeUrl(typeof reg.repository === 'string' ? reg.repository : reg.repository?.url);
  const home = safeUrl(reg.homepage);
  const deps = Object.keys(reg.dependencies ?? {}).length;
  const by = reg.publisher ? ` by <a href="${esc(npmUser(reg.publisher))}">${esc(reg.publisher)}</a>` : '';
  const links = [
    reg.license ? `<li>${esc(reg.license)}</li>` : '',
    version ? `<li>${fmt(deps)} ${deps === 1 ? 'dependency' : 'dependencies'}</li>` : '',
    reg.types ? '<li>types included</li>' : '',
    reg.moduleFormats?.length ? `<li>${reg.moduleFormats.map((f) => f.toUpperCase()).join(' + ')}</li>` : '',
    repo ? `<li><a href="${esc(repo)}">${new URL(repo).hostname === 'github.com' ? 'github' : 'repository'}</a></li>` : '',
    home && home !== repo && !home.startsWith(`${repo}#`) ? `<li><a href="${esc(home)}">${esc(new URL(home).hostname.replace(/^www\./, ''))}</a></li>` : '',
  ];
  return `
    <header class="pkg-head">
      <div class="pkg-title">
        <div class="pkg-titleline">
          <h1 tabindex="-1"><span class="pkg-name">${esc(name)}</span>${version ? ` <span class="pkg-ver num">${esc(version)}</span>` : ''}</h1>
          ${published ? `<p class="pkg-meta">latest · published ${esc(published)}${by}</p>` : ''}
        </div>
        ${reg.description ? `<p class="pkg-desc">${esc(reg.description)}</p>` : ''}
        <ul class="pkg-links num">${links.join('')}</ul>
        ${reg.deprecated ? deprecatedHtml(reg.deprecated) : ''}
      </div>
      <div class="pkg-actions">
        <a class="btn-line" href="#compare-with">Compare</a>
        <a class="btn-line btn-line-b" href="#badge">README badge</a>
      </div>
    </header>`;
}

function zero(name: string): string {
  return `
    <section class="state state-zero">
      <p class="hand big-note">Nobody downloaded ${esc(name)} in the last year. Not even the robots.</p>
      <p>npm reports 0 downloads, so there is nothing to estimate yet.</p>
    </section>
    ${usagePanel(true)}`;
}

const RANGES: [number, string][] = [[13, '3 mo'], [26, '6 mo'], [52, '1 yr']];

function body(est: Estimate, name: string, reg: RegistryDoc, facts: PackageFacts | undefined, insights: InsightsFile | null): string {
  const monthly = monthlyHtml(name, facts);
  const tabs: [string, string, string][] = [
    ['readme', 'Readme', ''],
    ['versions', 'Versions', est.versions.length ? fmt(est.versions.length) : ''],
    ['dependencies', 'Dependencies', fmt(Object.keys(reg.dependencies ?? {}).length)],
    ['dependents', 'Dependents', ''],
    ...(monthly ? [['monthly', 'Monthly', String(facts?.monthly?.months.length ?? '')] as [string, string, string]] : []),
    ['about', 'About', ''],
  ];
  return `
    <div class="row-a">
      ${cards(est, awaitingEvidence(est))}
      <figure class="chart-card">
        <figcaption>
          <h2 class="panel-title">Twelve months, week by week</h2>
          <div class="range" role="group" aria-label="Chart range">${RANGES.map(([w, l]) => `<button type="button" data-weeks="${w}" aria-pressed="${w === 52}">${l}</button>`).join('')}</div>
        </figcaption>
        <div class="chart"></div>
        <ul class="legend">
          <li><span class="key key-npm" aria-hidden="true"></span>npm downloads</li>
          <li><span class="key key-human" aria-hidden="true"></span>real installs</li>
          <li><span class="key key-band" aria-hidden="true"></span>likely range</li>
          <li><span class="key key-note" aria-hidden="true">v1</span>release, then mirrors copy it</li>
          <li class="legend-end">square-root scale</li>
        </ul>
      </figure>
    </div>

    <div class="strip">
      ${versionShare(est)}
      ${breakdown(est)}
      ${maintainedPanelHtml(facts)}
    </div>

    <div class="tabs" role="tablist" aria-label="Package details">${tabs
      .map(
        ([id, label, n], i) =>
          `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${label} <span class="tab-count num">${n}</span></button>`,
      )
      .join('')}</div>
    <div class="tab-panel" role="tabpanel" id="panel-readme" aria-labelledby="tab-readme"><article class="readme" aria-busy="true"><p class="evidence-lede hand">reading the README…</p></article></div>
    <div class="tab-panel" role="tabpanel" id="panel-versions" aria-labelledby="tab-versions" hidden>${versions(est, name)}</div>
    <div class="tab-panel" role="tabpanel" id="panel-dependencies" aria-labelledby="tab-dependencies" hidden>${dependencies(reg, name)}</div>
    ${usagePanel(false)}
    ${monthly ? `<div class="tab-panel" role="tabpanel" id="panel-monthly" aria-labelledby="tab-monthly" hidden>${monthly}</div>` : ''}
    <div class="tab-panel" role="tabpanel" id="panel-about" aria-labelledby="tab-about" hidden>
      ${peopleAnswerHtml(name, { npm: est.lastWeek.npm, organic: est.lastWeek.organic, low: est.lastWeek.low, high: est.lastWeek.high, confidence: est.confidence, tooNew: est.tooNew })}
      ${whyHtml(est)}
      ${facts ? factsHtml(name, facts, insights?.market, est.lastWeek.npm) : ''}
      ${LIST_NAMES.includes(name) ? '<div class="rank-slot"></div>' : ''}
      ${chainHtml(name, insights?.chains[name], BASE)}
      <p class="method"><a href="${METHODOLOGY_URL}">How we filter this <span aria-hidden="true">→</span></a></p>
    </div>`;
}

function usagePanel(standalone: boolean): string {
  const evidence = `<section class="evidence" aria-busy="true" aria-labelledby="ev-title">
        <h2 class="section-title" id="ev-title">Independent evidence of use</h2>
        <p class="evidence-lede hand">checking dependents, CDN and GitHub…</p>
      </section>`;
  return standalone ? evidence : `<div class="tab-panel" role="tabpanel" id="panel-dependents" aria-labelledby="tab-dependents" hidden>${evidence}</div>`;
}

// Folder tabs with the ARIA tab pattern: click, or arrow keys between tabs. `lazy` fills a panel the first time
// its tab is shown (the selected tab right away).
function wireTabs(view: HTMLElement, lazy: Record<string, () => void>): void {
  const tabs = [...view.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      view.querySelector<HTMLElement>(`#${t.getAttribute('aria-controls')}`)!.hidden = !on;
    }
    const id = tab.id.replace(/^tab-/, '');
    lazy[id]?.();
    delete lazy[id];
  };
  const first = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
  if (first) select(first);
  for (const [i, t] of tabs.entries()) {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  }
}

// The correction card. Re-rendered on its own once evidence arrives (confidence and notes may change).
// The notes behind the estimate live in the About tab, so the card itself stays as short as the design's.
function cards(est: Estimate, checking = false, ev?: Evidence): string {
  const w = est.lastWeek;
  const html = numberCardsHtml({ npm: w.npm, organic: w.organic, low: w.low, high: w.high, confidence: est.confidence, tooNew: est.tooNew, checking }, null);
  return html.replace(/<\/section>\s*$/, `${checksHtml(est, ev)}</section>`);
}

// "Why this estimate" for the About tab: what was removed, the filter's notes, the weekday rhythm, the data window.
function whyHtml(est: Estimate): string {
  const lastDay = est.daily.at(-1)?.day;
  const notes = est.notes.length ? `<ul class="notes">${est.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  return `<section class="why-sec">
      <h2 class="section-title">Why this estimate</h2>
      <p>${FILTERED_NOTE}</p>
      ${notes}${rhythm(est)}
      ${lastDay ? `<p class="fineprint">Last 7 days of npm data, through ${esc(lastDay)}. npm publishes counts 1–2 days late. In the chart, real installs in past weeks are this week's share applied to the spike-free count.</p>` : ''}
    </section>`;
}

// Same cutoff as estimate.ts: the floor is measured on versions published over two weeks before the last day.
function oldVersionCount(est: Estimate): number {
  const last = est.daily.at(-1)?.day;
  if (!last) return 0;
  const cutoff = addDays(last, -14);
  const day = new Map(est.publishes.flatMap((p) => p.versions.map((v) => [v, p.day] as const)));
  return est.versions.filter((r) => (day.get(r.version) ?? cutoff) < cutoff).length;
}

// Evidence lines under the card: only the ones that are true, each with a green check.
function checksHtml(est: Estimate, ev?: Evidence): string {
  const n = (x: number) => `<span class="num">${fmtCompact(x)}</span>`;
  const old = est.breakdown.crawlerFloorPerVersion !== null ? oldVersionCount(est) : 0;
  const lines = [
    old ? `crawler floor measured on ${n(old)} old versions` : '',
    ev?.dependentPackages ? `${n(ev.dependentPackages)} ${ev.dependentPackages === 1 ? 'package depends' : 'packages depend'} on it` : '',
    ev?.cdnHitsMonth ? `${n(ev.cdnHitsMonth)} jsDelivr hits last month` : '',
  ].filter(Boolean);
  return lines.length ? `<ul class="corr-checks">${lines.map((l) => `<li>${checkMark('tick-ok')}<span>${l}</span></li>`).join('')}</ul>` : '';
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

// ---------- sidebar: install, facts, badge, compare ----------

const PMS: [string, (n: string) => string][] = [
  ['npm', (n) => `npm i ${n}`],
  ['pnpm', (n) => `pnpm add ${n}`],
  ['yarn', (n) => `yarn add ${n}`],
  ['bun', (n) => `bun add ${n}`],
];

function sidebar(reg: RegistryDoc, name: string, f: PackageFacts | undefined): string {
  const repo = safeUrl(typeof reg.repository === 'string' ? reg.repository : reg.repository?.url);
  // [label, value, key]: rows with a key and no value wait hidden for the evidence (fillEvidenceFacts).
  const rows: [string, string, string?][] = [
    ...(reg['dist-tags'].latest ? [['Version', esc(reg['dist-tags'].latest)] as [string, string]] : []),
    ...(reg.license ? [['License', esc(reg.license)] as [string, string]] : []),
    ...(reg.unpackedSize ? [['Unpacked size', fmtBytes(reg.unpackedSize)] as [string, string]] : []),
    ...(reg.fileCount ? [['Total files', fmt(reg.fileCount)] as [string, string]] : []),
    ...(repo ? [['Repository', `<a href="${esc(repo)}">${esc(repo.replace(/^https?:\/\/(www\.)?/, ''))}</a>`] as [string, string]] : []),
    ['GitHub', '', 'github'],
    ['Dependent repos', '', 'repos'],
    ...(f?.lastPublish ? [['Last publish', `<span title="${esc(fmtDate(f.lastPublish))}">${esc(timeAgo(f.lastPublish))}</span>`] as [string, string]] : []),
    ...(reg.maintainers?.length
      ? [['Maintainers', avatars(reg.maintainers)] as [string, string]]
      : f?.maintainers
        ? [['Maintainers', fmt(f.maintainers)] as [string, string]]
        : []),
  ];
  const pairs = COMPARE_PAIRS.filter((p) => p.includes(name)).slice(0, 4);
  return `
    <aside class="pkg-side" aria-label="Package facts">
      <div class="sheet">
        <div class="sheet-sec install">
          <div class="sheet-row"><h2 class="sheet-title">Install</h2>
            <span class="pm" role="group" aria-label="Package manager">${PMS.map(([pm], i) => `<button type="button" class="num" aria-pressed="${i === 0}">${pm}</button>`).join('')}</span></div>
          <div class="cmd"><code class="num"><span aria-hidden="true">&gt; </span><span class="cmd-text">${esc(PMS[0][1](name))}</span></code>
            <button type="button" class="copy" aria-label="Copy install command"><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg></button></div>
          <p class="sr-only" aria-live="polite" data-copy-status></p>
        </div>
        <div class="sheet-sec"><dl class="facts">${rows.map(([k, v, key]) => `<div${key ? ` data-fact="${key}" hidden` : ''}><dt>${k}</dt><dd class="num">${v}</dd></div>`).join('')}</dl></div>
        <div class="sheet-sec badge-box" id="badge" hidden></div>
        <div class="sheet-sec compare-with" id="compare-with">
          <h2 class="sheet-title">Compare with…</h2>
          ${pairs.length ? `<p class="vs-links num">${pairs.map((p) => `<a class="quiet-link" href="${esc(BASE + comparePath(p))}">vs ${p.filter((n) => n !== name).map(esc).join(', ')}</a>`).join('')}</p>` : ''}
        </div>
      </div>
      <a class="from-journal" href="${esc(BASE + JOURNAL_GUIDE.path)}"><span class="hand">from the journal</span><span class="fj-title">${esc(JOURNAL_GUIDE.title.replace(/ · .*$/, ''))} <span aria-hidden="true">→</span></span></a>
    </aside>`;
}

// The sidebar rows that come from the evidence sources; a source that did not answer leaves its row hidden.
function fillEvidenceFacts(view: HTMLElement, ev: Evidence): void {
  const set = (key: string, html: string) => {
    const row = view.querySelector<HTMLElement>(`[data-fact="${key}"]`);
    if (!row) return;
    row.querySelector('dd')!.innerHTML = html;
    row.hidden = false;
  };
  if (ev.github) set('github', `★ ${esc(fmtCompact(ev.github.stars))} · ${esc(fmtCompact(ev.github.forks))} forks`);
  if (ev.dependentRepos != null) set('repos', esc(fmtCompact(ev.dependentRepos)));
}

function wireInstall(host: HTMLElement, name: string): void {
  const text = host.querySelector<HTMLElement>('.cmd-text')!;
  const status = host.querySelector<HTMLElement>('[data-copy-status]')!;
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('.pm button')];
  buttons.forEach((b, i) =>
    b.addEventListener('click', () => {
      buttons.forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      text.textContent = PMS[i][1](name);
    }),
  );
  host.querySelector('.copy')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text.textContent ?? '');
      status.textContent = 'Copied.';
    } catch {
      getSelection()?.selectAllChildren(text); // no Clipboard API: select it so Ctrl+C works
      status.textContent = 'Selected. Press Ctrl+C to copy.';
    }
  });
}

const npmUser = (name: string) => `https://www.npmjs.com/~${encodeURIComponent(name)}`;

// npm's own units: 1 kB = 1000 bytes.
function fmtBytes(n: number): string {
  return n < 1000 ? `${fmt(n)} B` : n < 1e6 ? `${Math.round(n / 1000)} kB` : `${(n / 1e6).toFixed(1)} MB`;
}

const MAX_AVATARS = 5;

// "colinhacks" -> "CO", "sindre-sorhus" -> "SS".
function initials(name: string): string {
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

function avatars(names: string[]): string {
  const more = names.length - MAX_AVATARS;
  return `<span class="avatars">${names
    .slice(0, MAX_AVATARS)
    // The initials are decoration; the name is read from the sr-only text, so no aria-label disagrees with what is shown.
    .map((n) => `<a class="avatar" href="${esc(npmUser(n))}" title="${esc(n)}"><span aria-hidden="true">${esc(initials(n))}</span><span class="sr-only">${esc(n)}</span></a>`)
    .join('')}${more > 0 ? `<span class="avatar avatar-more" title="${more} more">+${more}</span>` : ''}</span>`;
}

// ---------- tabs: dependencies, readme ----------

function dependencies(reg: RegistryDoc, name: string): string {
  const deps = Object.entries(reg.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (!deps.length) {
    return `<div class="empty">
        <p class="hand empty-note">Zero dependencies. Nothing to audit here.</p>
        <p class="empty-sub">Installing ${esc(name)} pulls in nothing else. A package with dependencies lists each one here, linked to its own real installs.</p>
      </div>`;
  }
  const version = reg['dist-tags'].latest;
  return `<section>
      <h2 class="section-title">What ${esc(name)} ${version ? `${esc(version)} ` : ''}installs</h2>
      <p class="versions-lede">Direct dependencies of the latest version. Each one links to its own page with npm downloads and real installs.</p>
      <div class="table-wrap"><table class="cmp-table dep-list">
        <thead><tr><th scope="col">package</th><th scope="col" class="num">version range</th></tr></thead>
        <tbody>${deps
          .map(
            ([d, range]) =>
              `<tr><th scope="row">${isValidPackageName(d) ? `<a href="${esc(pkgHref(d))}">${esc(d)}</a>` : esc(d)}</th><td class="num" data-label="version range">${esc(range)}</td></tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </section>`;
}

// npm stores this placeholder for packages published without a README.
const NO_README = /^\s*(?:ERROR: No README data found!)?\s*$/;
const ABSOLUTE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

// GitHub's heading anchors, prefixed like GitHub's so README ids never clash with the page's own.
const slug = (text: string) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

async function fillReadme(host: HTMLElement, reg: RegistryDoc): Promise<void> {
  const repo = parseGithubRepo(reg.repository);
  const repoUrl = repo ? `https://github.com/${repo}` : safeUrl(typeof reg.repository === 'string' ? reg.repository : reg.repository?.url);
  const view = repoUrl ? ` <a href="${esc(repoUrl)}">${repo ? 'View on GitHub' : 'View the repository'} <span aria-hidden="true">→</span></a>` : '';
  host.removeAttribute('aria-busy');
  if (NO_README.test(reg.readme ?? '')) {
    host.innerHTML = `<div class="empty">
        <p class="hand empty-note">No README on npm.</p>
        <p class="empty-sub">The latest version of ${esc(reg.name)} was published without one.${view}</p>
      </div>`;
    return;
  }
  try {
    const [{ marked }, { default: DOMPurify }] = await Promise.all([import('marked'), import('dompurify')]);
    const html = await marked.parse(reg.readme!, { gfm: true });
    const frag = DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      SANITIZE_NAMED_PROPS: true, // ids and names get GitHub's "user-content-" prefix: no clash with the page's own
      FORBID_ATTR: ['style'],
      FORBID_TAGS: ['style', 'form'],
    });
    // Monorepo packages keep their README next to their code: relative paths start from that folder.
    const dir = typeof reg.repository === 'object' ? String((reg.repository as { directory?: unknown }).directory ?? '') : '';
    fixReadme(frag, repo, dir.replace(/[^\w.\-/]/g, '').replace(/^[./]+|\/+$/g, ''));
    host.replaceChildren(frag);
    host.insertAdjacentHTML('beforeend', `<p class="readme-foot">README rendered from the npm registry.${view}</p>`);
  } catch {
    host.innerHTML = `<p class="empty-sub">The README could not be rendered here.${view}</p>`;
  }
}

// Relative links and images point into the GitHub repo (blob pages for links, raw files for images), or go away
// when the repo is not on GitHub. Headings move down a level: the page already has its h1.
function fixReadme(root: DocumentFragment, repo: string | null, dir: string): void {
  const folder = dir ? `${dir}/` : '';
  const resolve = (url: string, kind: 'blob' | 'raw'): string | null => {
    if (!repo) return null;
    const base = kind === 'raw' ? `https://raw.githubusercontent.com/${repo}/HEAD/` : `https://github.com/${repo}/blob/HEAD/`;
    try {
      return url.startsWith('/') ? new URL(url.slice(1), base).href : new URL(url, base + folder).href;
    } catch {
      return null;
    }
  };
  const ids = new Map<string, number>();
  for (const h of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    const level = Math.min(6, Number(h.tagName[1]) + 1);
    const next = document.createElement(`h${level}`);
    next.append(...h.childNodes);
    const s = slug(next.textContent ?? '');
    if (s) {
      const n = ids.get(s) ?? 0;
      ids.set(s, n + 1);
      next.id = `user-content-${s}${n ? `-${n}` : ''}`;
    }
    h.replaceWith(next);
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href')!;
    if (href.startsWith('#')) {
      a.setAttribute('href', `#user-content-${href.slice(1).replace(/^user-content-/, '')}`);
      continue;
    }
    const url = ABSOLUTE.test(href) ? href : resolve(href, 'blob');
    if (!url || !/^(?:https?|mailto):/i.test(url)) {
      a.replaceWith(...a.childNodes);
      continue;
    }
    a.setAttribute('href', url);
    a.setAttribute('rel', 'noopener nofollow');
  }
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    const src = img.getAttribute('src') ?? '';
    const url = ABSOLUTE.test(src) ? src : resolve(src, 'raw');
    if (!url || !/^https?:/i.test(url)) {
      img.remove();
      continue;
    }
    img.setAttribute('src', url);
    img.removeAttribute('srcset');
    img.loading = 'lazy';
    img.decoding = 'async';
  }
  // <picture> sources may hold relative paths too; the <img> inside is enough.
  for (const s of root.querySelectorAll('source')) s.remove();
  for (const t of root.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    t.before(wrap);
    wrap.append(t);
  }
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
    ['jsDelivr hits', count(ev.cdnHitsMonth), 'last month, served by the CDN'],
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
    <p class="evidence-lede">Signals from outside npm's download count. They are harder to fake than downloads, but they only see public code.</p>
    <dl class="ev-grid">
      ${stats.map(([dt, dd, sub]) => `<div class="ev"><dt>${dt}</dt><dd>${dd}</dd><dd class="ev-sub">${sub}</dd></div>`).join('')}
    </dl>
    ${
      top.length
        ? `<h3 class="ev-top-title">Some packages that depend on it</h3>
           <div class="table-wrap"><table class="cmp-table">
             <thead><tr><th scope="col">package</th><th scope="col" class="num">npm downloads / week</th></tr></thead>
             <tbody>${top
               .map(
                 (d) =>
                   `<tr><th scope="row"><a href="${esc(pkgHref(d.name))}">${esc(d.name)}</a></th><td class="num" data-label="npm downloads / week">${d.downloads != null ? fmt(d.downloads) : '—'}</td></tr>`,
               )
               .join('')}</tbody>
           </table></div>`
        : ''
    }
    ${code ? `<p class="method"><a href="${esc(code)}">Search GitHub for usages <span aria-hidden="true">→</span></a></p>` : ''}`;
}

// ---------- README badge ----------

function shieldHtml(data: ShieldsBadge, live = false): string {
  return `<span class="shield" role="img"${live ? ' data-live' : ''} aria-label="Badge preview: ${esc(data.label)} ${esc(data.message)}">
    <span class="shield-l">${esc(data.label)}</span><span class="shield-r shield-${esc(data.color)}">${esc(data.message)}</span></span>`;
}

async function badge(host: HTMLElement, name: string, est: () => Estimate): Promise<void> {
  // With the badge service every link points at it: it serves any package, and its URL never changes when a package
  // enters or leaves the catalog. Without it, only tracked packages have a static file that is never dropped.
  // Membership by exact name: "@a/b" and the unscoped "a__b" share a file name.
  const tracked = BADGE_API ? null : await fetchStatic<string[]>('badges/index.json');
  if (!host.isConnected) return;
  host.hidden = false;
  if (!BADGE_API && !(Array.isArray(tracked) && tracked.includes(name))) {
    host.innerHTML = `
      <h2 class="sheet-title">Want a badge?</h2>
      <p class="badge-ask">README badges are built for tracked packages. Add <code>${esc(name)}</code> to the list with a
        <a href="${TRACKED_URL}">one-line pull request</a>.</p>`;
    return;
  }
  const json = BADGE_API ? `${BADGE_API}badge/${name}` : `${SITE_URL}badges/${safeName(name)}.json`;
  const img = `https://img.shields.io/endpoint?url=${encodeURIComponent(json)}`;
  const md = `[![real installs per week](${img})](${SITE_URL}${name})`;
  // The preview costs no request: the number this page computed with the same model as the badge (redrawn once
  // evidence settles confidence).
  host.innerHTML = `
    <h2 class="sheet-title">Badge for your README</h2>
    <div class="badge-row">
      ${shieldHtml(badgeOf(est()), true)}
      <button type="button" class="text-btn">Copy markdown</button>
    </div>
    <p class="badge-status" aria-live="polite"></p>
    <details class="badge-more"><summary>Show markdown</summary><p class="fineprint">Updates every day or few days, so it can trail the live numbers.${
      BADGE_API ? ' A brand-new badge may read “calculating…” for a few minutes.' : ''
    }</p><code class="badge-md">${esc(md)}</code></details>`;
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

// ---------- strip panels: versions in use, where the downloads went ----------

const VERSION_COLORS = ['--blue', '--blue-soft', '--hl'];
const pct = (x: number) => `${Math.round(x * 100)}%`;

// Which versions the real installs land on: the top three by downloads above the crawler floor, plus the rest.
function versionShare(est: Estimate): string {
  const rows = est.versions.filter((r) => r.aboveFloor > 0).sort((a, b) => b.aboveFloor - a.aboveFloor);
  const total = rows.reduce((s, r) => s + r.aboveFloor, 0);
  const head = `<h2 class="panel-title" id="vs-h">Which versions get installed</h2><p class="panel-sub">share of real installs, last 7 days</p>`;
  if (!total) return `<section class="panel-sec" aria-labelledby="vs-h">${head}<p class="panel-sub">No version rises above the crawler floor yet.</p></section>`;
  const top = rows.slice(0, 3);
  const rest = total - top.reduce((s, r) => s + r.aboveFloor, 0);
  const parts = [
    ...top.map((r, i) => ({ label: r.version, share: r.aboveFloor / total, color: VERSION_COLORS[i] })),
    ...(rest > 0 ? [{ label: rows.length - 3 === 1 ? '1 other version' : `${rows.length - 3} other versions`, share: rest / total, color: '--pencil' }] : []),
  ];
  return `<section class="panel-sec" aria-labelledby="vs-h">${head}
      <div class="share-bar" aria-hidden="true">${parts.map((p) => `<span style="flex-grow:${p.share.toFixed(4)};background:var(${p.color})"></span>`).join('')}</div>
      <ul class="share-legend">${parts
        .map((p) => `<li><span class="swatch" style="background:var(${p.color})" aria-hidden="true"></span><span class="num">${esc(p.label)}</span><span class="num share-v">${pct(p.share)}</span></li>`)
        .join('')}</ul>
      <p class="panel-note hand">${pct(parts[0].share)} of real installs are on ${esc(parts[0].label)}</p>
    </section>`;
}

function breakdown(est: Estimate): string {
  // Year totals that add up exactly to npm's count: spikes removed, then floor, then what remains.
  const mirrors = est.daily.reduce((s, d) => s + Math.max(0, d.npm - d.cleaned), 0);
  const kept = est.daily.reduce((s, d) => s + Math.min(d.organic, d.cleaned), 0);
  const crawlers = est.daily.reduce((s, d) => s + Math.max(0, d.cleaned - d.organic), 0);
  const total = mirrors + crawlers + kept || 1;
  const f = est.breakdown.crawlerFloorPerVersion;
  const parts = [
    { key: 'mirrors', label: 'Mirrors & scanners', value: mirrors },
    { key: 'crawlers', label: 'Crawlers', value: crawlers },
    { key: 'kept', label: 'CI, deps & people', value: kept },
  ];
  return `
    <section class="panel-sec breakdown" aria-labelledby="bd-h">
      <h2 class="panel-title" id="bd-h">Where last year's downloads went</h2>
      <p class="panel-sub"><span class="num">${fmtCompact(Math.round(total))}</span> fetches in 12 months</p>
      <div class="bar" aria-hidden="true">
        ${parts
          .filter((p) => p.value > 0)
          .map((p) => `<span class="seg seg-${p.key}" style="flex-grow:${(p.value / total).toFixed(5)}"></span>`)
          .join('')}
      </div>
      <dl class="kv">
        ${parts.map((p) => `<div class="kv-${p.key}"><dt>${p.label}</dt><dd class="num">${fmtCompact(p.value)} · ${Math.round((p.value / total) * 100)}%</dd></div>`).join('')}
      </dl>
      <p class="panel-foot">${f === null ? 'Too few versions to measure the crawler floor, so a global estimate is used.' : `Crawler floor: ${fmt(f)} fetches per version per week × ${fmt(est.versions.length)} versions.`} Crawlers and real installs use this week's split for the whole year.</p>
    </section>`;
}

function versions(est: Estimate, name: string): string {
  const rows = est.versions;
  if (!rows.length) return '<p>npm reports no downloads for any version in the last 7 days.</p>';
  const f = est.breakdown.crawlerFloorPerVersion;
  const max = Math.max(1, ...rows.map((r) => r.downloads));
  const floorPct = f === null ? null : Math.min(100, (f / max) * 100);
  const floorText =
    f === null
      ? `Too few versions to measure the crawler floor for ${esc(name)}, so a global estimate is used.`
      : `Crawler floor: <strong class="num">${fmt(f)}</strong> fetches per version per week, measured on old versions. Crawlers download every version about this often, used or not. The dashed line marks it, and only what sits above it counts toward real installs.`;
  return `
    <section class="versions">
      <h2 class="section-title">By version, last 7 days</h2>
      <p class="versions-lede">${floorText}</p>
      <div class="table-wrap">
        <table style="${floorPct === null ? '' : `--floor:${floorPct.toFixed(2)}%`}">
          <thead><tr><th scope="col">version</th><th scope="col" class="num">npm / week</th><th scope="col" class="num">above floor</th><th scope="col" class="bar-col"><span class="sr-only">chart</span></th></tr></thead>
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
