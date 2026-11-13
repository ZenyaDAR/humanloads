// Small helpers shared by the views. No DOM framework: views build HTML strings,
// and every third-party string goes through esc() first.
import { METHODOLOGY_PATH } from '../core/methodology.ts';
import { REPO_LINK_HTML } from '../core/seo.ts';
import { themeIcon } from '../core/layout.ts';

export const BASE = import.meta.env.BASE_URL; // path part of SITE_URL, e.g. '/'

// The public site, for links that must work outside this browser (badges, canonical). Set by vite.config.ts.
export const SITE_URL: string = import.meta.env.VITE_SITE_URL;
// The badge service (server/), with a trailing slash; '' when none is configured. Set by vite.config.ts.
export const BADGE_API: string = import.meta.env.VITE_BADGE_API_URL;

export const METHODOLOGY_URL = BASE + METHODOLOGY_PATH;

export { esc } from '../core/html.ts';

export function pkgHref(name: string): string {
  return BASE + name;
}

export { safeName } from '../core/badge.ts';

// In-app navigation: main.ts listens for this event and re-renders.
export function navigate(path: string): void {
  history.pushState(null, '', path);
  dispatchEvent(new Event('hl:navigate'));
}

const standard = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function fmt(n: number): string {
  return Math.abs(n) >= 1e6 ? compact.format(n) : standard.format(Math.round(n));
}

export function fmtShort(n: number): string {
  return Math.abs(n) >= 1e4 ? compact.format(n) : standard.format(Math.round(n));
}

// 1234 -> "1.2K": for dense lists where width matters more than precision.
export function fmtCompact(n: number): string {
  return compact.format(n);
}

// "updated 3 mo ago" style. ponytail: month = 30 days, year = 365; it is a hint, not a date.
export function timeAgo(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 864e5);
  if (days < 1) return 'today';
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

export function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? iso
    : new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Only http(s) links from third parties: repository fields can hold git+ssh, shorthands or worse.
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const url = raw
    .trim()
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^(ssh:\/\/)?git@([^:/]+)[:/]/, 'https://$2/')
    .replace(/\.git(#.*)?$/, '');
  const shorthand = /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
  try {
    const u = new URL(shorthand);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

// Build-time JSON next to the site (featured, calibration, badge index). Fetched once per page load;
// a missing file (404, or the dev server's HTML fallback) resolves to null and the caller hides its section.
const staticCache = new Map<string, Promise<unknown>>();
export function fetchStatic<T>(path: string): Promise<T | null> {
  let hit = staticCache.get(path);
  if (!hit) {
    hit = fetch(BASE + path)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    staticCache.set(path, hit);
  }
  return hit as Promise<T | null>;
}

function setTag(selector: string, create: () => HTMLElement, attr: string, value: string | null): void {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (value === null) return void el?.remove();
  if (!el) document.head.append((el = create()));
  el.setAttribute(attr, value);
}

const metaTag = (key: 'name' | 'property', value: string) => () => {
  const m = document.createElement('meta');
  m.setAttribute(key, value);
  return m;
};

// Per-route title, description, canonical and Open Graph. `path` is relative to the site root
// (null: no canonical, and the page asks not to be indexed).
export function setPageMeta(title: string, description: string, path: string | null): void {
  document.title = title;
  const url = path === null ? null : SITE_URL + path;
  setTag('meta[name="description"]', metaTag('name', 'description'), 'content', description);
  setTag('meta[property="og:title"]', metaTag('property', 'og:title'), 'content', title);
  setTag('meta[property="og:description"]', metaTag('property', 'og:description'), 'content', description);
  setTag('meta[property="og:url"]', metaTag('property', 'og:url'), 'content', url);
  setTag('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' }), 'href', url);
  // Only ever added: a prerendered low-traffic page ships noindex, and crawlers that run JS must still see it.
  if (url === null) setTag('meta[name="robots"]', metaTag('name', 'robots'), 'content', 'noindex');
}

// ---------- theme: system -> light -> dark ----------

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'humanloads:theme';
const THEMES: Theme[] = ['system', 'light', 'dark'];

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY) as Theme | null;
    return t && THEMES.includes(t) ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  dispatchEvent(new Event('hl:theme')); // charts redraw with the new colors
}

let theme = readTheme(); // index.html applied it before first paint

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (theme === 'system') dispatchEvent(new Event('hl:theme'));
});

const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

// Right side of every header: the GitHub link and the theme toggle.
export function headTools(): HTMLElement {
  const tools = document.createElement('div');
  tools.className = 'head-tools';
  tools.innerHTML = REPO_LINK_HTML;
  tools.append(themeToggle());
  return tools;
}

export function themeToggle(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';
  const label = () => {
    btn.innerHTML = `${themeIcon()}${THEME_LABEL[theme]}`;
    btn.setAttribute('aria-label', `Color theme: ${theme}. Change theme`);
  };
  label();
  btn.addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage blocked: the choice lasts until reload.
    }
    applyTheme(theme);
    label();
  });
  return btn;
}
