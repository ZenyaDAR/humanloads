import { isValidPackageName, searchPackages } from '../core/sources.ts';
import type { FeaturedFile, FeaturedRow, SearchHit } from '../core/types.ts';
import { compareLinksHtml } from '../core/seo.ts';
import COMPARE_PAIRS from '../../data/compare.json';
import {
  BASE, esc, fetchStatic, fmt, fmtCompact, fmtDate, navigate, pkgHref, METHODOLOGY_URL, headTools, timeAgo,
} from './util.ts';

const FEATURED_SHOWN = 6;
const EXAMPLES_SHOWN = 4; // top of the "humans" list; bot-inflated names are long build artifacts
let searchId = 0;
let searchAbort: AbortController | null = null;
// ponytail: unbounded per-page-load cache keyed by the trimmed lowercase query; a session types few queries.
const searchCache = new Map<string, SearchHit[]>();

export function renderHome(view: HTMLElement): void {
  view.innerHTML = `
    <div class="home-top"></div>
    <section class="home">
      <h1 class="home-title" tabindex="-1">human<span class="home-title-mark">loads</span></h1>
      <p class="home-pitch">npm counts every tarball fetch: mirrors, scanners, CI. <span class="hl">We estimate the humans.</span></p>
      <div class="home-search"></div>
      <p class="home-examples" aria-busy="true">
        <span class="hand">try one</span>
        ${'<span class="tag sk-tag" aria-hidden="true">&nbsp;</span>'.repeat(EXAMPLES_SHOWN)}
      </p>
    </section>
    <div class="featured"></div>
    ${compareLinksHtml(BASE, COMPARE_PAIRS, esc)}
    <aside class="home-note">
      <p class="hand">how it works</p>
      <ol>
        <li>Cut the spike every new version gets from mirrors in its first days.</li>
        <li>Subtract the flat floor robots download from <em>every</em> version each week.</li>
        <li>Show what is left as a range, with an honest confidence level.</li>
      </ol>
      <p><a href="${METHODOLOGY_URL}">Read the methodology</a></p>
    </aside>`;
  view.querySelector('.home-top')!.append(headTools());
  view.querySelector('.home-search')!.append(searchBox('home'));
  const data = fetchStatic<FeaturedFile>('data/featured.json');
  void examples(view.querySelector<HTMLElement>('.home-examples')!, data);
  void featured(view.querySelector<HTMLElement>('.featured')!, data);
}

// "try one" links come from the live featured data, never a hand-picked list.
async function examples(host: HTMLElement, data: Promise<FeaturedFile | null>): Promise<void> {
  const f = await data;
  if (!host.isConnected) return;
  host.removeAttribute('aria-busy');
  const names = Array.isArray(f?.humans) ? f.humans.slice(0, EXAMPLES_SHOWN).map((r) => r.name) : [];
  if (!names.length) return void host.remove();
  host.querySelectorAll('.sk-tag').forEach((t) => t.remove());
  host.insertAdjacentHTML('beforeend', names.map((n) => `<a class="tag" href="${esc(pkgHref(n))}">${esc(n)}</a>`).join(''));
}

// Compact header shown on every page except home.
export function masthead(): HTMLElement {
  const header = document.createElement('header');
  header.className = 'masthead';
  header.innerHTML = `<a class="logo" href="${BASE}">human<span>loads</span></a>`;
  header.append(searchBox('top'), headTools());
  return header;
}

// ---------- featured index cards ----------

// Placeholder cards built from the real card classes, so each line keeps the real line height
// and swapping in the data does not push the rest of the page down (CLS).
const SKELETON_CARD = `<li><div class="fcard sk-fcard">
  <span class="fcard-name">&nbsp;</span>
  <span class="fcard-desc">&nbsp;<br>&nbsp;</span>
  <span class="fcard-nums">&nbsp;</span>
  <span class="pill">&nbsp;</span>
</div></li>`;

