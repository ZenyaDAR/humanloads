# humanloads

**How many humans actually use an npm package?**

npm's download counter counts every tarball fetch: registry mirrors, security scanners, CI, crawlers.
A brand-new version gets ~100–150 "downloads" within days even if nobody uses it.
humanloads estimates the real human installs behind the number.

**Live:** [humanloads.dev](https://humanloads.dev) (a package page: `<site>/<package>`, scoped: `<site>/@scope/name`).
`<site>` below is the site URL set by `SITE_URL` (see [Site URL and custom domain](#site-url-and-custom-domain)).

## Features

- **Estimate** of weekly human installs next to the raw npm count, with a range and a confidence level.
- **Evidence of use** from independent sources: dependent packages and repos, CDN hits, GitHub activity.
- **Compare** several packages side by side.
- **Badges** for your README.

Everything runs in the browser against public APIs. Homepage data, badges and calibration are
precomputed daily by GitHub Actions and deployed with the site.
GitHub disables scheduled workflows after 60 days without repository activity; then badges and
calibration stop updating until the next commit or a manual run (Actions → Run workflow).

The canary workflow runs only when the repository variable `CANARY_ENABLED` is `true`. Add an `NPM_TOKEN`
secret for the first publish (npm trusted publishing can only be set up once the package exists), then
configure npm trusted publishing for `.github/workflows/canary.yml` and delete the secret.

## Badge

```md
![humans/week](https://img.shields.io/endpoint?url=<site>/badges/<safe>.json)
```

Each tracked package page has a "Copy markdown" button with the full URL filled in. `<safe>` is the package name with `@scope/name` written as `scope__name`.
Badges exist only for packages listed in [`data/tracked.json`](data/tracked.json):
**open a PR that adds your package there** and the badge appears after the next daily build.

## Local development

```sh
npm i
npm run data   # optional: fetches live data into public/data and public/badges (network)
npm run dev
npm test
```

The site works without `npm run data`; the homepage just has no precomputed cards.

## Site URL and custom domain

Every absolute URL (canonical, Open Graph, sitemap, robots.txt, llms.txt, JSON-LD, badges) and the Vite base
path come from one setting, `SITE_URL`. The default lives in [`site.config.ts`](site.config.ts) (`https://humanloads.dev/`; a repository variable `SITE_URL` overrides it).
To move to a custom domain:

1. Repository → Settings → Secrets and variables → Actions → Variables: add `SITE_URL` = `https://your-domain.com/`.
   The deploy workflow passes it to the build; the base path becomes `/` and `dist/CNAME` is written.
2. At your DNS provider: for an apex domain add `A` records to `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153`, `185.199.111.153` (and `AAAA` to `2606:50c0:8000::153` … `8003::153`); for a subdomain add a
   `CNAME` record to `<user>.github.io`.
3. Repository → Settings → Pages → Custom domain: enter the domain, wait for the DNS check, tick "Enforce HTTPS".
   Then re-run the deploy workflow and update the badge URLs in any README that uses them.

Locally: `SITE_URL=https://your-domain.com/ npm run build`.

## Docs

- How the estimate works: `<site>/docs/methodology` (English, source: [src/core/methodology.ts](src/core/methodology.ts));
  the full working notes are in [docs/METHODOLOGY.md](docs/METHODOLOGY.md) (Russian)
- Plan and stages: [docs/PLAN.md](docs/PLAN.md) (Russian)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).
Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
