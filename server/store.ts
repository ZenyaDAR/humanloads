// SQLite storage for the badge service: one file on a Railway volume, so it survives restarts and redeploys.
// Two tables:
//   badges    computed badges for names the nightly catalog doesn't cover yet (short-lived: the build takes over)
//   requests  which badges are actually requested, read by the nightly build (GET /requested)
import { DatabaseSync } from 'node:sqlite';
import type { ShieldsBadge } from '../src/core/types.ts';

export const DAY_MS = 86_400_000;

export interface Stored {
  badge: ShieldsBadge;
  at: number; // ms, when it was computed
}
export interface Requested {
  name: string;
  firstSeen: number;
  lastSeen: number;
  days: number; // distinct UTC days with at least one request
}
export interface Store {
  getBadge(name: string): Stored | null;
  putBadge(name: string, badge: ShieldsBadge, at: number): void;
  // Records a request for the nightly build. A name new to the log counts against the daily cap, and against the
  // client's share of it, unless `free` (catalog names, which an attacker can't invent). Returns false when refused.
  seen(name: string, now: number, opts?: { free?: boolean; client?: string }): boolean;
  requested(since: number): Requested[];
  prune(now: number): { badges: number; requests: number };
  close(): void;
}

export interface StoreOptions {
  newPerDay?: number; // names new to the request log per UTC day, all clients together
  newPerClientDay?: number; // one client's share of that, so nobody can use up the day's cap alone
  keepRequestsMs?: number; // a name not requested for this long leaves the log
}

const BADGE_KEEP_MS = 7 * DAY_MS; // by then the nightly catalog serves it, or it was not requested again
const MISSING_KEEP_MS = DAY_MS; // "not found" rows from name probing go fast

export function openStore(path: string, opts: StoreOptions = {}): Store {
  const newPerDay = opts.newPerDay ?? 200;
  const newPerClientDay = opts.newPerClientDay ?? 20;
  const keepRequestsMs = opts.keepRequestsMs ?? 45 * DAY_MS;
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS badges (name TEXT PRIMARY KEY, badge TEXT NOT NULL, at INTEGER NOT NULL, missing INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS requests (
      name TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, days INTEGER NOT NULL, capped INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_first_seen ON requests (first_seen);
  `);
  const getBadge = db.prepare('SELECT badge, at FROM badges WHERE name = ?');
  const putBadge = db.prepare(
    'INSERT INTO badges (name, badge, at, missing) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET badge = excluded.badge, at = excluded.at, missing = excluded.missing',
  );
  const getReq = db.prepare('SELECT last_seen FROM requests WHERE name = ?');
  const touchReq = db.prepare('UPDATE requests SET last_seen = ?, days = days + 1 WHERE name = ?');
  const addReq = db.prepare('INSERT INTO requests (name, first_seen, last_seen, days, capped) VALUES (?, ?, ?, 1, ?)');
  const newToday = db.prepare('SELECT COUNT(*) AS n FROM requests WHERE capped = 1 AND first_seen >= ?');
  const listReq = db.prepare('SELECT name, first_seen, last_seen, days FROM requests WHERE last_seen >= ? ORDER BY name');
  const pruneBadges = db.prepare('DELETE FROM badges WHERE (missing = 1 AND at < ?) OR at < ?');
  const pruneReqs = db.prepare('DELETE FROM requests WHERE last_seen < ?');

  // At most one write per name per UTC day: the names recorded today, cleared when the day changes. Bounded: only
  // names in the catalog, already in the log, or admitted under today's cap get in.
  // ponytail: in memory, so a restart forgets today's per-client counts; the shared daily cap is in SQLite and holds.
  let recordedDay = -1;
  const recorded = new Set<string>();
  const perClient = new Map<string, number>(); // new names logged today, per client

  return {
    getBadge(name) {
      const row = getBadge.get(name) as { badge: string; at: number } | undefined;
      return row ? { badge: JSON.parse(row.badge) as ShieldsBadge, at: row.at } : null;
    },
    putBadge(name, badge, at) {
      putBadge.run(name, JSON.stringify(badge), at, badge.isError ? 1 : 0);
    },
    seen(name, now, { free = false, client = 'unknown' } = {}) {
      const day = Math.floor(now / DAY_MS);
      if (day !== recordedDay) {
        recordedDay = day;
        recorded.clear();
        perClient.clear();
      }
      if (recorded.has(name)) return true;
      const row = getReq.get(name) as { last_seen: number } | undefined;
      if (row) {
        if (Math.floor(row.last_seen / DAY_MS) !== day) touchReq.run(now, name);
      } else {
        if (!free) {
          const mine = perClient.get(client) ?? 0;
          if (mine >= newPerClientDay || (newToday.get(day * DAY_MS) as { n: number }).n >= newPerDay) return false;
          if (perClient.size < 100_000) perClient.set(client, mine + 1);
        }
        addReq.run(name, now, now, free ? 0 : 1);
      }
      recorded.add(name);
      return true;
    },
    requested(since) {
      return (listReq.all(since) as { name: string; first_seen: number; last_seen: number; days: number }[]).map((r) => ({
        name: r.name, firstSeen: r.first_seen, lastSeen: r.last_seen, days: r.days,
      }));
    },
    prune(now) {
      return {
        badges: Number(pruneBadges.run(now - MISSING_KEEP_MS, now - BADGE_KEEP_MS).changes),
        requests: Number(pruneReqs.run(now - keepRequestsMs).changes),
      };
    },
    close: () => db.close(),
  };
}
