// Badge service: a shields.io endpoint badge for any package on npm. A thin layer in front of the nightly build:
//   GET /badge/<name>   e.g. /badge/zod, /badge/@scope/name
//   GET /requested      the request log, for the nightly build (bearer token)
// Names in the nightly catalog (badges/all.json, held in memory) are answered without any work. Any other name is
// computed here with the same model the package page runs, kept until the nightly build takes it over, and logged.
// The build reads the log, adds names requested on two or more days to its badge list, refreshes that list in a
// rotation, and drops names nobody requested for 45 days; a dropped name that comes back is computed here again.
// A first request that takes too long answers "calculating…"; the computation keeps running, so the next request
// (shields asks again after cacheSeconds) gets the number.
// Platform-free: Request in, Response out. server/http.ts adds the HTTP server, server/index.ts the wiring.
// ponytail: limits, the in-flight map and the queue live in memory, so the service runs as exactly one instance
// (railway.json numReplicas 1). More instances need these in shared storage.
import { timingSafeEqual } from 'node:crypto';
import { estimate } from '../src/core/estimate.ts';
import { fetchConfidenceEvidence, fetchPackageData, isValidPackageName } from '../src/core/sources.ts';
import { BADGE_LABEL, badgeOf, needsEvidence } from '../src/core/badge.ts';
import { PackageNotFoundError, type Calibration, type ShieldsBadge } from '../src/core/types.ts';
import { DAY_MS, type Store } from './store.ts';

export interface Limits {
  compute: RateLimit; // new names, all clients together: the one limit a forged client address can't get around
  refresh: RateLimit; // background refreshes and the queue: their own budget, so a flood of new names can't starve them
  client: ClientGate; // new names per client, with a short cooldown
  maxRunning: number; // computations at once: a registry document can be tens of MB to download and parse
}

export interface Deps {
  store: Store;
  siteUrl: string; // with a trailing slash
  fetch: typeof fetch;
  limits: Limits;
  syncToken?: string; // GET /requested needs it; unset: the endpoint doesn't exist
  now?: () => number;
  answerWithinMs?: number;
}

const FRESH_MS = DAY_MS; // older: served as is, recomputed in the background
const MISSING_FRESH_MS = 10 * 60 * 1000; // "not found" is checked again soon: the package may be published any minute
const CATALOG_TTL_MS = 3600 * 1000; // badges/all.json and calibration.json change once a night
const CATALOG_RETRY_MS = 60 * 1000; // after a failed fetch: keep the last good copy, try again soon
const CATALOG_MAX_AGE_MS = 3 * DAY_MS; // an all.json this old means the nightly build stopped: compute instead
const CATALOG_MIN_SHARE = 0.5; // a new all.json under half the last good one is a broken build, not a smaller catalog
const QUEUE_MAX = 5000;
export const REQUEST_LOG_DAYS = 45;
const ANSWER_WITHIN_MS = 2500;
const SHIELDS_CACHE_S = 3600;
const RETRY_S = 300; // shields' floor for endpoint badges

// ---------- limits ----------

// Fixed window per key. `failOpen`: when the key table is full of live windows, let unknown keys through (per-client
// limits, where a global limit backs them up) instead of refusing them (the global limit itself).
export class RateLimit {
  private hits = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;
  readonly limit: number;
  readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly failOpen: boolean;
  constructor(limit: number, windowMs: number, opts: { maxKeys?: number; failOpen?: boolean } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = opts.maxKeys ?? 100_000;
    this.failOpen = opts.failOpen ?? false;
  }
  take(key: string, now: number): boolean {
    let h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (!h && this.hits.size >= this.maxKeys) {
        // One sweep per window at most: a flood of new keys must not make every request scan the whole table.
        if (now - this.lastSweep >= this.windowMs) {
          this.lastSweep = now;
          for (const [k, old] of this.hits) if (now - old.start >= this.windowMs) this.hits.delete(k);
        }
        if (this.hits.size >= this.maxKeys) return this.failOpen;
      }
      h = { start: now, count: 0 };
      this.hits.set(key, h);
    }
    return ++h.count <= this.limit;
  }
}

