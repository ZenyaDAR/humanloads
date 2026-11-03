// Page titles and descriptions, shared by the SPA (src/web/main.ts) and the prerender script, so a crawler
// sees the same text in the static HTML and after the app boots.
import type { FeaturedRow } from './types.ts';

export const SITE_NAME = 'humanloads';
export const REPO_URL = 'https://github.com/ZenyaDAR/humanloads';
export const HOME_TITLE = 'humanloads: how many humans use an npm package?';
export const HOME_DESCRIPTION =
  'npm counts every tarball fetch: mirrors, scanners, CI. humanloads estimates the real human installs behind an npm package, with a range and a confidence level.';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function packageTitle(name: string): string {
  return `${name}: real human installs vs npm downloads · ${SITE_NAME}`;
}

// With build-time numbers (summary.json) the description quotes them; without, it stays generic.
export function packageDescription(name: string, r?: Pick<FeaturedRow, 'organicWeekly' | 'low' | 'high' | 'confidence' | 'npmWeekly'>): string {
  return r
    ? `${name}: ~${fmt(r.organicWeekly)} human installs a week (range ${fmt(r.low)}–${fmt(r.high)}, ${r.confidence} confidence) ` +
        `vs ${fmt(r.npmWeekly)} npm downloads. The rest is mirrors, scanners and crawlers.`
    : `How many of ${name}'s npm downloads are real human installs? humanloads separates people from mirrors, scanners and crawlers.`;
}

export function compareTitle(names: string[]): string {
  return `${names.join(' vs ')}: human installs compared · ${SITE_NAME}`;
}

export function compareDescription(names: string[]): string {
  return `${names.join(' vs ')}: npm weekly downloads compared with estimated real human installs, week by week.`;
}
