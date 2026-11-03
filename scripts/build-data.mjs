// Usage: npm run data
// Build-time data for the static site, written into public/ (gitignored; CI generates it before `vite build`):
//   public/data/calibration.json  canary-measured crawler floor ({} while the canary isn't on npm)
//   public/data/featured.json     homepage cards
//   public/data/summary.json      per-package numbers for every estimated package (prerendered pages, sitemap)
//   public/badges/<safe>.json     shields.io endpoint badges for data/tracked.json, plus badges/index.json
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPackageData } from '../src/core/sources.ts';
import { estimate } from '../src/core/estimate.ts';
import { PackageNotFoundError } from '../src/core/types.ts';
import { badgeFor, calibrate, poolFailure, safeName, selectFeatured } from './data-lib.ts';

const CANARY = 'humanloads-canary';
const CONCURRENCY = 4;
const QUERIES = ['cli', 'react', 'typescript', 'parser', 'eslint-plugin', 'vite-plugin', 'utility', 'logger'];
const SEARCH_SIZE = 15;
// Recently released packages: where bot downloads are a large share. Pre-filtered by ecosyste.ms monthly downloads.
const RECENT_URL = 'https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages?sort=latest_release_published_at&order=desc&per_page=100';
const RECENT_PAGES = 2;
const RECENT_MIN_MONTHLY = 400; // ~100/week, the inflated-list threshold
const MAX_PACKAGES = 150; // fetchPackageData calls per run
const MAX_RETRIES = 6;

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const tracked = JSON.parse(await readFile(new URL('../data/tracked.json', import.meta.url), 'utf8'));
// Popular comparison pairs get prerendered pages, so their packages need numbers in summary.json.
const comparePairs = JSON.parse(await readFile(new URL('../data/compare.json', import.meta.url), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = async (rel, obj) => {
  const file = pub + rel;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj) + '\n');
};

// fetch with retry on 429 / 5xx / network errors: honours Retry-After, else exponential backoff (2s..60s).
// api.npmjs.org rate-limits hard (a 200-package run got 100 429s with 4 short retries), so be patient.
async function retryFetch(url, init) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
      if (res.status !== 429 && res.status < 500) return res;
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
    }
    if (attempt >= MAX_RETRIES) return res;
    const retryAfter = Number(res?.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000);
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
    console.log(`calibration: ${CANARY} has too little history yet, nothing written`);
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

// Candidate pool: tracked packages, a few registry searches (mostly popular: "humans"),
// and recently released packages with some downloads (where bots dominate: "inflated").
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
// Tracked and comparison packages first (the cap never drops a badge or a compare page), then searched and recent interleaved so any cap keeps both kinds.
const names = new Set([...tracked, ...comparePairs.flat()]);
for (let i = 0; i < Math.max(searched.length, recent.length); i++) {
  if (searched[i]) names.add(searched[i]);
  if (recent[i]) names.add(recent[i]);
}
names.delete(CANARY);
// `--limit N` (or DATA_LIMIT=N) caps the pool for quick local runs; CI uses the full MAX_PACKAGES.
const limitArg = process.argv.indexOf('--limit');
const limit = Number(limitArg > 0 ? process.argv[limitArg + 1] : process.env.DATA_LIMIT) || MAX_PACKAGES;
const candidates = [...names].slice(0, Math.min(limit, MAX_PACKAGES));
console.log(`candidates: ${names.size} (${searched.length} searched, ${recent.length} recent releases), fetching ${candidates.length}`);

const opts = calibration ? { calibration } : undefined;
const rows = await pool(candidates, async (name) => {
  const data = await fetchPackageData(name, retryFetch);
  const e = estimate(data, opts);
  const description = data.registry.description?.trim();
  return {
    name,
    ...(description && { description: description.length > 120 ? description.slice(0, 119) + '…' : description }),
    npmWeekly: e.lastWeek.npm,
    organicWeekly: e.lastWeek.organic,
    low: e.lastWeek.low,
    high: e.lastWeek.high,
    inflation: e.lastWeek.npm > 0 ? Math.max(0, Math.min(1, 1 - e.lastWeek.organic / e.lastWeek.npm)) : 0,
    confidence: e.confidence,
  };
});

// Fail before writing anything, so the build fails and the previous Pages deploy stays live.
const failure = poolFailure(candidates, rows, tracked, notFound);
if (failure) {
  console.error(`data: aborting, ${failure}; featured, badges and summary not written`);
  process.exit(1);
}

// Featured cards.
const all = [...rows.values()];
const { humans, inflated } = selectFeatured(all);
const generated = new Date().toISOString();
await write('data/featured.json', { generated, humans, inflated });

// Badges for tracked packages.
const badged = [];
for (const name of tracked) {
  const r = rows.get(name);
  if (!r) continue;
  await write(`badges/${safeName(name)}.json`, badgeFor(r));
  badged.push(name);
}
await write('badges/index.json', badged);

// Numbers for the prerendered pages: every package estimated in this run, so each one gets an indexable page.
await write('data/summary.json', { generated, packages: Object.fromEntries(rows) });

console.log(
  `data: ${rows.size}/${candidates.length} packages estimated, ${candidates.length - rows.size} skipped; ` +
    `featured ${humans.length} humans + ${inflated.length} inflated; ${badged.length} badges; calibration ${calibration ? 'yes' : 'no'}`,
);
