<div align="center">

# humanloads

**npm download stats, and how many are real installs.**

[![Website](https://img.shields.io/website?url=https%3A%2F%2Fhumanloads.dev&label=humanloads.dev&up_message=online)](https://humanloads.dev)
[![Deploy](https://github.com/ZenyaDAR/humanloads/actions/workflows/deploy.yml/badge.svg)](https://github.com/ZenyaDAR/humanloads/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Static site](https://img.shields.io/badge/site-static-brightgreen.svg)](#privacy)
[![No cookies](https://img.shields.io/badge/cookies-none-brightgreen.svg)](#privacy)

[![humanloads: npm counts every tarball fetch, we estimate the real installs](public/og.png)](https://humanloads.dev)

</div>

## The problem

npm's download counter counts every tarball fetch, not every person. Registry mirrors, security scanners,
CI pipelines and crawlers all add to it. A brand-new version gets 100–150 "downloads" within days even if
nobody uses it, and crawlers fetch every old version a few times a week, forever.

For a small package mirror spikes and crawlers can be 90% of the number, so "1,200 weekly downloads" might mean a
busy project, or a few users plus mirrors and crawlers. For a big package they are a rounding error, and the count is
mostly CI, builds and dependency installs that no public data can separate from people.

## What humanloads does

Type a package name at **[humanloads.dev](https://humanloads.dev)** and get:

- **Real installs per week**, next to npm's raw count: what remains after removing publish spikes and the
  crawler floor, as a range with a confidence level (high, medium or low).
- **Where the downloads went**: how much went to mirrors and scanners, how much to crawlers, how much is left.
- **Which versions are in use**: the share on the latest major version, and a per-version breakdown with the flat
  "crawler floor" every version gets.
- **Independent signals of use**: dependent packages and repositories, jsDelivr CDN hits, GitHub activity.
  Harder to fake than downloads, but signals, not proof.
- **Side-by-side comparison** of 2–3 packages: [react vs vue](https://humanloads.dev/compare/react,vue).
- **A daily list** of settled packages with the most noise in their count.
- **Ranked lists** ("most downloaded", "best test frameworks" and more), and short guides on how to read npm's numbers.

**This is not a count of people.** Real installs still include CI runs, Docker builds and installs as a
dependency of other packages. Nobody can tell those apart from people using public data, npm included.

## How the estimate works

1. **Cut the publish spikes.** Every new version gets a burst from mirrors in its first days. Each spike is
   compared with the same weekday in the weeks around it and, if it is more than twice that level, cut back to it.
2. **Subtract the crawler floor.** Robots download *every* published version at about the same weekly rate.
   That floor is measured on old versions and subtracted from all of them.
3. **Report a range, not a number.** What is left becomes a weekly range, widened by counting noise, and its top
   keeps any spike that was cut, since real users can arrive on release day. High confidence needs independent
   evidence of use, because direct tarball requests pass both filters.

A canary package that nobody uses gets a new version once a week, so its old versions measure the crawler floor
directly. The numbers have
not been checked against packages with a known audience yet. The full method, thresholds and known limits are on
the **[methodology page](https://humanloads.dev/docs/methodology)**.

## Badge for your README

Show real installs next to your download count:

[![real installs/week](https://img.shields.io/endpoint?url=https://humanloads.dev/badges/zod.json)](https://humanloads.dev/zod)

```md
[![real installs/week](https://img.shields.io/endpoint?url=https://humanloads.dev/badges/<name>.json)](https://humanloads.dev/<name>)
```

For a scoped package, `@scope/name` becomes `scope__name` in the badge URL. These static badges exist for the
packages listed in [`data/tracked.json`](data/tracked.json), refreshed daily and never dropped: add yours with a
one-line pull request.

Any other npm package can have a badge too: its page on the site gives you the markdown. That badge is served by
a small service ([`server/`](server/)) that runs the same model. A badge requested on two or more days joins the
nightly build's badge list, refreshed in a rotation (the whole list within about ten days); one nobody requests for
45 days leaves it and is computed again on its next request. The first request for a brand-new package can read "calculating…" for a
few minutes. The service runs as a single instance; its limits and setup are documented in
[`server/index.ts`](server/index.ts).

## Open data

The daily numbers are published as JSON, free to use:

- [`/data/summary.json`](https://humanloads.dev/data/summary.json): the catalog, part of which is refreshed each
  night (npm weekly count, real installs, range, noise share, confidence, date of that row), and the badge list.
- [`/badges/all.json`](https://humanloads.dev/badges/all.json): the badge of every recently refreshed package, by name.
- [`/data/lists.json`](https://humanloads.dev/data/lists.json): the rows behind the ranked lists.
- [`/data/featured.json`](https://humanloads.dev/data/featured.json): the homepage list.
- [`/data/insights.json`](https://humanloads.dev/data/insights.json): the most downloaded deprecated packages, dependency trails and median growth across the catalog.
- [`/llms.txt`](https://humanloads.dev/llms.txt): a summary of the site for AI assistants.

## Privacy

humanloads is a static site with no accounts and no cookies. Your browser talks to public APIs
(npm, npms.io for search suggestions, ecosyste.ms, jsDelivr, GitHub) directly; fonts come from Google Fonts. Page views are counted with
[Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/), which uses no cookies and does not
fingerprint or track visitors across sites.

The badge service behind README badges sees requests from shields.io, not from the people reading a README. It
stores package names, their badges and the days each badge was requested. An address shows up in its log only when it
goes over a rate limit.

## Built with

TypeScript and [Vite](https://vite.dev), charts drawn as plain SVG, hosted on GitHub Pages. Two runtime
dependencies, [marked](https://marked.js.org) and [DOMPurify](https://github.com/cure53/DOMPurify), render package
READMEs. Tested with Node's built-in test runner. The badge service is plain Node with
its built-in SQLite, on [Railway](https://railway.com).

## Contributing

Issues and pull requests are welcome, especially when an estimate looks wrong for a package you know well.
See [CONTRIBUTING.md](CONTRIBUTING.md) to get started and [CHANGELOG.md](CHANGELOG.md) for what changed.
Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
