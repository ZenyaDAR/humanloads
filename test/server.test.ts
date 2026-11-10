import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { ClientGate, RateLimit, boundedFetch, cleanBadge, createBadgeApp, retryOn429 } from '../server/app.ts';
import { clientKey, startServer } from '../server/http.ts';
import { DAY_MS, openStore } from '../server/store.ts';

const SITE = 'https://site.test/';
const DAY = DAY_MS;

const days = Array.from({ length: 365 }, (_, i) => ({ day: new Date(Date.now() - (366 - i) * DAY).toISOString().slice(0, 10), downloads: 100 }));
const registryDoc = (name: string) => ({
  name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} }, time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z' },
});
const CATALOG = {
  zod: { schemaVersion: 1, label: 'x', message: '≈ 9M', color: 'brightgreen', logoSvg: '<svg/>' },
  '@babel/core': { schemaVersion: 1, label: 'x', message: '≈ 80M', color: 'brightgreen' },
  'bad name': { schemaVersion: 1, label: 'x', message: 'x', color: 'red' },
};

// Waits for background work without timing assumptions: yields until the condition holds.
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), `timed out waiting for ${what}`);
}

interface Opts {
  packages?: string[];
  compute?: number;
  refresh?: number;
  perClient?: number;
  maxRunning?: number;
  newPerDay?: number;
  newPerClientDay?: number;
  hold?: Promise<void>; // registry fetches wait on this
  failing?: boolean;
  // badges/all.json as served: a body, or 'down'. Default: CATALOG generated "now".
  catalog?: (now: number) => unknown;
  syncToken?: string;
}

function setup(opts: Opts = {}) {
  const store = openStore(':memory:', { newPerDay: opts.newPerDay ?? 200, newPerClientDay: opts.newPerClientDay ?? 200 });
  const packages = new Set(opts.packages ?? []);
  const calls: string[] = [];
  let clock = Date.UTC(2026, 10, 10, 12);
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body));
    if (url === `${SITE}badges/all.json`) {
      const body = opts.catalog ? opts.catalog(clock) : { generated: new Date(clock).toISOString(), badges: CATALOG };
      return body === 'down' ? new Response('', { status: 503 }) : ok(body);
    }
    if (url === `${SITE}data/calibration.json`) return ok({});
    const m = /^https:\/\/(registry\.npmjs\.org|api\.npmjs\.org\/downloads\/range\/last-year|api\.npmjs\.org\/versions)\/([^/]+)/.exec(url);
    if (m) {
      if (opts.hold) await opts.hold;
      if (opts.failing) return new Response('', { status: 500 });
      const name = decodeURIComponent(m[2]);
      if (!packages.has(name)) return new Response('', { status: 404 });
      if (m[1] === 'registry.npmjs.org') return ok(registryDoc(name));
      if (m[1].includes('range')) return ok({ downloads: days });
      return ok({ downloads: { '1.0.0': 700 } });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const handle = createBadgeApp({
    store,
    siteUrl: SITE,
    fetch: fetchImpl,
    syncToken: opts.syncToken,
    limits: {
      compute: new RateLimit(opts.compute ?? 100, 60_000),
      refresh: new RateLimit(opts.refresh ?? 100, 60_000),
      client: new ClientGate(opts.perClient ?? 100, 2 * 60_000),
      maxRunning: opts.maxRunning ?? 4,
    },
    now: () => clock,
    answerWithinMs: opts.hold ? 20 : 5000,
  });
  const res = (path: string, init: RequestInit & { client?: string } = {}) => handle(new Request(`https://svc.test${path}`, init), init.client ?? '1.1.1.1');
  const get = (name: string, client = '1.1.1.1') => res(`/badge/${name}`, { client }).then((r) => r.json() as Promise<any>);
  const registryCalls = () => calls.filter((u) => u.startsWith('https://registry.npmjs.org')).length;
  const catalogCalls = () => calls.filter((u) => u.endsWith('all.json')).length;
  const log = () => store.requested(0);
  return { store, calls, handle, res, get, registryCalls, catalogCalls, log, tick: (ms: number) => (clock += ms), now: () => clock };
}

// ---------- the badge app ----------

test('server: a catalog package is answered from memory, extra fields dropped, logged without counting as new', async () => {
  const s = setup({ newPerDay: 0 });
  assert.deepEqual(await s.get('zod'), { schemaVersion: 1, label: 'real installs/week', message: '≈ 9M', color: 'brightgreen', cacheSeconds: 3600 });
  await s.get('zod');
  assert.equal(s.catalogCalls(), 1, 'catalog fetched once, then held');
  assert.equal(s.registryCalls(), 0);
  assert.deepEqual(s.log().map((r) => r.name), ['zod'], 'catalog names are logged even with no budget for new names');
});

