# Changelog

Notable changes to humanloads, newest first. The site deploys continuously from `main`, so entries are
grouped by date rather than by version. Daily data refreshes are not listed.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections (Added, Changed, Fixed, Removed).

## 2026-11-03: first public release

### Added

- Estimate of weekly human installs for any npm package, next to npm's raw count, as a range with a confidence level.
- Package page: twelve-month chart, where the downloads went (mirrors, crawlers, humans), per-version table with the
  crawler floor, independent evidence of use (dependent packages and repositories, jsDelivr hits, GitHub activity).
- Compare page for 2–3 packages.
- Homepage lists built daily from live data: most real humans and most bot-inflated packages.
- Package search with suggestions.
- README badges (shields.io endpoint) for packages in `data/tracked.json`.
- English methodology page at `/docs/methodology`, with an FAQ.
- SEO and AI discoverability: prerendered pages with real content, canonical links, Open Graph, JSON-LD,
  `sitemap.xml`, `robots.txt` and `llms.txt`.
- Custom domain `humanloads.dev`; the site URL is one setting (`SITE_URL`, `site.config.ts`).
- Light and dark themes.
