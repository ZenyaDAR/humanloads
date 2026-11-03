# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Get a badge for your package

Add the package name to [`data/tracked.json`](data/tracked.json) and open a pull request. The badge appears after
the next daily build. That is the whole change; no code needed.

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

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