test('server: an unscoped "a__b" never gets the catalog badge of "@a/b"', async () => {
  const s = setup();
  assert.equal((await s.get('babel__core')).message, 'not found');
  assert.equal((await s.get('%40babel%2Fcore')).message, '≈ 80M');
});

test('server: a new package is computed once, stored, logged, then served without npm calls', async () => {
  const s = setup({ packages: ['fresh-a'] });
  const [a, b] = await Promise.all([s.get('fresh-a'), s.get('fresh-a')]);
  assert.match(a.message, /^≈ \d/);
  assert.deepEqual(a, b);
  assert.equal(s.registryCalls(), 1, 'two concurrent requests, one computation');
  assert.deepEqual(await s.get('fresh-a'), a);
  assert.equal(s.registryCalls(), 1);
  assert.deepEqual(s.log().map((r) => [r.name, r.days]), [['fresh-a', 1]]);
});

test('server: scoped names work raw and percent-encoded', async () => {
  const s = setup({ packages: ['@scope/fresh'] });
  const raw = await s.get('@scope/fresh');
  assert.match(raw.message, /^≈ \d/);
  assert.deepEqual(await s.get('%40scope%2Ffresh'), raw);
});

test('server: a slow first computation answers "calculating…", the next request has the number', async () => {
  let release!: () => void;
  const s = setup({ packages: ['fresh-slow'], hold: new Promise<void>((r) => (release = r)) });
  const first = await s.get('fresh-slow');
  assert.deepEqual([first.message, first.cacheSeconds], ['calculating…', 300]);
  release();
  await until(() => s.store.getBadge('fresh-slow') !== null, 'the background computation');
  assert.match((await s.get('fresh-slow')).message, /^≈ \d/);
});

test('server: an npm failure answers "unavailable" and stores nothing', async () => {
  const s = setup({ packages: ['fresh-b'], failing: true });
  assert.equal((await s.get('fresh-b')).message, 'unavailable');
  assert.equal(s.store.getBadge('fresh-b'), null);
  assert.deepEqual(s.log(), []);
});

test('server: over the global limit a new name is "busy", queued, and computed later from spare capacity', async () => {
  const s = setup({ packages: ['p1', 'p2'], compute: 1 });
  assert.match((await s.get('p1')).message, /^≈ \d/);
  assert.equal((await s.get('p2')).message, 'busy, retry soon');
  assert.equal(s.handle.queued(), 1);
  assert.match((await s.get('p1')).message, /^≈ \d/, 'stored badges are never limited');
  assert.equal(s.handle.drain(), 1);
  await until(() => s.store.getBadge('p2') !== null, 'the queued computation');
  assert.equal(s.handle.queued(), 0);
  assert.ok(s.log().some((r) => r.name === 'p2'), 'logged under the client who asked');
});

test('server: an attacker using up the global limit never cools down another client', async () => {
  const s = setup({ packages: ['a1', 'a2', 'n1', 'n2', 'n3'], compute: 2, perClient: 1 });
  await s.get('a1', '6.6.6.6');
  await s.get('a2', '7.7.7.7'); // global budget gone
  for (const n of ['n1', 'n2', 'n3']) assert.equal((await s.get(n, '9.9.9.9')).message, 'busy, retry soon');
  s.tick(60_000); // new window
  assert.match((await s.get('n1', '9.9.9.9')).message, /^≈ \d/, 'the shields-like client was never charged nor cooled down');
});

test('server: a client over its new-name budget cools down for new names only', async () => {
  const s = setup({ packages: ['n1', 'n2', 'n3'], perClient: 1 });
  assert.match((await s.get('n1', '6.6.6.6')).message, /^≈ \d/);
  assert.equal((await s.get('n2', '6.6.6.6')).message, 'busy, retry soon');
  assert.equal(s.handle.queued(), 0, 'a client\'s own limit never queues its names');
  assert.equal((await s.get('zod', '6.6.6.6')).message, '≈ 9M', 'catalog badges still answered');
  assert.match((await s.get('n1', '6.6.6.6')).message, /^≈ \d/, 'stored badges still answered');
  assert.match((await s.get('n2', '7.7.7.7')).message, /^≈ \d/, 'other clients unaffected');
  s.tick(90_000);
  assert.equal((await s.get('n3', '6.6.6.6')).message, 'busy, retry soon', 'still cooling down');
  s.tick(60_000);
  assert.match((await s.get('n3', '6.6.6.6')).message, /^≈ \d/, 'cooldown over');
});

