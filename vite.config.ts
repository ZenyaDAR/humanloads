import { defineConfig } from 'vite';
import { resolveSiteUrl } from './site.config.ts';

// The public URL and the base path both come from SITE_URL (see site.config.ts).
// After the build, scripts/prerender.mjs writes 404.html, robots.txt, sitemap.xml, llms.txt and the package pages.
const SITE_URL = resolveSiteUrl();

export default defineConfig({
  base: new URL(SITE_URL).pathname,
  define: { 'import.meta.env.VITE_SITE_URL': JSON.stringify(SITE_URL) },
  plugins: [
    {
      name: 'site-url',
      // index.html writes absolute URLs (canonical, og:url, og:image) as %SITE_URL%.
      transformIndexHtml: { order: 'pre', handler: (html) => html.replaceAll('%SITE_URL%', SITE_URL) },
    },
  ],
});
