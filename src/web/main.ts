import './style.css';
import { isValidPackageName } from '../core/sources.ts';
import { renderCompare } from './compare.ts';
import { renderHome, masthead } from './home.ts';
import { renderPackage } from './package.ts';
import {
  HOME_DESCRIPTION, HOME_TITLE, compareDescription, compareTitle, packageDescription, packageTitle,
} from '../core/seo.ts';
import { METHODOLOGY_DESCRIPTION, METHODOLOGY_PATH, METHODOLOGY_TITLE, methodologyBody } from '../core/methodology.ts';
import { GUIDES, type Guide } from '../core/guides.ts';
import { LISTS } from '../core/lists.ts';
import { BASE, esc, fetchStatic, navigate, setPageMeta } from './util.ts';

const app = document.getElementById('app')!;
// A prerendered landing page already has a body and a description quoting its numbers; 404.html and the dev server's
// shell have an empty #app. Later routes get the generic text: only crawlers read it, and they land on pages directly.
let landedOnStaticPage = app.childElementCount > 0;

// Each guide reads the data file it names, so the file and its reader agree by construction.
type Route = { kind: 'home' } | { kind: 'methodology' } | { kind: 'guide'; guide: Guide<any> } | { kind: 'package'; name: string } | { kind: 'compare'; names: string[] } | { kind: 'missing' };

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
  const guide = [...GUIDES, ...LISTS].find((g) => g.path === rest);
  if (guide) return { kind: 'guide', guide };
  if (rest.startsWith('compare/')) {
    const names = [...new Set(rest.slice('compare/'.length).split(',').map((n) => n.trim()))];
    const ok = names.length >= 2 && names.length <= 3 && names.every(isValidPackageName);
    return ok ? { kind: 'compare', names } : { kind: 'missing' };
  }
  return isValidPackageName(rest) ? { kind: 'package', name: rest } : { kind: 'missing' };
}

function route(userNavigation: boolean): void {
  const r = routeFromPath(location.pathname);
  // A prerendered guide already has its content and its links work through the handler below. Only the header is a
  // stand-in, with an inert search box and theme toggle.
  if (landedOnStaticPage && r.kind === 'guide') {
    landedOnStaticPage = false;
    app.querySelector('.masthead')?.replaceWith(masthead());
    return;
  }
  // A fresh view element per route: async work checks view.isConnected before painting,
  // so a slow response for a page the user already left is simply dropped.
  const view = document.createElement('div');
  view.className = 'view';
  app.replaceChildren(view);

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
    } else if (r.kind === 'guide') {
      const guide = r.guide;
      setPageMeta(guide.title, guide.description, guide.path);
      if (guide.ready) {
        void fetchStatic<unknown>(guide.dataFile ?? 'data/insights.json').then((data) => {
          if (!view.isConnected) return;
          body.innerHTML = guide.body(BASE, data);
          if (userNavigation) view.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
        });
      } else {
        body.innerHTML = guide.body(BASE);
      }
    } else if (r.kind === 'missing') {
      setPageMeta('Not found · humanloads', HOME_DESCRIPTION, null);
      body.innerHTML = `
        <section class="state state-missing">
          <h1 tabindex="-1">Nothing on this page</h1>
          <p><code>${esc(location.pathname)}</code> is not a valid npm package name, or a compare link with 2–3 packages.</p>
          <p><a href="${BASE}">Search for a package</a></p>
        </section>`;
    } else if (r.kind === 'compare') {
      if (!landedOnStaticPage) setPageMeta(compareTitle(r.names), compareDescription(r.names), `compare/${r.names.join(',')}`);
      renderCompare(body, r.names);
    } else {
      if (!landedOnStaticPage) setPageMeta(packageTitle(r.name), packageDescription(r.name), r.name);
      renderPackage(body, r.name);
    }
  }

  landedOnStaticPage = false;
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
