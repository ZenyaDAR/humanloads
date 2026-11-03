# Methodology: how we estimate real installs

> A shorter, reader-friendly version of these notes lives on the site: https://humanloads.dev/docs/methodology

> The core rule of the project: we show an **estimate with an honest margin of error**, not an "exact number of users".
> Nobody has an exact number, including npm itself.

## 1. What npm actually counts

`api.npmjs.org` returns the number of successful (HTTP 200) downloads of a package's `.tgz` archive per day.
Uniqueness, IP, User-Agent and client type are not taken into account. The count includes:

| Source | How it looks in the data |
|---|---|
| Mirrors (Artifactory, Nexus, npmmirror, Verdaccio proxies...) | A spike on the day a version is published, fading out over 2-4 days |
| Security scanners and crawlers | A flat "floor": **every** version gets the same number of downloads per week |
| Other projects' CI | Regular downloads of one (pinned) version, often on weekdays |
| Live developers | Uneven, mostly the latest version and versions pinned in lock files |
| Inflated counts | Direct requests to the tarball URL, indistinguishable from the rest |

## 2. Confirmed on real data (a small package, 2026-07…11)

| Date | Downloads | Event |
|---|---|---|
| 2026-07-22 | 341 | 3 versions published (≈114 per version) |
| 2026-08-16 | 254 | 2 versions published (≈127 per version) |
| 2026-08-18 | 147 | 1 version published |
| all other days | 0-11 | background |

Downloads per version over the last week: `0.1.0: 3, 0.2.0: 3, 0.2.1: 3, 0.3.0: 3, 0.3.1: 3, 0.4.0: 5`.
Every version received exactly 3 downloads. This is how a robot behaves when it downloads all versions in a row once a week.
Above that floor there are only **2** downloads of the latest version. Of 20 weekly downloads, roughly 2 look organic.

This matches the Tenable research: ~100-150 automated downloads for every new version.

## 3. Model v1 (MVP)

Inputs (all public, CORS is open):
- `GET https://api.npmjs.org/downloads/range/<from>:<to>/<pkg>`: downloads per day (up to 18 months per request).
- `GET https://registry.npmjs.org/<pkg>`: the `time` field (version publish dates) and metadata.
- `GET https://api.npmjs.org/versions/<pkg>/last-week`: downloads per version over 7 days.

### Step A. Cut out publish spikes (daily series)
1. For each publish day `p`, take the window `[p, p+3]` days.
2. For each day `d` in the window, the background is `b = max(median of the same weekday over -14/-7 days, median over +7/+14 days)`.
   Zeros (the npm API has outages where a day is reported as 0) and days inside other windows are skipped.
   If both sides are empty, take the median of the non-zero days within ±14 days.
3. A day counts as a spike only if `actual > 2·b` (`SPIKE_FACTOR`). Its value is then replaced with `b`, and the difference is attributed to mirrors and scanners.

Why this and not "the median of the 14 days before publication" (checked on fixtures):
- `react` publishes canary versions almost daily: there are no days without a publish, so the background came out as 0 and organic as 0%;
- `zod` has a weekday/weekend difference of about 2.5×: a plain median cut off every weekday (651M false "mirror" downloads);
- npm outage days with zeros dragged the background down.

Comparing against the same weekday removes the weekly rhythm. Taking the maximum of "before" and "after" avoids cutting out growth in popularity.
The 2× threshold lets normal fluctuations through.

### Step B. Subtract the crawler floor (weekly per-version slice)
1. `f` = lower percentiles of weekly downloads among versions older than 14 days (fresh ones are still inside the spike window), see item 2.
2. Weekly organic ≈ `Σ max(0, vᵢ − f) − (downloads cut out in step A over the last 7 days)`.
   Per-version downloads include the spike of the fresh version, so we subtract it to stay on the cleaned scale.
   The floor for the point estimate is the 10th percentile, for the lower bound the 25th, for the upper bound the minimum.
3. The ratio `organic_week / cleaned_week` is applied to the cleaned series from step A. This gives the daily estimate.
   Zero days among the last 7 with a background ≥ 10 are treated as an npm outage: in the ratio's denominator we replace them with the background
   (per-version downloads do count those days), otherwise the ratio gets pinned to 1. The daily series itself is not changed.
4. If there are fewer than 3 old versions, `f` cannot be estimated. In that case we take the floor `f₀` from the canary calibration (item 5,
   `floorPerVersion`), and if there is none, the global constant 3. The point estimate is `f₀`, the lower bound is `2·f₀`,
   the upper bound is 0. The notes say where the floor came from. If `f` was measured, the calibration is not used.

### Step C. Confidence
Base rules:
- organic < 10 per week → `low`: the noise is comparable to the signal;
- floor `f` not measured (too few old versions) → `low`;
- organic ≥ 1000 per week with a measured floor → `high`;
- otherwise `medium`.