// Per-client budget for new computations. Over it, the client gets "busy" for new names during a short cooldown.
// Only computations are limited: stored and catalog badges are cheap and always answered, so nobody can get shields
// (whose few servers carry nearly all real traffic) banned by sending it junk URLs. The client is charged only for a
// computation the global limit allowed, so an attacker who uses up the global budget never cools shields down.
export class ClientGate {
  private readonly rate: RateLimit;
  private readonly cooldownMs: number;
  private readonly maxCooldowns: number;
  private readonly cooling = new Map<string, number>(); // client -> until (ms), in insertion order
  constructor(perMinute: number, cooldownMs: number, maxCooldowns = 50_000) {
    this.rate = new RateLimit(perMinute, 60_000, { failOpen: true });
    this.cooldownMs = cooldownMs;
    this.maxCooldowns = maxCooldowns;
  }
  coolingDown(client: string, now: number): boolean {
    const until = this.cooling.get(client);
    if (until === undefined) return false;
    if (until > now) return true;
    this.cooling.delete(client);
    return false;
  }
  take(client: string, now: number): boolean {
    if (this.rate.take(client, now)) return true;
    if (this.cooling.size >= this.maxCooldowns) this.cooling.delete(this.cooling.keys().next().value!); // oldest first
    this.cooling.set(client, now + this.cooldownMs);
    console.warn(`cooldown: ${logSafe(client)} over its new-name budget, no new computations for ${this.cooldownMs / 60_000} min`);
    return false;
  }
}

// Names and client keys come from requests: quoted and cut, so a log line can't be forged.
export const logSafe = (s: string): string => JSON.stringify(s.slice(0, 80));

// ---------- upstream fetch ----------

// Bounded in time and in bytes after decompression: npm sends large registry documents chunked and gzipped, without
// a content-length, so the body is counted as it is read. The timeout covers the body too. Only status and body are
// passed on (nothing here reads response headers).
export function boundedFetch(base: typeof fetch, timeoutMs: number, maxBytes: number): typeof fetch {
  return async (input, init) => {
    const res = await base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.body) return res;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${String(input)}: response over ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    // A Blob over the chunks: one copy of the body, not the chunks plus a joined buffer.
    return new Response(new Blob(chunks as BlobPart[]), { status: res.status, statusText: res.statusText });
  };
}

// One retry on 429, after Retry-After (capped): api.npmjs.org rate-limits hard, and one refusal shouldn't cost a badge.
export function retryOn429(base: typeof fetch, maxWaitMs: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    if (res.status !== 429) return res;
    const after = Number(res.headers.get('retry-after'));
    await sleep(Math.min(after > 0 ? after * 1000 : 2000, maxWaitMs));
    return base(input, init);
  };
}

// ---------- badge ----------

const note = (message: string, cacheSeconds: number, isError = false): ShieldsBadge => ({
  schemaVersion: 1, label: BADGE_LABEL, message, color: 'lightgrey', cacheSeconds, ...(isError && { isError }),
});

const jsonResponse = (body: unknown, maxAge: number, publicData = true): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(publicData && { 'access-control-allow-origin': '*' }), // badges: public, read-only, no credentials
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
const badgeResponse = (badge: ShieldsBadge) => jsonResponse(badge, Math.min(badge.cacheSeconds ?? SHIELDS_CACHE_S, SHIELDS_CACHE_S));

