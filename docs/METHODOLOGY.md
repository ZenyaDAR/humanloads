# Methodology: how we filter npm download counts

> A shorter, reader-friendly version of these notes lives on the site: https://humanloads.dev/docs/methodology

> We report **real installs**: npm's count without the publish spikes from mirrors and scanners, and without the crawler floor.
> **This is not a count of people.** CI runs, Docker builds and dependency installs all remain, and no public data can
> separate them. The filter helps most on small packages, where these two patterns can be most of the count.

## 1. What npm actually counts

`api.npmjs.org` returns the number of successful (HTTP 200) downloads of a package's `.tgz` archive per day.
Uniqueness, IP, User-Agent and client type are not taken into account. The count includes:

| Source | How it looks in the data |
|---|---|
| Mirrors (Artifactory, Nexus, npmmirror, Verdaccio proxies...) | A spike on the day a version is published, fading out over 2-4 days |
| Security scanners and crawlers | A flat "floor": **every** version gets the same number of downloads per week |
| Other projects' CI | Regular downloads of one (pinned) version, often on weekdays |
| Developers | Uneven, mostly the latest version and versions pinned in lock files |
| Direct tarball requests, including deliberate inflation | Indistinguishable from the rest |

## 2. Confirmed on real data (a small package, 2026-07…11)

| Date | Downloads | Event |
|---|---|---|
| 2026-07-22 | 341 | 3 versions published (≈114 per version) |
| 2026-08-16 | 254 | 2 versions published (≈127 per version) |
| 2026-08-18 | 147 | 1 version published |
| all other days | 0-11 | background |

Downloads per version over the last week: `0.1.0: 3, 0.2.0: 3, 0.2.1: 3, 0.3.0: 3, 0.3.1: 3, 0.4.0: 5`.
Every version received exactly 3 downloads. That is the pattern of a crawler that fetches every version.
Above that floor there are only **2** downloads of the latest version. Of 20 weekly downloads, roughly 2 are left after filtering.

This matches the Tenable research: ~100-150 automated downloads for every new version.

## 3. Model v3

Inputs (all public, CORS is open):
- `GET https://api.npmjs.org/downloads/range/last-year/<pkg>`: downloads per day over the last year.
- `GET https://registry.npmjs.org/<pkg>`: the `time` field (version publish dates) and metadata.
- `GET https://api.npmjs.org/versions/<pkg>/last-week`: downloads per version over 7 days.

### Step A. Cut out publish spikes (daily series)
1. For each publish day `p`, take the window `[p, p+3]` days.
2. For each day `d` in the window, the background is `b = max(median of the same weekday over -14/-7 days, median over +7/+14 days)`.
   Zeros (the npm API has outages where a day is reported as 0) are skipped. Days inside other publish windows are skipped too,
   unless nothing else is left (`react` publishes canaries almost daily).
   If both sides are empty, take the median of days of the same kind (weekdays or weekends) within ±14 days, so that an ordinary
   weekday is never compared with a weekend. Only if there are none (a young package), take any non-zero day within ±14 days.
3. A day counts as a spike only if `actual > 2·b` (`SPIKE_FACTOR`). Its value is then replaced with `b`, and the difference is attributed to mirrors and scanners.

Why this and not "the median of the 14 days before publication" (checked on fixtures):
- `react` publishes canary versions almost daily: there are no days without a publish, so the background came out as 0 and organic as 0%;
- `zod` has a weekday/weekend difference of about 2.5×: a plain median cut off every weekday (651M false "mirror" downloads);
- npm outage days with zeros dragged the background down.

Comparing against the same weekday removes the weekly rhythm. Taking the maximum of "before" and "after" keeps a lasting rise.
The 2× threshold lets normal fluctuations through. A short burst of real users on release day looks exactly like a mirror spike and
gets cut, so the upper bound of the range keeps every spike cut in the last 7 days (see step C).

Regression (2026-11): with npm outages on the same weekday one and two weeks back, and no data after the publish yet, the
old neighbouring-day fallback landed on weekend levels and cut ordinary weekdays: axios showed 21% noise for two days.

