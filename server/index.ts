// Entry point for the badge service on Railway (or any Node 22.18+ host): node server/index.ts
// Env:
//   PORT                     set by Railway
//   BADGE_DB                 SQLite file; defaults to badges.sqlite on the Railway volume (RAILWAY_VOLUME_MOUNT_PATH)
//   BADGE_SYNC_TOKEN         bearer token for GET /requested, the same value as the GitHub secret of that name
//                            (generate it: openssl rand -hex 32)
//   SITE_URL                 default from site.config.ts
//   COMPUTE_PER_MIN, REFRESH_PER_MIN, CLIENT_NEW_PER_MIN, MAX_RUNNING, NEW_NAMES_PER_DAY, NEW_NAMES_PER_CLIENT_DAY
//                            limits, defaults below
import { join } from 'node:path';
import { resolveSiteUrl } from '../site.config.ts';
import { ClientGate, RateLimit, boundedFetch, createBadgeApp, logSafe, retryOn429 } from './app.ts';
import { startServer } from './http.ts';
import { DAY_MS, openStore } from './store.ts';

// First, so nothing during startup can take the process down: a background computation that fails in a way nothing
// awaited is logged, not fatal.
process.on('unhandledRejection', (err) => console.error(`unhandled: ${logSafe(String(err))}`));

const env = process.env;
const int = (raw: string | undefined, fallback: number) => (Number.isInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback);

function dbPath(): string {
  if (env.BADGE_DB) return env.BADGE_DB;
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return join(env.RAILWAY_VOLUME_MOUNT_PATH, 'badges.sqlite');
  // On Railway without a volume the file would vanish on every deploy, and every badge would be computed again.
  if (env.RAILWAY_ENVIRONMENT) throw new Error('No volume: attach one to this service, or set BADGE_DB to a path on a volume');
  return 'badges.sqlite';
}

const path = dbPath();
const store = openStore(path, { newPerDay: int(env.NEW_NAMES_PER_DAY, 200), newPerClientDay: int(env.NEW_NAMES_PER_CLIENT_DAY, 20) });
const syncToken = env.BADGE_SYNC_TOKEN?.trim();
if (!syncToken) console.warn('BADGE_SYNC_TOKEN is not set: GET /requested is off, so the nightly build gets no new names');
else if (syncToken.length < 32) throw new Error('BADGE_SYNC_TOKEN must be at least 32 characters (openssl rand -hex 32)');

// ponytail: defaults sized for api.npmjs.org's rate limits from one address and a ~1 GB container; each computation is
// 3 to 5 npm calls, and a big registry document costs up to ~85 MB of heap while it is parsed.
const handle = createBadgeApp({
  store,
  siteUrl: resolveSiteUrl(),
  // The largest registry documents are about 30 MB unpacked (next); anything bigger is refused.
  fetch: retryOn429(boundedFetch((input, init) => fetch(input, init), 10_000, 40_000_000), 5000),
  syncToken,
  limits: {
    compute: new RateLimit(int(env.COMPUTE_PER_MIN, 30), 60_000),
    refresh: new RateLimit(int(env.REFRESH_PER_MIN, 30), 60_000),
    client: new ClientGate(int(env.CLIENT_NEW_PER_MIN, 10), 2 * 60_000),
    maxRunning: int(env.MAX_RUNNING, 3),
  },
});

const prune = () => {
  const n = store.prune(Date.now());
  console.log(`prune: ${n.badges} badges, ${n.requests} request-log names`);
};
prune();
setInterval(prune, DAY_MS).unref();
setInterval(() => handle.drain(), 5000).unref();

if (!(await handle.warm())) console.warn('catalog: badges/all.json not loaded yet; new names answer "calculating…" until it is');

const server = await startServer(handle, int(env.PORT, 8787));
console.log(`badge service on :${int(env.PORT, 8787)}, db ${path}`);

// Railway sends SIGTERM before replacing the container.
process.on('SIGTERM', () => server.close(() => (store.close(), process.exit(0))));