test('server: at most maxRunning computations at once', async () => {
  let release!: () => void;
  const s = setup({ packages: ['c1', 'c2'], maxRunning: 1, hold: new Promise<void>((r) => (release = r)) });
  assert.equal((await s.get('c1')).message, 'calculating…');
  assert.equal((await s.get('c2')).message, 'busy, retry soon');
  release();
  await until(() => s.store.getBadge('c1') !== null, 'c1');
  s.handle.drain();
  await until(() => s.store.getBadge('c2') !== null, 'c2 from the queue');
});

test('server: background refreshes have their own budget', async () => {
  const s = setup({ packages: ['old-1', 'new-1'], compute: 1, refresh: 5 });
  await s.get('old-1');
  s.tick(DAY + 1000); // a new window for both limits, and old-1 is stale
  await s.get('new-1'); // uses the single new-name slot
  await s.get('old-1'); // stale: served, refreshed from the refresh budget
  await until(() => s.store.getBadge('old-1')!.at === s.now(), 'the refresh');
});

test('server: "not found" is rechecked after 10 minutes under the client\'s budget; HEAD never computes or logs', async () => {
  const s = setup({ refresh: 0 });
  assert.equal((await s.get('later-pkg')).message, 'not found');
  assert.deepEqual(s.log(), [], '"not found" is not logged');
  const before = s.registryCalls();
  s.tick(5 * 60_000);
  await s.get('later-pkg');
  assert.equal(s.registryCalls(), before);
  s.tick(6 * 60_000);
  await s.res('/badge/later-pkg', { method: 'HEAD' });
  assert.equal(s.registryCalls(), before, 'HEAD serves the stale value without a recheck');
  await s.get('later-pkg');
  await until(() => s.registryCalls() === before + 1, 'the recheck, with no background budget at all');

  assert.equal((await (await s.res('/badge/never-seen', { method: 'HEAD' })).json()).message, 'calculating…');
  await s.res('/badge/zod', { method: 'HEAD' });
  assert.equal(s.registryCalls(), before + 1);
  assert.deepEqual(s.log(), [], 'HEAD requests are not logged');
});

test('server: until the catalog has loaded once, new names are not computed', async () => {
  let down = true;
  const s = setup({ packages: ['zod'], catalog: (now) => (down ? 'down' : { generated: new Date(now).toISOString(), badges: CATALOG }) });
  assert.equal((await s.get('zod')).message, 'calculating…');
  assert.equal(s.registryCalls(), 0, 'a catalog name is not downloaded from npm');
  assert.deepEqual(s.log(), []);
  assert.equal(await s.handle.warm(2, 0), false);
  down = false;
  assert.equal(await s.handle.warm(2, 0), true);
  assert.equal((await s.get('zod')).message, '≈ 9M');
});

test('server: a failed or shrunken catalog keeps the last good copy, an old one is ignored', async () => {
  let body: unknown = 'ok';
  const s = setup({ catalog: (now) => (body === 'ok' ? { generated: new Date(now).toISOString(), badges: CATALOG } : body) });
  assert.equal((await s.get('zod')).message, '≈ 9M');

  body = 'down';
  s.tick(61 * 60_000);
  await s.get('zod'); // starts the refresh, answers from the last copy
  await until(() => s.catalogCalls() === 2, 'the failed refresh');
  assert.equal((await s.get('zod')).message, '≈ 9M');

  body = { generated: new Date(s.now()).toISOString(), badges: { 'bad name': CATALOG['bad name'] } }; // 0 of 2 valid rows left
  s.tick(61_000);
  await s.get('zod');
  await until(() => s.catalogCalls() === 3, 'the retry a minute later');
  assert.equal((await s.get('%40babel%2Fcore')).message, '≈ 80M', 'a catalog under half the last one is refused');
  assert.equal(s.registryCalls(), 0);

  body = { generated: new Date(s.now() - 4 * DAY).toISOString(), badges: CATALOG };
  s.tick(61_000);
  await s.get('zod');
  await until(() => s.catalogCalls() === 4, 'the next retry');
  assert.equal((await s.get('zod')).message, 'not found', 'a 4-day-old catalog is ignored and the name computed');
});

