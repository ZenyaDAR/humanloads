# Changelog

Notable changes to humanloads, newest first. The site deploys continuously from `main`, so entries are
grouped by date rather than by version. Daily data refreshes are not listed.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections (Added, Changed, Fixed, Removed).

## Unreleased

### Added

- README badges for any package on npm, not only the ones in `data/tracked.json`: every package page offers its badge
  markdown. A small badge service (`server/`, on Railway) answers catalog packages from the nightly build and computes
  any other package on its first request. Packages whose badge is requested on two or more days join a badge list the
  nightly build refreshes in a rotation; one nobody requests for 45 days leaves it. The service limits new
  computations per client and overall, never limits badges it already has, and keeps no data about readers.
- New data file `badges/all.json`: the badge of every recently refreshed package; `summary.json` gains `badgeList`.
- Ranked lists under `/lists/`: the most downloaded npm packages, and the best packages by category, ordered by real installs.
- Comparison pages for 100 pairs, up from 32.
- A list of the [most downloaded deprecated npm packages](https://humanloads.dev/docs/deprecated-npm-packages), with each maintainer's own message.
- Package pages show a dependency trail where one can be followed: when one package requires another and the matching versions get
  nearly the same downloads, it probably explains them. There is also a [guide using is-number as the example](https://humanloads.dev/docs/why-is-number-has-so-many-downloads).
- "Is X still used?" compares a package's growth with the median package in the catalog, since npm's counts rise across the board.
- New data file `insights.json`: the deprecated list, dependency trails and median growth.

### Changed

- Static badge files (`badges/<name>.json`) are written only for `data/tracked.json`, so a link to one never starts
  returning 404. Two names that map to the same file (`@a/b` and `a__b`) no longer share it.
- The badge preview on a package page follows the page's own estimate, including the confidence that evidence settles.
- The nightly build stops starting new fetches after an hour and writes what it has, rather than hitting the job timeout.
- Workflow actions are pinned to commit SHAs.
- A package that leaves the catalog keeps its page, out of search indexes, instead of turning into a 404. So does a comparison page waiting for numbers.
- Comparison packages are refreshed in rotation rather than every night, so the rest of the catalog keeps growing. Their pages show the date of their oldest row.
- The number is now called **real installs**: npm's count without publish spikes and the crawler floor. CI, builds and dependency
  installs remain, which the methodology spells out. Titles and text now use what people search for ("npm downloads", "npm download stats").
- New guides: how to check an npm package's download count, and whether npm downloads are real. The homepage gained popular
  packages and common questions, and package pages answer "How many people use X?"
- "High" confidence now also needs independent evidence of use. A steady stream of direct tarball requests used to earn it.
- Large numbers are rounded to three digits. When noise is under 1% of at least 1M a week, pages show only that.
- The "most bot-inflated" list is now "most noise in npm's count": settled packages only, one per scope, no fresh releases,
  no deprecated packages, and a list of excluded names. "Most real humans" is gone: it was npm's own top list.
- The share of downloads on the main major version moved up, next to the numbers.
- Package pages now stay up: a catalog of up to 1,500 packages carries over between builds and is refreshed in rotation, and each
  page shows the date of its own numbers. Data files: `featured.json` now has `examples` and `noisiest`; `summary.json` has `model`
  and, per row, `updated` and `tooNew`.
- The top of a range now keeps any publish spike cut that week, since real users can arrive on release day.
- Redesigned number cards: one layout for huge, small and new packages, a bar showing the noise share, and the reasons behind a number
  moved into a "Why this estimate" section. Home cards line up and show the same bar. Deprecated packages get a notice at the top.
- While independent evidence loads, the confidence pill says "checking evidence…" instead of a level that may change.
- Pages no longer download the whole catalog just to set a description.

### Fixed

- "Is X still maintained?" quotes the project's README when it says it is in maintenance mode or unmaintained. moment used to get "most likely yes" from its release dates alone.
- "Biggest dependents" is now "some packages that depend on it": the list behind it is incomplete and missed the biggest ones.
- The chart and the 12-month breakdown say that past real installs use this week's share.
- The nightly run retries a 402 from ecosyste.ms, which often answers 200 next, and logs how many packages lost an evidence source.
- Ordinary weekdays of popular packages were cut as spikes after npm outages: axios briefly showed 21% noise instead of about 0%.
- Packages under two weeks old showed "0" with a range of "0". They now read "too new to tell".
- Days before a package's first publish were reported as npm outages.
- A package with nothing left after filtering could still be described as having a human work rhythm.
- The methodology named deps.dev, which the site does not call; the privacy section left out npms.io, which search suggestions do call.

## 2026-11-04

### Added

- Popular comparisons (react vs vue, jest vs vitest, express vs fastify and more) as prerendered pages, linked
  from the homepage and from each package page.
- GitHub link in the header.
- Cookieless page-view counts with Cloudflare Web Analytics.
- "Is X still maintained?" and "Is X still used?" on package pages: release history, maintainers, deprecation,
  download trend, version adoption and weekday rhythm.
- New and changed pages are announced to search engines through IndexNow.
- `favicon.ico` and an Apple touch icon next to the SVG favicon, for search results and older browsers.

### Changed

- Pages of packages under 1,000 estimated human installs a week stay available but are no longer indexed or listed
  in the sitemap and `llms.txt`.
- Shorter page titles and meta descriptions, within the limits search engines report on.

- Search-friendly page titles and descriptions ("zod npm downloads vs real human installs", "How many people
  really use zod?"), with compact numbers.
- Live data is fetched at most once a day; pushes on the same day reuse it.
- No layout shift when the app takes over a prerendered page.

### Fixed

- Badge preview colors now pass contrast checks.
- No more 404 in the console for the calibration file.

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
