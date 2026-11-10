// Shared contract between src/core (model + data fetching) and src/web (UI).
// Only erasable TS syntax: this file must run under Node's type stripping.
import type { PackageFacts } from './insights.ts';

export interface DailyDownloads {
  day: string; // YYYY-MM-DD (UTC)
  downloads: number;
}

// Subset of https://registry.npmjs.org/<pkg> that the model and UI use.
export interface RegistryDoc {
  name: string;
  description?: string;
  license?: string;
  homepage?: string;
  repository?: { type?: string; url?: string } | string;
  'dist-tags': { latest?: string; [tag: string]: string | undefined };
  time: Record<string, unknown>; // version -> ISO date, plus "created" / "modified"; unpublished docs hold objects
  maintainerCount?: number; // just the count: the registry's list also carries email addresses
  deprecated?: string; // the latest version's deprecation message
  maintenanceNote?: string; // the README's own sentence saying the project is in maintenance mode or unmaintained
}

export interface RawPackageData {
  name: string;
  downloads: DailyDownloads[]; // oldest first, ~365 days, from api.npmjs.org range
  registry: RegistryDoc;
  versionsLastWeek: Record<string, number>; // api.npmjs.org/versions/<pkg>/last-week -> .downloads
  pulls?: Record<string, DependencyPull>; // required dependencies with enough downloads behind them; used by the nightly build
}

// How many of last week's downloads of a package came on versions that require a given dependency.
export interface DependencyPull {
  weekly: number; // all versions requiring it, whatever the range
  range: string; // the most downloaded range
  rangeWeekly: number; // downloads of the versions asking for that range
}

export interface Publish {
  day: string; // YYYY-MM-DD
  versions: string[];
}

export interface DailyEstimate {
  day: string;
  npm: number; // raw npm count
  cleaned: number; // after removing publish spikes (step A)
  organic: number; // point estimate of real installs: what is left after mirror spikes and the crawler floor
  low: number;
  high: number;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface VersionRow {
  version: string;
  downloads: number; // last 7 days
  aboveFloor: number; // max(0, downloads - floor) with the point floor
}

export interface Estimate {
  model: string;
  tooNew: boolean; // under two weeks since the first publish: noise and first users can't be told apart
  daily: DailyEstimate[]; // same days as input, oldest first
  publishes: Publish[];
  lastWeek: { npm: number; organic: number; low: number; high: number }; // last 7 days of the series
  breakdown: {
    mirrorsTotal: number; // downloads removed as publish spikes over the whole series
    crawlerFloorPerVersion: number | null; // weekly floor f, null when not estimable
    crawlersWeekly: number;
    organicWeekly: number;
  };
  versions: VersionRow[]; // sorted by semver-ish publish time, newest first
  confidence: Confidence;
  notes: string[]; // short human-readable reasons behind the numbers and confidence (English)
  signals?: Signals; // stage 3
}

// ---- Stage 2-4 additions (additive; existing shapes above stay as they are) ----

// Search suggestion: everything comes from one registry search call (no extra requests per hit).
export interface SearchHit {
  name: string;
  description?: string;
  version: string;
  weeklyDownloads?: number; // npm raw, from search result "downloads.weekly"
  dependents?: number; // search result "dependents" (string in the API, parsed)
  date?: string; // ISO date of the latest publish
  publisher?: string; // npm username only, never the email
}

// Independent evidence of use (stage 2). Each source may fail on its own -> null, never throws as a whole.
export interface Evidence {
  dependentPackages: number | null; // packages.ecosyste.ms
  dependentRepos: number | null; // packages.ecosyste.ms
  topDependents: { name: string; downloads?: number }[]; // a few biggest dependents, may be empty
  cdnHitsMonth: number | null; // data.jsdelivr.com, last month
  github: { repo: string; stars: number; forks: number; openIssues: number; pushedAt: string } | null;
  codeSearchUrl: string; // github.com code search link for the package in package.json files
}

// Measured from the canary package (stage 3), published as public/data/calibration.json at build time.
export interface Calibration {
  floorPerVersion: number; // weekly crawler downloads per version of a package nobody uses
  updated: string; // ISO date
  source: string; // canary package name
}

export interface EstimateOptions {
  calibration?: Calibration; // replaces GLOBAL_FLOOR_PER_VERSION when the floor is not measurable
  evidence?: Evidence; // raises confidence when real dependents / CDN use exist
}

// Weekday rhythm signal (stage 3): humans work on weekdays, bots don't care.
export interface Signals {
  weekdayRatio: number | null; // mean weekday / mean weekend of cleaned series over the last 8 weeks, null if too little data
}

// Homepage featured cards, precomputed at build time -> public/data/featured.json
export interface FeaturedRow {
  name: string;
  description?: string;
  npmWeekly: number;
  organicWeekly: number;
  low: number;
  high: number;
  inflation: number; // noise share: 1 - organicWeekly / npmWeekly, 0..1
  confidence: Confidence;
  tooNew?: boolean; // see Estimate.tooNew
  updated?: string; // ISO date of the build that fetched this row; rows are refreshed in rotation
  facts?: PackageFacts;
  pulls?: Record<string, DependencyPull>;
}

// One step of a dependency trail: this version's weekly downloads line up with the next package, which requires it.
export interface ChainStep {
  name: string;
  version?: string; // its most used version; the last step of a trail may not have a clear one
  weekly: number; // npm's count, all versions
}

export interface DeprecatedRow {
  name: string;
  npmWeekly: number;
  message: string; // the maintainers' words
  lastRelease?: string; // YYYY-MM-DD
}

export interface MarketGrowth {
  growth11m: number | null; // median across the catalog
  packages: number;
}

// One row of a ranked list page (src/core/lists.ts).
export interface ListRow {
  name: string;
  description?: string;
  npmWeekly: number;
  organicWeekly: number;
  low: number;
  high: number;
  confidence: Confidence;
  deprecated?: boolean;
  lastRelease?: string; // YYYY-MM-DD
  updated?: string; // ISO date of the build that fetched this row
}

export interface ListData {
  rows: ListRow[]; // best first
  pairs: string[][]; // comparison pages between packages of this list
  catalog?: number; // lists over the whole catalog: how many packages it held
}

// Derived from the catalog each night -> public/data/insights.json, for package pages and guides.
export interface InsightsFile {
  generated: string;
  market: MarketGrowth;
  deprecated: DeprecatedRow[];
  chains: Record<string, ChainStep[]>;
}

// Rows for the list pages -> public/data/lists.json, apart from insights.json because only those pages need them.
export interface ListsFile {
  generated: string;
  lists: Record<string, ListData>; // by list slug
}
export interface FeaturedFile {
  generated: string; // ISO date
  examples: string[]; // well-known names for the "try one" links
  popular: string[]; // biggest packages in the catalog, as plain links
  noisiest: FeaturedRow[]; // most noise in npm's count, among packages not in a release window
}

// shields.io endpoint badge -> public/badges/<safe-name>.json
export interface ShieldsBadge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  isError?: boolean; // shields draws it as an error and won't let a viewer override the color
  cacheSeconds?: number; // how long shields keeps it; values below shields' own minimum are ignored
}

export class PackageNotFoundError extends Error {
  constructor(name: string) {
    super(`Package not found: ${name}`);
    this.name = 'PackageNotFoundError';
  }
}