test('server: method, path and name checks', async () => {
  const s = setup();
  assert.equal((await s.res('/badge/zod', { method: 'POST' })).status, 405);
  assert.equal((await s.res('/health')).status, 200);
  assert.equal((await s.res('/other')).status, 404);
  for (const bad of ['..%2F..%2Fetc', '%E0%A4%A', 'a%20b', '@a/b/c', 'bad%20name']) assert.equal((await s.get(bad)).message, 'invalid name', bad);
  assert.equal(s.calls.filter((u) => !u.startsWith(SITE)).length, 0);
});

test('server: GET /requested needs the exact bearer token, is off without one, and is not for browsers', async () => {
  const off = setup();
  assert.equal((await off.res('/requested')).status, 404);
  const token = 'x'.repeat(40);
  const s = setup({ syncToken: token });
  await s.get('zod');
  assert.equal((await s.res('/requested')).status, 401);
  assert.equal((await s.res('/requested', { headers: { authorization: `Bearer ${'y'.repeat(40)}` } })).status, 401);
  const ok = await s.res('/requested', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  assert.deepEqual((await ok.json()).map((r: any) => r.name), ['zod']);
});

test('cleanBadge keeps only what shields needs', () => {
  assert.equal(cleanBadge({ schemaVersion: 2, message: 'x', color: 'red' }), null);
  assert.deepEqual(cleanBadge({ schemaVersion: 1, label: 'evil', message: 'm'.repeat(100), color: 'red', logoSvg: '<svg/>', link: ['x'] }), {
    schemaVersion: 1, label: 'real installs/week', message: 'm'.repeat(40), color: 'red', cacheSeconds: 3600,
  });
});

// ---------- limits ----------

test('RateLimit: fixed window; a full table refuses (global) or lets through (per client), sweeping once a window', () => {
  const r = new RateLimit(2, 1000, { maxKeys: 2 });
  assert.deepEqual([r.take('a', 0), r.take('a', 1), r.take('a', 2)], [true, true, false]);
  assert.equal(r.take('a', 1000), true, 'new window');
  assert.equal(r.take('b', 1000), true);
  assert.equal(r.take('c', 1000), false, 'table full of live windows');
  assert.equal(r.take('c', 2500), true, 'expired windows swept');
  const open = new RateLimit(1, 1000, { maxKeys: 1, failOpen: true });
  open.take('a', 0);
  assert.equal(open.take('b', 0), true);
});

test('ClientGate: cooldown after the budget, and a hard cap on the cooldown table', () => {
  const g = new ClientGate(1, 60_000, 2);
  assert.equal(g.take('a', 0), true);
  assert.equal(g.coolingDown('a', 0), false);
  assert.equal(g.take('a', 1), false);
  assert.equal(g.coolingDown('a', 59_000), true);
  assert.equal(g.coolingDown('a', 61_000), false);
  const full = new ClientGate(0, 60_000, 2);
  for (const c of ['a', 'b', 'c']) full.take(c, 0);
  assert.equal((full as any).cooling.size, 2);
});

// ---------- store ----------

test('store: one log write per name per day, daily caps (shared and per client), pruning', () => {
  const st = openStore(':memory:', { newPerDay: 3, newPerClientDay: 2, keepRequestsMs: 45 * DAY });
  const t0 = Date.UTC(2026, 0, 1, 10);
  assert.equal(st.seen('a', t0, { client: 'x' }), true);
  assert.equal(st.seen('a', t0 + 1000, { client: 'x' }), true);
  assert.equal(st.seen('b', t0, { client: 'x' }), true);
  assert.equal(st.seen('c', t0, { client: 'x' }), false, "client x's share is used up");
  assert.equal(st.seen('c', t0, { client: 'y' }), true);
  assert.equal(st.seen('d', t0, { client: 'z' }), false, 'the shared cap is used up');
  assert.equal(st.seen('zod', t0, { free: true }), true, 'catalog names are free');
  assert.equal(st.seen('a', t0 + DAY), true);
  assert.equal(st.seen('d', t0 + DAY, { client: 'x' }), true, 'a new day, new budgets');
  assert.deepEqual(st.requested(0).map((r) => [r.name, r.days]), [['a', 2], ['b', 1], ['c', 1], ['d', 1], ['zod', 1]]);
  assert.equal(st.seen('e', Date.UTC(2026, 0, 2, 23, 59), { client: 'q' }), true);
  assert.equal(st.seen('e', Date.UTC(2026, 0, 3, 0, 1), { client: 'q' }), true);
  assert.equal(st.requested(0).find((r) => r.name === 'e')!.days, 2, '23:59 and 00:01 are two UTC days');

  st.putBadge('gone', { schemaVersion: 1, label: 'l', message: 'not found', color: 'lightgrey', isError: true }, t0);
  st.putBadge('kept', { schemaVersion: 1, label: 'l', message: '≈ 1', color: 'yellow' }, t0);
  assert.deepEqual(st.prune(t0 + 2 * DAY), { badges: 1, requests: 0 });
  assert.ok(st.getBadge('kept'));
  assert.deepEqual(st.prune(t0 + 46 * DAY), { badges: 1, requests: 3 }, 'b, c and zod: last seen on day 0; a, d and e later');
  st.close();
});

// ---------- upstream fetch ----------

test('boundedFetch: counts bytes as they arrive, with no content-length to trust; times out', async () => {
  const chunked = (n: number) =>
    (async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(1000)); c.close(); } }))) as unknown as typeof fetch;
  await assert.rejects(boundedFetch(chunked(11), 1000, 10_000)('https://x.test/big'), /over 10000 bytes/);
  const ok = await boundedFetch(chunked(3), 1000, 10_000)('https://x.test/small');
  assert.equal((await ok.arrayBuffer()).byteLength, 3000);
  const json = boundedFetch((async () => new Response('{"a":1}', { status: 404 })) as unknown as typeof fetch, 1000, 100);
  const res = await json('https://x.test/');
  assert.deepEqual([res.status, await res.json()], [404, { a: 1 }]);
  const hang = (async (_: unknown, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
  // AbortSignal.timeout doesn't keep the process alive (a server does); this timer stands in for it.
  const alive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(boundedFetch(hang, 20, 100)('https://x.test/slow'), /timeout|abort/i);
  } finally {
    clearTimeout(alive);
  }
});

