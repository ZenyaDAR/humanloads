// The README badge, shared by the nightly build (public/badges/), the badge service (server/) and the package page.
import type { Confidence, Estimate, ShieldsBadge } from './types.ts';

export const BADGE_LABEL = 'real installs/week';
// Below this the estimate is noise and evidence can't change confidence, so the two evidence calls are skipped.
export const MIN_EVIDENCE_WEEKLY = 10;

export function compactCount(n: number): string {
  const short = (x: number, unit: string) => `${(Math.round(x * 10) / 10).toString()}${unit}`;
  if (n >= 999_950) return short(n / 1e6, 'M');
  if (n >= 1000) return short(n / 1e3, 'k');
  return String(n);
}

const COLORS: Record<Confidence, string> = { high: 'brightgreen', medium: 'yellow', low: 'lightgrey' };

export function badgeFor(row: { organicWeekly: number; confidence: Confidence; tooNew?: boolean }): ShieldsBadge {
  return { schemaVersion: 1, label: BADGE_LABEL, message: row.tooNew ? 'too new' : `≈ ${compactCount(row.organicWeekly)}`, color: COLORS[row.confidence] };
}

export const badgeOf = (e: Estimate): ShieldsBadge => badgeFor({ organicWeekly: e.lastWeek.organic, confidence: e.confidence, tooNew: e.tooNew });

// "@scope/name" -> "scope__name": the flat file name the nightly build writes. Not unique ("a__b" maps there too),
// so lookups go by exact name (badges/index.json, badges/all.json) and the build skips a second name for one file.
export const safeName = (name: string): string => name.replace(/^@/, '').replace('/', '__');

export const needsEvidence = (e: Estimate): boolean => e.lastWeek.organic >= MIN_EVIDENCE_WEEKLY && !e.tooNew;