// Only the fields shields needs, so nothing else in a catalog file (logoSvg, links...) is passed through.
export function cleanBadge(x: any): ShieldsBadge | null {
  if (x?.schemaVersion !== 1 || typeof x.message !== 'string' || typeof x.color !== 'string') return null;
  return { schemaVersion: 1, label: BADGE_LABEL, message: x.message.slice(0, 40), color: x.color.slice(0, 20), cacheSeconds: SHIELDS_CACHE_S };
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<any> {
  try {
    const res = await fetchImpl(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// A value fetched from the site, refreshed hourly. A failed fetch (load returns null) keeps the last good value and
// retries in a minute; requests never wait on a refresh once a first value exists.
function siteValue<T>(load: (last: T | null) => Promise<T | null>, now: () => number, empty: T) {
  let value: T | null = null;
  let nextAt = 0;
  let loading: Promise<void> | null = null;
  const refresh = () =>
    (loading ??= load(value)
      .then((v) => {
        if (v !== null) value = v;
        nextAt = now() + (v !== null ? CATALOG_TTL_MS : CATALOG_RETRY_MS);
      })
      .finally(() => (loading = null)));
  return {
    get: async (): Promise<T> => {
      if (now() >= nextAt) {
        const job = refresh();
        if (value === null) await job;
      }
      return value ?? empty;
    },
    loaded: () => value !== null,
    reload: () => refresh(),
  };
}

export function createBadgeApp(deps: Deps) {
  const now = deps.now ?? Date.now;
  const answerWithinMs = deps.answerWithinMs ?? ANSWER_WITHIN_MS;
  const { store, limits } = deps;
  // One computation per name, however many requests ask for it at once.
  const inflight = new Map<string, Promise<ShieldsBadge | null>>();
  // Names refused for lack of capacity (not for a client's own budget), computed later from spare capacity, so
  // "busy" means "later", not "never". Insertion order: oldest first. Name -> the client who asked.
  const queue = new Map<string, string>();
  let running = 0;

  // Exact names, so "@a/b" and the unscoped "a__b" never share a badge.
  const catalog = siteValue<Map<string, ShieldsBadge>>(
    async (last) => {
      const file = await getJson(deps.fetch, `${deps.siteUrl}badges/all.json`);
      const all = file?.badges;
      if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
      const map = new Map<string, ShieldsBadge>();
      // The nightly build stopped: its numbers are getting older every day. Computing beats serving them.
      if (!(now() - Date.parse(file.generated) <= CATALOG_MAX_AGE_MS)) {
        console.warn(`catalog: badges/all.json is from ${logSafe(String(file.generated))}, ignored`);
        return map;
      }
      for (const [name, b] of Object.entries(all)) {
        const badge = cleanBadge(b);
        if (badge && isValidPackageName(name)) map.set(name, badge);
      }
      if (last && last.size && map.size < last.size * CATALOG_MIN_SHARE) {
        console.warn(`catalog: badges/all.json has ${map.size} badges, the last good copy ${last.size}; keeping the last copy`);
        return null;
      }
      return map;
    },
    now,
    new Map(),
  );
  const calibration = siteValue<Calibration | false>(
    async () => {
      const c = await getJson(deps.fetch, `${deps.siteUrl}data/calibration.json`);
      if (c === null) return null;
      return typeof c?.floorPerVersion === 'number' ? (c as Calibration) : false; // {} means "use the default floor"
    },
    now,
    false,
  );

  type Why = 'ok' | 'capacity' | 'client';
  // client null: a background refresh or a queued name, from the refresh budget. Returns the badge, or why not.
  async function compute(name: string, client: string | null): Promise<ShieldsBadge | Why> {
    if (running >= limits.maxRunning) return 'capacity';
    if (client === null) {
      if (!limits.refresh.take('all', now())) return 'capacity';
    } else {
      if (limits.client.coolingDown(client, now())) return 'client';
      if (!limits.compute.take('all', now())) return 'capacity';
      if (!limits.client.take(client, now())) return 'client';
    }
    running++;
    try {
      const cal = await calibration.get();
      const opts = cal ? { calibration: cal } : {};
      try {
        const data = await fetchPackageData(name, deps.fetch);
        let e = estimate(data, opts);
        if (needsEvidence(e)) e = estimate(data, { ...opts, evidence: await fetchConfidenceEvidence(name, deps.fetch) });
        return { ...badgeOf(e), cacheSeconds: SHIELDS_CACHE_S };
      } catch (err) {
        if (err instanceof PackageNotFoundError) return note('not found', RETRY_S, true);
        throw err;
      }
    } finally {
      running--;
    }
  }

  // logAs: the client to log a new name under (null: a refresh of a name already logged, or nothing to log).
  function refresh(name: string, client: string | null, logAs: string | null = client): Promise<ShieldsBadge | null> {
    let job = inflight.get(name);
    if (!job) {
      job = compute(name, client).then((result) => {
        if (typeof result === 'string') {
          if (result === 'capacity' && client !== null && queue.size < QUEUE_MAX) queue.set(name, client);
          return null;
        }
        try {
          store.putBadge(name, result, now());
          if (!result.isError && logAs !== null) store.seen(name, now(), { client: logAs });
        } catch (err) {
          console.error(`store: ${logSafe(name)}: ${err}`); // the next request computes again
        }
        return result;
      });
      const done = job;
      job.finally(() => inflight.get(name) === done && inflight.delete(name)).catch(() => {});
      job.catch((err) => console.warn(`compute: ${logSafe(name)}: ${String(err).slice(0, 200)}`));
      inflight.set(name, job);
    }
    return job;
  }

  // Computes queued names while there is spare capacity. server/index.ts calls it every few seconds.
  function drain(): number {
    let started = 0;
    for (const [name, client] of queue) {
      if (running >= limits.maxRunning) break;
      queue.delete(name);
      if (store.getBadge(name)) continue;
      // Background budget, logged under the client who asked. Over budget: back of the queue, try later.
      void refresh(name, null, client).then((b) => b === null && queue.size < QUEUE_MAX && queue.set(name, client)).catch(() => {});
      started++;
    }
    return started;
  }

  function requestLog(request: Request): Response {
    const token = deps.syncToken;
    if (!token) return new Response('Not found\n', { status: 404 });
    const given = Buffer.from(request.headers.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return new Response('Unauthorized\n', { status: 401 });
    return jsonResponse(store.requested(now() - REQUEST_LOG_DAYS * DAY_MS), 0, false);
  }

  // `client`: who is asking (an IP, or a /64 for IPv6), for the per-client limits.
  async function handle(request: Request, client = 'unknown'): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    const get = request.method === 'GET'; // HEAD (link checkers, crawlers) neither computes nor counts as a request
    const path = new URL(request.url).pathname;
    if (path === '/health') return new Response('ok\n');
    if (path === '/requested') return requestLog(request);
    const m = /^\/badge\/(.+)$/.exec(path);
    if (!m) return new Response('Usage: /badge/<npm package name>\n', { status: 404 });
    let name = '';
    try {
      name = decodeURIComponent(m[1]);
    } catch {}
    if (!isValidPackageName(name)) return badgeResponse(note('invalid name', SHIELDS_CACHE_S, true));

    const listed = (await catalog.get()).get(name);
    if (listed) {
      if (get) store.seen(name, now(), { free: true });
      return badgeResponse(listed);
    }

    const stored = store.getBadge(name);
    if (stored) {
      if (stored.badge.isError) {
        // A recheck of "not found" is a new-name computation, under the client's own budget: a pile of junk names
        // re-requested every 10 minutes must not drain the background budget that keeps real badges fresh.
        if (get && now() - stored.at >= MISSING_FRESH_MS) void refresh(name, client).catch(() => {});
      } else {
        if (get) store.seen(name, now(), { client });
        if (get && now() - stored.at >= FRESH_MS) void refresh(name, null, null).catch(() => {});
      }
      return badgeResponse(stored.badge);
    }
    // Until the catalog has loaded once, any name could be a catalog name: computing them all would download the
    // biggest packages on npm and fill the day's log with them.
    if (!get || !catalog.loaded()) return badgeResponse(note('calculating…', RETRY_S));

    const job = refresh(name, client);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => (timer = setTimeout(resolve, answerWithinMs, 'late')));
    try {
      const badge = await Promise.race([job, late]);
      if (badge === 'late') return badgeResponse(note('calculating…', RETRY_S));
      return badgeResponse(badge ?? note('busy, retry soon', RETRY_S));
    } catch {
      return badgeResponse(note('unavailable', RETRY_S)); // npm hiccup: not stored, the next request tries again
    } finally {
      clearTimeout(timer);
    }
  }

  // warm(): load the catalog and calibration before taking traffic. Retries a few times: until the catalog has loaded,
  // new names only get "calculating…".
  async function warm(attempts = 5, gapMs = 5000): Promise<boolean> {
    for (let i = 0; i < attempts && !catalog.loaded(); i++) {
      if (i) await new Promise((r) => setTimeout(r, gapMs));
      await catalog.reload();
    }
    await calibration.get();
    return catalog.loaded();
  }

  return Object.assign(handle, { warm, drain, queued: () => queue.size });
}
