import { isValidPackageName, searchPackages } from '../core/sources.ts';
import type { FeaturedFile, SearchHit } from '../core/types.ts';
import { HOME_COMPARE_SIZE, homeFaqHtml } from '../core/seo.ts';
import {
  HOME_NOISY_SIZE, PINNED_SKELETON, categoriesHtml, compareSectionHtml, examplesHtml, heroHtml, howHtml, journalHtml, notebookHtml, pinnedCardHtml, pinnedRow, popularHtml,
  searchFormInner, siteFooterHtml, siteHeaderHtml, type NavKey,
} from '../core/layout.ts';
import COMPARE_PAIRS from '../../data/compare.json';
import { BASE, esc, fetchStatic, fmtCompact, fmtDate, navigate, pkgHref, headTools, timeAgo } from './util.ts';

const EXAMPLES_SHOWN = 5;
let searchId = 0;
let searchAbort: AbortController | null = null;
// ponytail: unbounded per-page-load cache keyed by the trimmed lowercase query; a session types few queries.
const searchCache = new Map<string, SearchHit[]>();

// Placeholders the size of the real links, so the hero doesn't move when they arrive (CLS).
const EXAMPLES_SKELETON = '<span class="quiet-link sk-text" aria-hidden="true">&nbsp;</span>'.repeat(EXAMPLES_SHOWN);

export function renderHome(view: HTMLElement): void {
  view.innerHTML = `
    ${heroHtml(BASE, '<span data-slot="search"></span>', EXAMPLES_SKELETON, PINNED_SKELETON)}
    ${howHtml(BASE)}
    ${notebookHtml(BASE, null, '')}
    ${compareSectionHtml(BASE, COMPARE_PAIRS.slice(0, HOME_COMPARE_SIZE))}
    ${journalHtml(BASE)}
    ${categoriesHtml(BASE, null)}
    ${homeFaqHtml(BASE)}`;
  view.querySelector('[data-slot="search"]')!.replaceWith(searchBox('home', { placeholder: 'Search npm packages' }));
  void featured(view);
}

// "try one" links, the pinned card, the "most noise" and "rising" lists and the compare chart all come from the
// nightly featured data.
async function featured(view: HTMLElement): Promise<void> {
  const f = await fetchStatic<FeaturedFile>('data/featured.json');
  if (!view.isConnected) return;
  const names = Array.isArray(f?.examples) ? f.examples.slice(0, EXAMPLES_SHOWN) : [];
  const rows = Array.isArray(f?.noisiest) ? f.noisiest.slice(0, HOME_NOISY_SIZE) : [];
  const ex = view.querySelector<HTMLElement>('.home-examples')!;
  if (names.length) {
    ex.querySelectorAll('.sk-text').forEach((s) => s.remove());
    ex.insertAdjacentHTML('beforeend', examplesHtml(BASE, names));
  } else ex.remove();
  const pin = view.querySelector<HTMLElement>('.hero-pin')!;
  if (rows.length) pin.innerHTML = pinnedCardHtml(BASE, pinnedRow(rows));
  else pin.remove();
  const rising = Array.isArray(f?.rising) ? f.rising : [];
  view.querySelector('#rankings')!.outerHTML = notebookHtml(BASE, rows, f ? fmtDate(f.generated) : '', rising, f?.noisyRecent);
  if (f?.tops) view.querySelector('#categories')!.outerHTML = categoriesHtml(BASE, f.tops);
  if (Array.isArray(f?.popular)) view.querySelector('#categories')!.insertAdjacentHTML('afterend', popularHtml(BASE, f.popular));
  const cmp = view.querySelector('#compare');
  if (cmp && f?.showcase) cmp.outerHTML = compareSectionHtml(BASE, COMPARE_PAIRS.slice(0, HOME_COMPARE_SIZE), f.showcase);
}

// Every page's header: logo, search (except where the page has its own big one), nav, GitHub, theme.
export function siteHeader(active: NavKey, withSearch: boolean): HTMLElement {
  const tmp = document.createElement('div');
  tmp.innerHTML = siteHeaderHtml(BASE, active, withSearch ? '<span data-slot="search"></span>' : '', '<span data-slot="tools"></span>');
  const header = tmp.firstElementChild as HTMLElement;
  header.querySelector('[data-slot="search"]')?.replaceWith(searchBox('top', { placeholder: 'Search packages' }));
  header.querySelector('[data-slot="tools"]')!.replaceWith(headTools());
  return header;
}

export function siteFooter(): HTMLElement {
  const tmp = document.createElement('div');
  tmp.innerHTML = siteFooterHtml(BASE);
  return tmp.firstElementChild as HTMLElement;
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
  const attrs = `id="q-${id}" name="q" autocomplete="off" autocapitalize="off" spellcheck="false"
      role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}" aria-describedby="q-${id}-hint"`;
  form.innerHTML = `
    <label class="sr-only" for="q-${id}">${esc(opts.label ?? 'npm package name')}</label>
    ${searchFormInner(id, opts.placeholder ?? 'Search packages', opts.button ?? 'Look', attrs)}
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
      hint.textContent = `"${name}" is not a valid npm package name. Enter the name as it appears on npmjs.com, or paste the package's npm link.`;
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