Upgrade `low → medium` (only when organic ≥ 10 per week, otherwise the estimate is noise):
- **independent evidence** (item 4): ≥ 5 dependent packages, or ≥ 10 dependent repositories,
  or ≥ 1000 jsDelivr CDN hits per month;
- **weekly rhythm**: weekday/weekend ratio ≥ 1.3 (see below).

Evidence does not raise confidence to `high` (the `high` rule stays as is) and never lowers confidence:
absence of data is not a negative signal. Each rule that fires adds a note
("12 published packages depend on it", "Weekday traffic is 1.8× weekend — human work rhythm").

**Weekday/weekend ratio** (`signals.weekdayRatio`): the mean of the cleaned series (step A) on weekdays /
the mean on weekends over the last 8 full Mon-Sun weeks (UTC). `null` if there is less than 4 weeks of data or if
the weekend mean is 0 and the weekday mean is < 1. If weekends are 0 and weekdays are ≥ 1, we use one download across all
weekends instead of 0, so the number stays finite. On fixtures: is-thirteen 3.6, lodash and request 1.5,
react and zod 1.2-1.3, the small package 1.3 (but organic 2, so the rule does not fire).

The result is always shown as a **range**, not a single number. We add count noise to the bounds from step B:
for a point estimate of `n` per week, the lower bound is no higher than `n − ⌈2·√n⌉` and the upper bound is no lower than `n + ⌈2·√max(n, 1)⌉`
(≈ a 95% Poisson interval, `NOISE_Z = 2`), clamped to `[0, cleaned_week]`. Otherwise, when all old versions
sit on the same floor, the range collapses to a point. For the small package (`n = 2`) this gives `≈ 0–5 / week`;
for large packages the band is negligible compared to the volume.

## 4. Independent evidence of usage (not downloads)

| Signal | Source | What it means |
|---|---|---|
| Dependent packages | `packages.ecosyste.ms`, `api.deps.dev` | Someone published a package that depends on yours |
| Dependent repositories | `packages.ecosyste.ms` (`dependent_repos_count`) | Public projects with the package in their manifest |
| CDN hits | `data.jsdelivr.com/v1/stats/packages/npm/<pkg>` | Use on websites via jsDelivr |
| GitHub | `api.github.com/repos/...` | Stars, forks and issues from **other** people |

This is a lower bound: private repositories and corporate projects are invisible to everyone.

Implemented (`fetchEvidence` in `src/core/sources.ts`). Sources are requested in parallel, and a failure of any one
(network, 404, 403/429 rate limit, malformed JSON) zeroes out only its own field (`null` / `[]`):
- `packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/<pkg>` → `dependent_packages_count`, `dependent_repos_count`;
  `.../dependent_packages?per_page=5&sort=downloads&order=desc` → the 5 most downloaded dependent packages.
  Scoped names are accepted both as `@scope/name` and as `@scope%2Fname`.
- `data.jsdelivr.com/v1/stats/packages/npm/<pkg>?period=month` → `hits.total`. A raw `/` is required here:
  `@scope%2Fname` returns 400.
- `api.github.com/repos/<owner>/<repo>` (the repository from the `repository` field, github.com only) → stars, forks,
  open issues, `pushed_at`. Without a token the limit is 60 requests per hour; on 403/429 the field is `null`.
- A link to GitHub code search: `"\"<pkg>\"" path:package.json` (quotes inside the phrase are escaped, so
  `zod` does not match `zod-to-json-schema`).

Thresholds for step C: dependent packages ≥ 5, repositories ≥ 10, CDN hits ≥ 1000 per month.
GitHub stars do not feed into confidence: they indicate interest, not installs.

## 5. Calibration

- **Canary package.** We publish an empty package `humanloads-canary` that nobody uses, and release a new
  version on a regular basis. Everything it receives is pure bot noise. It is the reference for `f` and for the spike size.
  Data collection is a separate script (a CI cron job); the result is published to `public/data/calibration.json`
  (`floorPerVersion`, `updated`, `source`; we do not measure the spike size yet, the model does not use it). The model only reads this file:
  `estimate(data, { calibration })` takes `floorPerVersion` instead of the constant 3 when the package's own floor is not measured (step B.4).
- **Control group.** 20-30 packages with known real usage (our own, popular, dead).
  We use them to check that the model does not underestimate popular packages or overestimate dead ones.
- **Weekdays/weekends.** Live developers have a weekly rhythm, bots do not.
  If a series shows a rhythm, it is an additional argument for organic traffic (implemented, see step C).
  Caveat: CI also runs on weekdays, so the rhythm only raises `low → medium`, never to `high`.

## 6. Known limitations
- Private usage is invisible by definition.
- Inflated counts from direct requests cannot be told apart.
- The floor `f` of very popular packages gets lost in the noise. For them the model barely changes the number, and that is correct.
- npm data lags by 1-2 days.
