<div align="center">

# humanloads

**How many humans actually use an npm package?**

[![Website](https://img.shields.io/website?url=https%3A%2F%2Fhumanloads.dev&label=humanloads.dev&up_message=online)](https://humanloads.dev)
[![Deploy](https://github.com/ZenyaDAR/humanloads/actions/workflows/deploy.yml/badge.svg)](https://github.com/ZenyaDAR/humanloads/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![No backend](https://img.shields.io/badge/backend-none-brightgreen.svg)](#privacy)
[![No tracking](https://img.shields.io/badge/tracking-none-brightgreen.svg)](#privacy)

[![humanloads: npm counts every tarball fetch, we estimate the humans](public/og.png)](https://humanloads.dev)

</div>

## The problem

npm's download counter counts every tarball fetch, not every person. Registry mirrors, security scanners,
CI pipelines and crawlers all add to it. A brand-new version gets 100–150 "downloads" within days even if
nobody uses it, and crawlers fetch every old version a few times a week, forever.

For a big package that noise is a rounding error. For a small one it can be 90% of the number. So "1,200
weekly downloads" might mean a thriving project, or two users and a lot of robots.

## What humanloads does

Type a package name at **[humanloads.dev](https://humanloads.dev)** and get:

- **An estimate of real human installs per week**, next to npm's raw count, as a range with an honest
  confidence level (high, medium or low).
- **Where the downloads went**: how much went to mirrors and scanners, how much to crawlers, how much to people.
- **A per-version breakdown**: the flat "crawler floor" every version gets, and what sits above it.
- **Independent evidence of use** that is much harder to fake: dependent packages and repositories,
  jsDelivr CDN hits, GitHub activity.
- **Side-by-side comparison** of 2–3 packages: [react vs vue](https://humanloads.dev/compare/react,vue).
- **Daily lists** of the packages with the most real humans and the most bot-inflated counts.

## How the estimate works

1. **Cut the publish spikes.** Every new version gets a burst from mirrors in its first days. Each spike is
   compared with the same weekday in the weeks around it and cut back to that level.
2. **Subtract the crawler floor.** Robots download *every* published version at about the same weekly rate.
   That floor is measured on old versions and subtracted from all of them.
3. **Report a range, not a number.** What is left becomes a weekly range, widened by counting noise, with a
   confidence level. Weekday rhythm and independent evidence can raise confidence; missing data never lowers it.

A canary package that nobody uses is published regularly to measure the bot noise directly.
The full method, thresholds and known limits are on the
**[methodology page](https://humanloads.dev/docs/methodology)**.

> Nobody knows the exact number of users of an npm package, npm included. humanloads gives an estimate
> and shows its working.

## Badge for your README

Show real human installs next to your download count:

[![humans/week](https://img.shields.io/endpoint?url=https://humanloads.dev/badges/zod.json)](https://humanloads.dev/zod)

```md
[![humans/week](https://img.shields.io/endpoint?url=https://humanloads.dev/badges/<name>.json)](https://humanloads.dev/<name>)
```

For a scoped package, `@scope/name` becomes `scope__name` in the badge URL. Badges are rebuilt daily for
packages listed in [`data/tracked.json`](data/tracked.json): add yours with a one-line pull request.

## Open data

The daily numbers are published as JSON, free to use:

- [`/data/summary.json`](https://humanloads.dev/data/summary.json): every package estimated in the last run
  (npm weekly count, estimated humans, range, bot share, confidence).
- [`/data/featured.json`](https://humanloads.dev/data/featured.json): the homepage lists.
- [`/llms.txt`](https://humanloads.dev/llms.txt): a summary of the site for AI assistants.

## Privacy

humanloads is a static site with no backend, no accounts, no cookies and no analytics. Your browser talks to
public APIs (npm, ecosyste.ms, deps.dev, jsDelivr, GitHub) directly; fonts come from Google Fonts.

## Built with

TypeScript and [Vite](https://vite.dev), [Rough.js](https://roughjs.com) for the hand-drawn charts, hosted on
GitHub Pages. One runtime dependency, tested with Node's built-in test runner.

## Contributing

Issues and pull requests are welcome, especially when an estimate looks wrong for a package you know well.
See [CONTRIBUTING.md](CONTRIBUTING.md) to get started and [CHANGELOG.md](CHANGELOG.md) for what changed.
Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
