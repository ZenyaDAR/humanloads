# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Get a badge for your package

Open the package's page on [humanloads.dev](https://humanloads.dev) and copy the markdown under "Add a badge to your
README". It works for any package on npm; no pull request needed.

For a permanent static badge file (`badges/<name>.json`, refreshed every night and never dropped), add the package
name to [`data/tracked.json`](data/tracked.json) and open a pull request.

## An estimate looks wrong

Open an issue with the "Estimate looks wrong" template. Include the package name and why you think the number is off
(for example, known usage, a private mirror, a release pattern). Estimates are ranges by design, so say how far off it is.

## Develop

Requires Node 22.18 or newer.

```sh
npm i
npm run data -- --limit 60   # optional: live data for the homepage cards and badges (network)
npm run dev
```

The badge service (`server/`) runs without a build step and needs no npm packages:

```sh
node server/index.ts         # http://localhost:8787/badge/<name>; settings at the top of the file
```

Before opening a pull request:

```sh
npm test
npm run build
```

## Ground rules

- **No new dependencies** unless a few lines of code can't do the job. The site ships one runtime dependency.
- **Code, comments, identifiers and commit messages in English.**
- **The estimate is the product.** A change to `src/core/estimate.ts` needs a test in `test/estimate.test.ts`
  (fixtures live in `test/fixtures/`, fetch new ones with `node scripts/fetch-fixture.mjs <package>`),
  and an update to the methodology page (`src/core/methodology.ts`) and `docs/METHODOLOGY.md`.
- **No hardcoded site URLs.** Absolute URLs come from `SITE_URL` (`site.config.ts`).
- **Accessibility and both themes.** Check new UI in light and dark mode, at phone width, and with the keyboard.
- Add a line to [`CHANGELOG.md`](CHANGELOG.md) for anything a user would notice.

## How the site is built and deployed

- `.github/workflows/deploy.yml` tests, builds and publishes `dist/` to GitHub Pages. No build output is committed.
- Live data (`public/data/`, `public/badges/`) is fetched by `npm run data` (about 150 packages, several minutes).
  It runs at most once a day: the nightly schedule fetches it and caches it, and pushes reuse that day's cache.
  To refetch on demand: Actions → Deploy to GitHub Pages → Run workflow → tick "Refetch live data".
- Pushes that only touch Markdown or GitHub templates don't deploy.
- The site URL is one setting, `SITE_URL` (`site.config.ts`, overridable by a repository variable). Canonical links,
  Open Graph, sitemap, robots.txt, llms.txt, JSON-LD, badges and the Vite base path all derive from it.
- The badge service (`server/`) deploys to Railway from `main` (`railway.json`), as one instance with a volume for its
  SQLite file. The site links badges to it when the repository variable `BADGE_API_URL` is set. Each night
  `npm run data` reads its request log (`GET /requested`, with the `BADGE_SYNC_TOKEN` secret, the same value as the
  service's variable) and keeps the badge list in `summary.json`: names requested on two or more days join it, and
  leave after 45 days without a request.
- GitHub disables scheduled workflows after 60 days without repository activity; a push or a manual run restarts them.
- The calibration canary (`canary/`, `.github/workflows/canary.yml`) runs only when the repository variable
  `CANARY_ENABLED` is `true`. The first publish needs an `NPM_TOKEN` secret; after that, configure npm trusted
  publishing for that workflow and delete the secret.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