async function featured(host: HTMLElement, data: Promise<FeaturedFile | null>): Promise<void> {
  host.setAttribute('aria-busy', 'true');
  host.innerHTML = `<section class="fcards-sec">
      <h2 class="section-title">Most real humans <span class="fcards-note hand">top by estimated human installs</span></h2>
      <ul class="fcards" aria-hidden="true">${SKELETON_CARD.repeat(FEATURED_SHOWN)}</ul>
    </section>
    <p class="fineprint">&nbsp;</p>`;
  const f = await data;
  if (!host.isConnected) return;
  host.removeAttribute('aria-busy');
  if (!f) return void host.replaceChildren();
  const section = (rows: unknown, title: string, note: string, bots: boolean) =>
    Array.isArray(rows) && rows.length
      ? `<section class="fcards-sec">
          <h2 class="section-title">${title} <span class="fcards-note hand">${note}</span></h2>
          <ul class="fcards">${(rows as FeaturedRow[]).slice(0, FEATURED_SHOWN).map((r) => card(r, bots)).join('')}</ul>
        </section>`
      : '';
  const html =
    section(f.humans, 'Most real humans', 'top by estimated human installs', false) +
    section(f.inflated, 'Most bot-inflated', 'where npm counts robots the most', true);
  if (!html) return void host.replaceChildren();
  host.innerHTML = `${html}<p class="fineprint">Updated ${esc(fmtDate(f.generated))}. Weekly numbers, last 7 days.</p>`;
}

function card(r: FeaturedRow, bots: boolean): string {
  const low = Math.round(r.low);
  const high = Math.round(r.high);
  return `<li><a class="fcard" href="${esc(pkgHref(r.name))}">
    <span class="fcard-name">${esc(r.name)}</span>
    ${bots ? `<span class="fcard-tag">${Math.round(r.inflation * 100)}% bots</span>` : ''}
    ${r.description ? `<span class="fcard-desc">${esc(r.description)}</span>` : ''}
    <span class="fcard-nums">
      <s class="struck num" title="npm: ${esc(fmt(r.npmWeekly))} / week"><span class="sr-only">npm says </span>${esc(fmtCompact(r.npmWeekly))}</s>
      <span class="fcard-human">≈ <mark>${esc(low === high ? fmtCompact(low) : `${fmtCompact(low)}–${fmtCompact(high)}`)}</mark> humans</span>
    </span>
    <span class="pill pill-${esc(r.confidence)}">${esc(r.confidence)}</span>
  </a></li>`;
}

// ---------- prediction search (ARIA combobox) ----------

// Highlight the first case-insensitive occurrence of the query; both parts escaped separately.
function highlight(name: string, q: string): string {
  const at = name.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0 || !q) return esc(name);
  return `${esc(name.slice(0, at))}<mark>${esc(name.slice(at, at + q.length))}</mark>${esc(name.slice(at + q.length))}`;
}

function option(h: SearchHit, q: string, id: string): string {
  const meta = [
    h.weeklyDownloads !== undefined ? `${fmtCompact(h.weeklyDownloads)}/wk` : '',
    h.dependents !== undefined ? `${fmtCompact(h.dependents)} dependents` : '',
    timeAgo(h.date) ? `updated ${timeAgo(h.date)}` : '',
    h.publisher ? `by ${esc(h.publisher)}` : '',
  ].filter(Boolean);
  const exact = h.name.toLowerCase() === q.toLowerCase();
  return `<li role="option" id="${id}" class="sg" aria-selected="false" data-name="${esc(h.name)}">
    <span class="sg-top"><span class="sg-name">${highlight(h.name, q)}</span>
      ${h.version ? `<span class="sg-ver">${esc(h.version)}</span>` : ''}${exact ? '<span class="sg-exact">exact match</span>' : ''}</span>
    ${h.description ? `<span class="sg-desc">${esc(h.description)}</span>` : ''}
    ${meta.length ? `<span class="sg-meta">${meta.join(' · ')}</span>` : ''}
  </li>`;
}

interface SearchOpts {
  placeholder?: string;
  button?: string;
  label?: string;
  onPick?: (name: string) => void; // default: open the package page
}

