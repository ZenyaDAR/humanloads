// The one place that knows where the site is hosted. Everything absolute (canonical, Open Graph, sitemap,
// robots.txt, llms.txt, JSON-LD, badge URLs) and the Vite base path derive from SITE_URL.
// Override at build time: SITE_URL=https://example.com/ npm run build
export const DEFAULT_SITE_URL = 'https://humanloads.dev/';

// Normalized origin + path with a trailing slash, no query or hash.
export function resolveSiteUrl(raw: string | undefined = process.env.SITE_URL): string {
  const url = new URL(raw?.trim() || DEFAULT_SITE_URL);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`SITE_URL must be http(s): ${raw}`);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';
  return url.href;
}

// The badge service (server/), which serves a README badge for any npm package and logs which badges are used.
// Empty: only tracked packages get one, from the static public/badges files. Use a domain you own for it: the URL
// ends up in other people's READMEs for good. Set BADGE_API_URL in the environment (CI: a repository variable)
// or in a local, git-ignored .env file.
export const DEFAULT_BADGE_API_URL = '';

// Local builds read .env (Node 22); variables already in the environment win. No file: nothing to load.
try {
  process.loadEnvFile();
} catch {
  // ponytail: no .env is the normal case in CI and on Railway
}

export function resolveBadgeApiUrl(raw: string | undefined = process.env.BADGE_API_URL): string {
  const value = raw?.trim() ?? DEFAULT_BADGE_API_URL;
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`BADGE_API_URL must be https: ${raw}`);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.origin + url.pathname;
}

// A custom domain needs a CNAME file; *.github.io does not.
export function customDomain(site: string): string | null {
  const host = new URL(site).hostname;
  return host.endsWith('.github.io') || host === 'localhost' ? null : host;
}
