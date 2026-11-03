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

// A custom domain needs a CNAME file; *.github.io does not.
export function customDomain(site: string): string | null {
  const host = new URL(site).hostname;
  return host.endsWith('.github.io') || host === 'localhost' ? null : host;
}