export function searchBox(id: string, opts: SearchOpts = {}): HTMLFormElement {
  const pick = opts.onPick ?? ((name: string) => navigate(pkgHref(name)));
  const form = document.createElement('form');
  form.className = `search search-${id}`;
  form.setAttribute('role', 'search');
  form.noValidate = true;
  const listId = `q-${id}-list`;
  form.innerHTML = `
    <label class="sr-only" for="q-${id}">${esc(opts.label ?? 'npm package name')}</label>
    <input id="q-${id}" name="q" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
      role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}"
      placeholder="${esc(opts.placeholder ?? (id === 'home' ? 'package name, e.g. zod' : 'search a package…'))}"
      aria-describedby="q-${id}-hint" />
    <button type="submit">${esc(opts.button ?? 'Look')}</button>
    <p class="search-hint" id="q-${id}-hint" aria-live="polite"></p>
    <p class="sr-only" aria-live="polite" data-status></p>
    <ul class="suggest" id="${listId}" role="listbox" aria-label="Matching packages" hidden></ul>`;

  const input = form.querySelector('input')!;
  const hint = form.querySelector<HTMLElement>('.search-hint')!;
  const status = form.querySelector<HTMLElement>('[data-status]')!;
  const list = form.querySelector<HTMLUListElement>('.suggest')!;
  let timer = 0;
  let active = -1;

  const options = () => [...list.querySelectorAll<HTMLElement>('[role="option"]')];
  const setActive = (i: number) => {
    const opts = options();
    active = i;
    opts.forEach((o, k) => o.setAttribute('aria-selected', String(k === i)));
    if (i >= 0 && opts[i]) {
      input.setAttribute('aria-activedescendant', opts[i].id);
      opts[i].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const open = (html: string) => {
    list.innerHTML = html;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  };
  const close = () => {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  };
  const choose = (name: string) => {
    if (!isValidPackageName(name)) {
      hint.textContent = `"${name}" is not a valid npm package name.`;
      return;
    }
    close();
    input.value = name;
    pick(name);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    hint.textContent = '';
    const text = input.value.trim();
    if (text.length < 2) return close();
    timer = window.setTimeout(async () => {
      const id = ++searchId;
      const key = text.toLowerCase();
      // Abort the previous query's requests (npm search, npms suggestions and the download counts).
      searchAbort?.abort();
      const ctrl = (searchAbort = new AbortController());
      try {
        let hits = searchCache.get(key);
        if (!hits) {
          hits = await searchPackages(text, (url, init) => fetch(url, { ...init, signal: ctrl.signal }));
          // An abort can leave counts missing (their calls are caught), so don't cache degraded results.
          if (!ctrl.signal.aborted) searchCache.set(key, hits);
        }
        if (id !== searchId || input.value.trim() !== text) return; // stale response
        if (!hits.length) {
          open('<li class="sg-empty" role="presentation">No packages match</li>');
          status.textContent = 'No packages match';
          return;
        }
        const shown = hits.slice(0, 6);
        open(shown.map((h, i) => option(h, text, `q-${id}-opt-${i}`)).join(''));
        status.textContent = `${shown.length} suggestions. Use the arrow keys to choose.`;
      } catch {
        // An aborted (superseded) query must not close the newer query's list.
        if (id === searchId) close(); // ponytail: suggestions are a nicety; Enter still works without them.
      }
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    const n = options().length;
    if (e.key === 'Escape') {
      if (!list.hidden) e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      setActive(active < n - 1 ? active + 1 : 0);
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      setActive(active > 0 ? active - 1 : n - 1);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(options()[active].dataset.name!);
    }
  });
  list.addEventListener('click', (e) => {
    const opt = (e.target as Element).closest<HTMLElement>('[role="option"]');
    if (opt) choose(opt.dataset.name!);
  });
  list.addEventListener('mousemove', (e) => {
    const opt = (e.target as Element).closest<HTMLElement>('[role="option"]');
    if (opt) setActive(options().indexOf(opt));
  });
  // Safari and macOS Firefox don't focus on mousedown, so focusout would close the list before click.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  form.addEventListener('focusout', (e) => {
    if (!form.contains(e.relatedTarget as Node | null)) close();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    // Accept a pasted npmjs.com URL as well as a bare name.
    const name = input.value.trim().replace(/^https?:\/\/(www\.)?npmjs\.com\/package\//, '').replace(/\/+$/, '');
    if (!name) return input.focus();
    choose(name); // validates the name
  });
  return form;
}
