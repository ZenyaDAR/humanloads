// Usage: npm run data
// Build-time data for the static site, written into public/ (gitignored; CI generates it before `vite build`):
//   public/data/calibration.json  canary-measured crawler floor ({} while the canary isn't on npm)
//   public/data/featured.json     homepage cards
//   public/data/summary.json      per-package numbers for every estimated package (prerendered pages, sitemap)
//   public/data/insights.json     derived from the catalog: deprecated list, dependency trails, median growth
//   public/badges/<safe>.json     shields.io endpoint badges for data/tracked.json, plus badges/index.json
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchConfidenceEvidence, fetchPackageData, isValidPackageName } from '../src/core/sources.ts';
import { awaitingEvidence, estimate, MODEL_VERSION } from '../src/core/estimate.ts';
import { packageFacts } from '../src/core/insights.ts';
import { PackageNotFoundError } from '../src/core/types.ts';
import { resolveSiteUrl } from '../site.config.ts';
import { badgeFor, buildInsights, calibrate, deprecatedToRefresh, mergeCatalog, poolFailure, readPrevious, refreshPlan, safeName, selectFeatured, topPages } from './data-lib.ts';

const CANARY = 'humanloads-canary';
const CONCURRENCY = 4;
const QUERIES = ['cli', 'react', 'typescript', 'parser', 'eslint-plugin', 'vite-plugin', 'utility', 'logger'];
const SEARCH_SIZE = 15;
// The most downloaded packages seed the catalog. Each page is 10-30 MB, so a run reads a few pages and the next run moves on.
const TOP_URL = 'https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages?sort=downloads&order=desc&per_page=100';
const MIN_EVIDENCE_WEEKLY = 10; // below this the estimate is noise and evidence can't change confidence
// Recently released packages: where bot downloads are a large share. Pre-filtered by ecosyste.ms monthly downloads.
const RECENT_URL = 'https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages?sort=latest_release_published_at&order=desc&per_page=100';
const RECENT_PAGES = 2;
const RECENT_MIN_MONTHLY = 400; // ~100/week, the inflated-list threshold
const MAX_PACKAGES = 150; // fetchPackageData calls per run
const MAX_RETRIES = 6;
const EVIDENCE_RETRIES = 1; // optional data: an outage there must not stall the run for an hour
const MAX_RETRY_AFTER_MS = 120_000;

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const tracked = JSON.parse(await readFile(new URL('../data/tracked.json', import.meta.url), 'utf8'));
// Popular comparison pairs get prerendered pages, so their packages need numbers in summary.json.
const comparePairs = JSON.parse(await readFile(new URL('../data/compare.json', import.meta.url), 'utf8'));
// Names kept out of the catalog and homepage lists by hand (offensive names and the like). Their pages still work live.
const blocked = new Set(JSON.parse(await readFile(new URL('../data/blocklist.json', import.meta.url), 'utf8')));
// Names people search for or that the deprecated list and dependency trails need, ahead of the automatic sources.
const handSeeds = JSON.parse(await readFile(new URL('../data/seeds.json', import.meta.url), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = async (rel, obj) => {
  const file = pub + rel;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj) + '\n');
};

// fetch with retry on 429 / 5xx / network errors: honours Retry-After, else exponential backoff (2s..60s).
// api.npmjs.org rate-limits hard (a 200-package run got 100 429s with 4 short retries), so be patient.
async function retryFetch(url, init, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
      // ecosyste.ms sometimes answers 402 and then 200 for the same URL.
      if (res.status !== 429 && res.status !== 402 && res.status < 500) return res;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
    }
    if (attempt >= maxRetries) return res;
    const retryAfter = Number(res?.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000);
  }
}

