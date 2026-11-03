import './style.css';
import { isValidPackageName } from '../core/sources.ts';
import { renderCompare } from './compare.ts';
import { renderHome, masthead } from './home.ts';
import { renderPackage } from './package.ts';
import {
  HOME_DESCRIPTION, HOME_TITLE, compareDescription, compareTitle, packageDescription, packageTitle,
} from '../core/seo.ts';
import { METHODOLOGY_DESCRIPTION, METHODOLOGY_PATH, METHODOLOGY_TITLE, methodologyBody } from '../core/methodology.ts';
import type { FeaturedRow } from '../core/types.ts';
import { BASE, esc, fetchStatic, navigate, setPageMeta } from './util.ts';

const app = document.getElementById('app')!;
let routeId = 0;

type Route = { kind: 'home' } | { kind: 'methodology' } | { kind: 'package'; name: string } | { kind: 'compare'; names: string[] } | { kind: 'missing' };

// pathname minus base: "" -> home, "<name>" or "@scope/<name>" -> package page,
// "compare/a,b[,c]" -> compare. A comma is never valid in a package name, so a bare "compare" stays a package.
function routeFromPath(pathname: string): Route {
  let rest: string;
  try {
    rest = decodeURIComponent(pathname);
  } catch {
    return { kind: 'missing' };
  }
  if (rest + '/' === BASE) return { kind: 'home' };
  if (!rest.startsWith(BASE)) return { kind: 'missing' };
  rest = rest.slice(BASE.length).replace(/\/+$/, '');
  if (rest === '' || rest === 'index.html') return { kind: 'home' };
  if (rest === METHODOLOGY_PATH) return { kind: 'methodology' };
  if (rest.startsWith('compare/')) {
    const names = [...new Set(rest.slice('compare/'.length).split(',').map((n) => n.trim()))];
    const ok = names.length >= 2 && names.length <= 3 && names.every(isValidPackageName);
    return ok ? { kind: 'compare', names } : { kind: 'missing' };
  }
  return isValidPackageName(rest) ? { kind: 'package', name: rest } : { kind: 'missing' };
}

function route(userNavigation: boolean): void {
  // A fresh view element per route: async work checks view.isConnected before painting,
  // so a slow response for a page the user already left is simply dropped.
  const view = document.createElement('div');
  view.className = 'view';
  app.replaceChildren(view);
  const r = routeFromPath(location.pathname);
  const id = ++routeId;

  if (r.kind === 'home') {
    setPageMeta(HOME_TITLE, HOME_DESCRIPTION, '');
    renderHome(view);
  } else {
    view.append(masthead());
    const body = document.createElement('div');
    view.append(body);
    if (r.kind === 'methodology') {
      setPageMeta(METHODOLOGY_TITLE, METHODOLOGY_DESCRIPTION, METHODOLOGY_PATH);
      body.innerHTML = methodologyBody(BASE);
      // Landing on /docs/methodology#section: the anchor target only exists now.
      if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    } else if (r.kind === 'missing') {
      setPageMeta('Not found · humanloads', HOME_DESCRIPTION, null);
      body.innerHTML = `
        <section class="state state-missing">
          <h1 tabindex="-1">Nothing on this page</h1>
          <p><code>${esc(location.pathname)}</code> is not a valid npm package name, or a compare link with 2–3 packages.</p>
          <p><a href="${BASE}">Search for a package</a></p>
        </section>`;
    } else if (r.kind === 'compare') {
      setPageMeta(compareTitle(r.names), compareDescription(r.names), `compare/${r.names.join(',')}`);
      renderCompare(body, r.names);
    } else {
      const name = r.name;
      setPageMeta(packageTitle(name), packageDescription(name), name);
      // Same description as the prerendered page: it quotes the build-time numbers when there are some.
      void fetchStatic<{ packages?: Record<string, FeaturedRow> }>('data/summary.json').then((s) => {
        const row = s?.packages?.[name];
        if (row && id === routeId) setPageMeta(packageTitle(name), packageDescription(name, row), name);
      });
      renderPackage(body, r.name);
    }
  }

  if (userNavigation) {
    window.scrollTo(0, 0);
    view.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }
}

// Intercept same-app links so navigation never reloads the page.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element).closest?.('a');
  if (!a || a.target || a.hasAttribute('download') || a.origin !== location.origin) return;
  if (!a.pathname.startsWith(BASE) && a.pathname + '/' !== BASE) return;
  if (a.pathname === location.pathname && a.hash) return; // in-page anchor: let the browser scroll
  e.preventDefault();
  if (a.pathname !== location.pathname) navigate(a.pathname + a.search + a.hash);
});

addEventListener('popstate', () => route(false));
addEventListener('hl:navigate', () => route(true));
route(false);