test('retryOn429: one retry after Retry-After, capped', async () => {
  const waits: number[] = [];
  let n = 0;
  const base = (async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '60' } }) : new Response('ok'))) as unknown as typeof fetch;
  const res = await retryOn429(base, 5000, async (ms) => void waits.push(ms))('https://x.test/');
  assert.deepEqual([res.status, n, waits], [200, 2, [5000]]);
});

// ---------- HTTP layer ----------

test('clientKey: X-Real-IP only when it is an address, IPv6 by /64', () => {
  const req = (h: string | undefined, socket = '10.0.0.1') => ({ headers: h === undefined ? {} : { 'x-real-ip': h }, socket: { remoteAddress: socket } }) as any;
  assert.equal(clientKey(req('203.0.113.7')), '203.0.113.7');
  assert.equal(clientKey(req('1.1.1.1 blocked\tadmin')), '10.0.0.1', 'garbage falls back to the socket');
  assert.equal(clientKey(req('x'.repeat(15_000))), '10.0.0.1');
  assert.equal(clientKey(req('2001:db8:1:2:3:4:5:6')), '2001:db8:1:2::/64');
  assert.equal(clientKey(req('2001:db8:1:2::9')), '2001:db8:1:2::/64');
  assert.equal(clientKey(req('2001:db8::1')), '2001:db8:0:0::/64');
  assert.equal(clientKey(req('::ffff:198.51.100.4')), '198.51.100.4');
  assert.equal(clientKey(req(undefined, '')), 'unknown');
});

test('HTTP: methods, malformed targets, HEAD, and a handler that throws', async () => {
  const seen: [string, string][] = [];
  const server = await startServer(async (r, client) => {
    const path = new URL(r.url).pathname;
    if (path === '/boom') throw new Error('boom');
    seen.push([path, client ?? '']);
    return new Response('body', { headers: { 'x-a': '1' } });
  }, 0);
  const { port } = server.address() as AddressInfo;
  const raw = (line: string) =>
    new Promise<string>((resolve) => {
      import('node:net').then(({ connect }) => {
        const s = connect(port, '127.0.0.1', () => s.end(`${line}\r\nHost: x\r\nX-Real-IP: 203.0.113.9\r\n\r\n`));
        let out = '';
        s.on('data', (d) => (out += d)).on('close', () => resolve(out));
      });
    });
  try {
    assert.match(await raw('TRACE /badge/zod HTTP/1.1'), /^HTTP\/1\.1 405/);
    assert.match(await raw('GET http://evil.example/badge/zod HTTP/1.1'), /^HTTP\/1\.1 200/);
    assert.deepEqual(seen.at(-1), ['/badge/zod', '203.0.113.9'], 'only the path is used; client from X-Real-IP');
    const head = await raw('HEAD /badge/zod HTTP/1.1');
    assert.match(head, /^HTTP\/1\.1 200/);
    assert.ok(!head.includes('body'));
    assert.match(await raw('GET /boom HTTP/1.1'), /^HTTP\/1\.1 500/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
