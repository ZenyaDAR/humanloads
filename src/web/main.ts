import './style.css';
import { isValidPackageName } from '../core/sources.ts';
import { renderCompare } from './compare.ts';
import { renderHome, searchBox, siteFooter, siteHeader } from './home.ts';
import type { NavKey } from '../core/layout.ts';
import { renderPackage } from './package.ts';
import {
  HOME_DESCRIPTION, HOME_TITLE, compareDescription, compareTitle, packageDescription, packageTitle,
} from '../core/seo.ts';
import { METHODOLOGY_DESCRIPTION, METHODOLOGY_PATH, METHODOLOGY_TITLE, methodologyBody } from '../core/methodology.ts';
import { GUIDES, pickMentions, type Guide, type MentionRow } from '../core/guides.ts';
import { LISTS } from '../core/lists.ts';
import { BASE, esc, fetchStatic, navigate, setPageMeta } from './util.ts';

const app = document.getElementById('app')!;
// A prerendered landing page already has a body and a description quoting its numbers; 404.html and the dev server's
// shell have an empty #app. Later routes get the generic text: only crawlers read it, and they land on pages directly.
let landedOnStaticPage = app.childElementCount > 0;

// An article's "Check your own package" box is an inert stand-in in the markup; this swaps in a live one.
function liveArticleSearch(root: ParentNode): void {
  const slot = root.querySelector('.art-search');
  if (!slot) return;
  const form = searchBox('art', { placeholder: 'your-package-name', button: 'Look' });
  form.classList.add('search-home');
  slot.replaceChildren(form);
}

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

// Which header nav item is "current" for a route.
function navKey(r: Route): NavKey {
  if (r.kind === 'methodology') return 'methodology';
  if (r.kind === 'compare') return 'compare';
  if (r.kind === 'guide') return r.guide.path.startsWith('lists/') ? 'rankings' : 'journal';
  return null;
}

function route(userNavigation: boolean): void {
  const r = routeFromPath(location.pathname);
  // A prerendered guide already has its content and its links work through the handler below. Only the header is a
  // stand-in, with an inert search box and theme toggle.
  if (landedOnStaticPage && r.kind === 'guide') {
    landedOnStaticPage = false;
    app.querySelector('.site-head')?.replaceWith(siteHeader(navKey(r), true));
    liveArticleSearch(app);
    return;
  }
  // A prerendered package or compare page keeps its static body until live data arrives, and keeps it for good if the
  // npm API fails: crawlers that run JS must not see a skeleton or an error in place of the numbers.
  const staticBody = landedOnStaticPage ? app.querySelector('main')?.innerHTML : undefined;
  // A fresh view element per route (header, page body, footer): async work checks body.isConnected before painting,
  // so a slow response for a page the user already left is simply dropped.
  const view = document.createElement('div');
  view.className = 'view';
  const body = document.createElement('main');
  body.className = r.kind === 'home' ? 'page page-home' : 'page wrap';
  view.append(siteHeader(navKey(r), r.kind !== 'home'), body, siteFooter());
  app.replaceChildren(view);

  if (r.kind === 'home') {
    setPageMeta(HOME_TITLE, HOME_DESCRIPTION, '');
    renderHome(body);
  } else {
    if (r.kind === 'methodology') {
      setPageMeta(METHODOLOGY_TITLE, METHODOLOGY_DESCRIPTION, METHODOLOGY_PATH);
      body.innerHTML = methodologyBody(BASE);
      liveArticleSearch(body);
    } else if (r.kind === 'guide') {
      const guide = r.guide;
      setPageMeta(guide.title, guide.description, guide.path);
      const paint = (data?: unknown, mentions?: { rows?: Record<string, MentionRow> } | null) => {
        body.innerHTML = guide.body(BASE, data, pickMentions(guide.mentions, mentions?.rows));
        liveArticleSearch(body);
      };
      // data/mentions.json is written by the prerender step; without it (dev server) the rail just skips the cards.
      if (guide.ready || guide.mentions?.length) {
        void Promise.all([
          guide.ready ? fetchStatic<unknown>(guide.dataFile ?? 'data/insights.json') : undefined,
          guide.mentions?.length ? fetchStatic<{ rows?: Record<string, MentionRow> }>('data/mentions.json') : null,
        ]).then(([data, mentions]) => {
          if (!view.isConnected) return;
          paint(data, mentions);
          if (userNavigation) view.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
        });
      } else {
        paint();
      }
    } else if (r.kind === 'missing') {
      setPageMeta('Not found · humanloads', HOME_DESCRIPTION, null);
      body.innerHTML = `
        <section class="state state-missing">
          <h1 tabindex="-1">No page here</h1>
          <p><code>${esc(location.pathname)}</code> is not a valid npm package name or a compare link. Compare links list 2–3 packages separated by commas, like <code>compare/zod,yup</code>.</p>
          <p><a href="${BASE}">Search for a package</a></p>
        </section>`;
    } else if (r.kind === 'compare') {
      if (!landedOnStaticPage) setPageMeta(compareTitle(r.names), compareDescription(r.names), `compare/${r.names.join(',')}`);
      renderCompare(body, r.names, staticBody);
    } else {
      if (!landedOnStaticPage) setPageMeta(packageTitle(r.name), packageDescription(r.name), r.name);
      renderPackage(body, r.name, staticBody);
    }
  }

  landedOnStaticPage = false;
  // A link to a section (/#compare, /docs/methodology#faq): its target only exists now.
  const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (userNavigation) {
    if (!target) window.scrollTo(0, 0);
    view.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true });
  }
  target?.scrollIntoView();
}

// "/" jumps to the search box, as the header hint says.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  const input = document.querySelector<HTMLInputElement>('#q-top, #q-home');
  if (!input) return;
  e.preventDefault();
  input.focus();
});

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