### Step B. Subtract the crawler floor (weekly per-version slice)
1. `f` = lower percentiles of weekly downloads among versions older than 14 days (fresh ones are still inside the spike window), see item 2.
2. Weekly real installs ≈ `Σ max(0, vᵢ − f) − (downloads cut out in step A over the last 7 days)`.
   Per-version downloads include the spike of the fresh version, so we subtract it to stay on the cleaned scale.
   The floor for the point estimate is the 10th percentile, for the lower bound the 25th, for the upper bound the minimum.
   **Download pumping** (Tenable 2026: hundreds of versions in a few days). With publishes every day for weeks, every background
   day lies in another publish window, step A has nothing clean to compare with and cuts nothing. So the subtracted amount is
   `max(step A cut, Σ min(100, max(0, vᵢ − f)))` over versions whose window `[p, p+3]` reaches the last 7 days
   (`BOT_HITS_PER_NEW_VERSION = 100`, the low end of Tenable's 100–150). The upper bound uses the step A cut only, like a cut
   spike: the bot share is assumed, not measured. A note appears when the extra part is ≥ 10% of the cleaned week.
   On fixtures only `react` moves (−1,000 of 245M a week, its canaries); a synthetic pump goes from 94% "real" to ≤ 15%.
3. The ratio `organic_week / cleaned_week` is applied to the cleaned series from step A. This gives the daily estimate.
   Zero days among the last 7 (from the first publish on) with a background ≥ 10 are treated as an npm outage: in the ratio's denominator we replace them with the background
   (per-version downloads do count those days), otherwise the ratio gets pinned to 1. The daily series itself is not changed.
4. If there are fewer than 3 old versions, `f` cannot be estimated. In that case we take the floor `f₀` from the canary calibration (item 5,
   `floorPerVersion`), and if there is none, the global constant 3. The point estimate is `f₀`, the lower bound is `2·f₀`,
   the upper bound is 0. The notes say where the floor came from. If `f` was measured, the calibration is not used.

5. Under two weeks after the first publish (`tooNew`) there is no background to compare with, so a spike can't be told
   from first users. Confidence is `low`, the page says "too new to tell", and the range reaches the whole week's count.

### Step C. Confidence
Confidence is about the noise filter, not about whether downloads come from people.

- filtered < 10 per week, or `tooNew` → `low`: the noise is comparable to the signal;
- filtered ≥ 1000 per week, floor measured **and** independent evidence → `high`;
- floor not measured (too few old versions) → `low`, or `medium` with independent evidence or a weekly rhythm;
- otherwise `medium`.

**Independent evidence** (item 4): ≥ 5 dependent packages, or ≥ 10 dependent repositories, or ≥ 1000 jsDelivr CDN hits per month.
**Weekly rhythm**: weekday/weekend ratio ≥ 1.3 (see below). It is weak: CI and weekday releases have it too, and it is easy to fake.

Why `high` needs evidence: a steady stream of direct tarball requests to one version passes both filters. Volume, a measured
floor and a rhythm can all be produced that way, while dependents are harder to fake (not impossible). No evidence means `medium`,
not lower: absence of data is not a negative signal for a small package. The nightly build checks ecosyste.ms and jsDelivr
(`fetchConfidenceEvidence`), so static pages and live pages agree. Each rule that fires adds a note. The rhythm is shown only
at 10 or more real installs a week, since below that it would contradict the number.

**Weekday/weekend ratio** (`signals.weekdayRatio`): the mean of the cleaned series (step A) on weekdays /
the mean on weekends over the last 8 full Mon-Sun weeks (UTC). `null` if there is less than 4 weeks of data or if
the weekend mean is 0 and the weekday mean is < 1. If weekends are 0 and weekdays are ≥ 1, we use one download across all
weekends instead of 0, so the number stays finite. On fixtures: is-thirteen 3.6, lodash and request 1.5,
react and zod 1.2-1.3, the small package 1.3 (but organic 2, so the rule does not fire).

The result is always shown as a **range**, not a single number. We add count noise to the bounds from step B:
for a point estimate of `n` per week, the lower bound is no higher than `n − ⌈2·√n⌉` and the upper bound is no lower than `n + ⌈2·√n⌉`
(≈ a 95% Poisson interval, `NOISE_Z = 2`; for `n = 0` the upper bound is 4, from the exact 3.69), clamped to `[0, cleaned_week]`. Otherwise, when all old versions
sit on the same floor, the range collapses to a point. The upper bound then adds every spike cut in those 7 days.
For the small package (`n = 2`) this gives `≈ 0–5 / week`.

The range covers only these sources of error, not CI or other automation. A narrow range is not a sign of accuracy, so large numbers are
shown rounded to three digits. When noise is under 1% of at least 1M a week, the page shows only that, without a separate best guess.

## 4. Independent evidence of usage (not downloads)

| Signal | Source | What it means |
|---|---|---|
| Dependent packages | `packages.ecosyste.ms` | Someone published a package that depends on yours |
| Dependent repositories | `packages.ecosyste.ms` (`dependent_repos_count`) | Public projects with the package in their manifest |
| CDN hits | `data.jsdelivr.com/v1/stats/packages/npm/<pkg>` | Use on websites via jsDelivr |
| GitHub | `api.github.com/repos/...` | Stars, forks, open issues and the last push (display only) |

These are signals, not proof, and lower bounds: private repositories and corporate projects are invisible to everyone.

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

- **Canary package.** `humanloads-canary` is an empty package that nobody uses. A workflow (`.github/workflows/canary.yml`,
  opt-in via `CANARY_ENABLED`) publishes a new patch once a week. Everything it receives comes from mirrors, scanners and
  crawlers, so it is the reference for `f`. The nightly data build (`calibrate()` in `scripts/data-lib.ts`) takes the
  **median** of last week's downloads over its versions older than 14 days and writes `public/data/calibration.json`
  (`floorPerVersion`, `updated`, `source`); without old versions it writes `{}` and the default stays. The spike size is
  not measured: the model does not use it. The model only reads this file:
  `estimate(data, { calibration })` takes `floorPerVersion` instead of the constant 3 when the package's own floor is not measured (step B.4).
  A reading above 100 per version is treated as implausible and ignored.
- **Control group (planned, not done).** 20-30 packages with known real usage. Today only 8 fixtures guard against regressions,
  and none has a known audience. Nothing validates the numbers against real user counts yet.
- **Weekdays/weekends.** Work has a weekly rhythm, while crawlers do not.
  If a series shows a rhythm, it is a weak argument for real use (implemented, see step C).
  Caveat: CI and weekday releases have it too, so the rhythm only raises `low → medium`, never to `high`.

## 6. Known limitations
- Not validated against real user counts. The canary only shows that an unused package comes out near zero.
- CI, Docker builds and dependency installs are not removed. For very popular packages they are most of the count, so the model barely changes
  npm's number, and that number says little about people. Growth can reflect automation too.
- Traffic served by private and corporate mirrors (Artifactory, Nexus, company proxies) never reaches npm, so nobody can see it.
- Inflated counts from direct requests cannot be told apart. Independent evidence limits how much confidence they can get.
- npm publishes its data 1-2 days late.
- Packages under two weeks old are "too new to tell": the range runs up to the whole week's count and confidence is `low`.