// Runs fn over items with at most CONCURRENCY in flight; failures are logged and dropped.
// Permanent 404s (unpublished package, typo in tracked.json) go to `notFound` so they don't fail the run.
const notFound = new Set();
async function pool(items, fn) {
  const out = new Map();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        out.set(item, await fn(item));
      } catch (err) {
        if (err instanceof PackageNotFoundError) {
          notFound.add(item);
          console.warn(`skip ${item}: not on npm (404)${tracked.includes(item) ? ', no badge; remove it from data/tracked.json' : ''}`);
        } else {
          console.warn(`skip ${item}: ${err.message}`);
        }
      }
      if (++done % 20 === 0) console.log(`progress: ${done}/${items.length} (${out.size} ok)`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

let calibration;
try {
  calibration = calibrate(await fetchPackageData(CANARY, retryFetch), CANARY);
  if (calibration) {
    await write('data/calibration.json', calibration);
    console.log(`calibration: floor ${calibration.floorPerVersion}/version`);
  } else {
    console.log(`calibration: ${CANARY} has too little history or an implausible floor, nothing written`);
  }
} catch (err) {
  console.log(
    err instanceof PackageNotFoundError
      ? `calibration: ${CANARY} is not on npm yet (404), nothing written`
      : `calibration: skipped (${err.message})`,
  );
}
// Always ship the file, so the site's fetch never logs a 404; `{}` means "no calibration, use the default floor".
if (!calibration) await write('data/calibration.json', {});

// The catalog from the live site: pages stay up between builds, and only part of it is refreshed each night.
// Any failure aborts, or one bad fetch (a wrong SITE_URL returns 404 too) would shrink the catalog for good.
// A site's very first deploy has no file yet: set ALLOW_EMPTY_CATALOG=1 for that one run.
async function previousCatalog() {
  const res = await retryFetch(`${resolveSiteUrl()}data/summary.json`);
  if (res.status === 404 && process.env.ALLOW_EMPTY_CATALOG) return { rows: {}, pending: [] };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return readPrevious(await res.json(), MODEL_VERSION);
}
let previous, pending;
try {
  ({ rows: previous, pending } = await previousCatalog());
} catch (err) {
  console.error(`data: aborting, could not read the previous catalog (${err.message}); nothing written`);
  process.exit(1);
}
const previousSize = Object.keys(previous).length;
console.log(`previous catalog: ${previousSize} packages, ${pending.length} waiting for numbers from this model`);

// New names: the most downloaded packages, a few registry searches, and recently released packages with some
// downloads. Fresh releases mostly show their own spike; they qualify for the homepage list only once settled.
const getList = async (label, url, pick) => {
  try {
    const res = await retryFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return pick(await res.json());
  } catch (err) {
    console.warn(`${label} failed: ${err.message}`);
    return [];
  }
};
const searched = [];
for (const q of QUERIES) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${SEARCH_SIZE}`;
  searched.push(...(await getList(`search "${q}"`, url, (b) => (b.objects ?? []).map((o) => o.package.name))));
}
const recent = [];
for (let page = 1; page <= RECENT_PAGES; page++) {
  recent.push(
    ...(await getList(`recent releases page ${page}`, `${RECENT_URL}&page=${page}`, (b) =>
      b.filter((p) => (p.downloads ?? 0) >= RECENT_MIN_MONTHLY).map((p) => p.name),
    )),
  );
}
const top = [];
for (const page of topPages(Math.floor(Date.now() / 86_400_000))) {
  top.push(...(await getList(`top packages page ${page}`, `${TOP_URL}&page=${page}`, (b) => b.map((p) => p.name))));
}
// Deprecated names from those pages go first, or the list would wait its turn behind everything else. npm's small per-version
// document says it reliably; the deprecated status in ecosyste.ms flags too few.
const unseen = [...new Set(top)].filter((n) => typeof n === 'string' && isValidPackageName(n) && !Object.hasOwn(previous, n));
const latest = await pool(unseen, async (name) => {
  const res = await retryFetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, undefined, 1);
  return res.ok ? Boolean((await res.json()).deprecated) : false;
});
const retired = unseen.filter((n) => latest.get(n));
console.log(`checked ${unseen.length} new top names, ${retired.length} deprecated`);
// Names that already have a page come first.
const seeds = [...pending, ...retired, ...handSeeds];
for (let i = 0; i < Math.max(top.length, searched.length, recent.length); i++) {
  seeds.push(top[i], searched[i], recent[i]);
}
// Tracked and comparison packages are refreshed every night, so a badge or compare page never goes stale.
// `--limit N` (or DATA_LIMIT=N) caps the optional names for quick local runs, required ones always run; CI uses MAX_PACKAGES.
const limitArg = process.argv.indexOf('--limit');
const limit = Number(limitArg > 0 ? process.argv[limitArg + 1] : process.env.DATA_LIMIT) || MAX_PACKAGES;
// Names come from third-party APIs and later reach URLs and file paths.
const usable = (name) => typeof name === 'string' && name !== CANARY && !blocked.has(name) && isValidPackageName(name);
const must = [...new Set([...tracked, ...comparePairs.flat()])].filter(usable);
// Whatever the homepage shows is refreshed nightly too: it says "no release in the last two weeks" and must stay true.
const shown = [...selectFeatured(Object.values(previous)).noisiest.map((r) => r.name), ...deprecatedToRefresh(Object.values(previous))].filter(usable);
const candidates = refreshPlan([...new Set([...must, ...shown])], seeds.filter(usable), previous, Math.min(limit, MAX_PACKAGES));
console.log(`refreshing ${candidates.length}: ${must.length} required, new names from ${top.length} top, ${searched.length} searched, ${recent.length} recent`);

const opts = calibration ? { calibration } : {};
const updated = new Date().toISOString();
let evidenceGaps = 0;
const fresh = await pool(candidates, async (name) => {
  const data = await fetchPackageData(name, retryFetch);
  let e = estimate(data, opts);
  let evidence;
  // Two more calls per package, so skip them where they can't change anything.
  if (e.lastWeek.organic >= MIN_EVIDENCE_WEEKLY && !e.tooNew) {
    evidence = await fetchConfidenceEvidence(name, (url, init) => retryFetch(url, init, EVIDENCE_RETRIES));
    e = estimate(data, { ...opts, evidence });
  }
  // A source outage says nothing about the package: keep yesterday's "high" instead of downgrading it for weeks.
  // Only when evidence is all that is missing: a package that fell under the volume or floor bar has lost "high" anyway.
  const sourceFailed = evidence && [evidence.dependentPackages, evidence.dependentRepos, evidence.cdnHitsMonth].includes(null);
  const keepHigh = sourceFailed && awaitingEvidence(e) && Object.hasOwn(previous, name) && previous[name].confidence === 'high';
  if (sourceFailed) evidenceGaps++;
  const description = data.registry.description?.trim();
  return {
    name,
    ...(description && { description: description.length > 120 ? description.slice(0, 119) + '…' : description }),
    npmWeekly: e.lastWeek.npm,
    organicWeekly: e.lastWeek.organic,
    low: e.lastWeek.low,
    high: e.lastWeek.high,
    inflation: e.lastWeek.npm > 0 ? Math.max(0, Math.min(1, 1 - e.lastWeek.organic / e.lastWeek.npm)) : 0,
    confidence: keepHigh ? 'high' : e.confidence,
    ...(e.tooNew && { tooNew: true }),
    updated,
    facts: e.lastWeek.npm > 0 ? packageFacts(data, e) : undefined,
    ...(data.pulls && Object.keys(data.pulls).length && { pulls: data.pulls }),
  };
});
// A silent outage would quietly hold new packages below "high".
if (evidenceGaps) console.warn(`evidence: at least one source failed for ${evidenceGaps} of ${fresh.size} packages`);

// Fail before writing anything, so the build fails and the previous Pages deploy stays live.
const failure = poolFailure(candidates, fresh, tracked, notFound);
if (failure) {
  console.error(`data: aborting, ${failure}; featured, badges and summary not written`);
  process.exit(1);
}

const catalog = mergeCatalog(previous, fresh, { gone: notFound, blocked, keep: new Set(must), now: updated });

// Featured cards.
const { examples, popular, noisiest } = selectFeatured(Object.values(catalog));
const generated = updated;
await write('data/featured.json', { generated, examples, popular, noisiest });
const insights = buildInsights(Object.values(catalog), generated);
await write('data/insights.json', insights);

// Badges for tracked packages.
const badged = [];
for (const name of tracked) {
  const r = catalog[name];
  if (!r) continue;
  await write(`badges/${safeName(name)}.json`, badgeFor(r));
  badged.push(name);
}
await write('badges/index.json', badged);

// Numbers for the prerendered pages: the whole catalog, each row with the date it was last refreshed.
const stillPending = pending.filter((n) => usable(n) && !Object.hasOwn(catalog, n) && !notFound.has(n));
await write('data/summary.json', { generated, model: MODEL_VERSION, packages: catalog, pending: stillPending });

console.log(
  `data: ${fresh.size}/${candidates.length} packages refreshed, ${Object.keys(catalog).length} in the catalog, ${stillPending.length} pending; ` +
    `featured ${examples.length} examples + ${noisiest.length} noisiest; ${insights.deprecated.length} deprecated, ${Object.keys(insights.chains).length} trails; ${badged.length} badges; calibration ${calibration ? 'yes' : 'no'}`,
);
