import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchEvidence, parseGithubRepo, searchPackages } from '../src/core/sources.ts';
import type { RegistryDoc } from '../src/core/types.ts';

// Fake fetch routed by a handler; returning a number gives an empty response with that status,
// returning 'throw' simulates a network error, anything else is sent as a 200 JSON body.
type Handler = (url: string) => unknown;
function fakeFetch(handler: Handler) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const r = handler(url);
    if (r === 'throw') throw new TypeError('network down');
    if (typeof r === 'number') return new Response(null, { status: r });
    return new Response(JSON.stringify(r), { status: 200 });
  }) as typeof fetch;
  return { impl, urls };
}

const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search';
const NPMS = 'https://api.npms.io/v2/search/suggestions';
const POINT = 'https://api.npmjs.org/downloads/point/last-week/';

const npmHit = (name: string, weekly?: number, extra: Record<string, unknown> = {}) => ({
  package: { name, version: '9.9.9', description: `${name} desc`, ...extra },
  downloads: weekly === undefined ? undefined : { weekly },
});
const npmsHit = (name: string) => ({
  package: { name, version: '1.0.0-stale', description: `${name} (npms)`, publisher: { username: 'p', email: 'p@npms.example' } },
});

// Routes for searchPackages: npm search, npms suggestions, then point downloads (bulk and per scoped name).
function searchRoutes(opts: {
  npm: unknown[];
  npms?: unknown[] | number | 'throw';
  points?: Record<string, unknown>; // keyed by the path after /last-week/
}): Handler {
  return (url) => {
    if (url.startsWith(NPM_SEARCH)) return { objects: opts.npm };
    if (url.startsWith(NPMS)) return opts.npms ?? [];
    if (url.startsWith(POINT)) return opts.points?.[url.slice(POINT.length)] ?? 404;
    throw new Error(`unexpected URL ${url}`);
  };
}

test('search: npms suggestions are merged after npm hits with version ""', async () => {
  const { impl } = fakeFetch(searchRoutes({ npm: [npmHit('zzz-npm')], npms: [npmsHit('other')] }));
  const hits = await searchPackages('q', impl);
  assert.deepEqual(hits.map((h) => h.name), ['zzz-npm', 'other']);
  assert.equal(hits[1].version, '');
  assert.equal(hits[1].description, 'other (npms)');
});

test('search: a name in both sources appears once with the npm version', async () => {
  const { impl } = fakeFetch(searchRoutes({ npm: [npmHit('dup')], npms: [npmsHit('dup')] }));
  const hits = await searchPackages('q', impl);
  assert.deepEqual(hits.map((h) => [h.name, h.version]), [['dup', '9.9.9']]);
});

test('search: exact match first, then prefix matches by weekly downloads, then the rest in npm order', async () => {
  const { impl } = fakeFetch(
    searchRoutes({
      npm: [npmHit('@react-pdf/x', 5000), npmHit('react-router', 100), npmHit('other-b', 1), npmHit('react-ro', 1), npmHit('other-a', 9)],
      npms: [npmsHit('react-rockets')],
      points: { 'react-rockets': { package: 'react-rockets', downloads: 500 } },
    }),
  );
  assert.deepEqual(
    (await searchPackages('React-Ro ', impl)).map((h) => h.name),
    ['react-ro', 'react-rockets', 'react-router', '@react-pdf/x', 'other-b', 'other-a'],
  );
});

test('search: results are capped at 10', async () => {
  const npm = Array.from({ length: 10 }, (_, i) => npmHit(`n${i}`));
  const { impl } = fakeFetch(searchRoutes({ npm, npms: [npmsHit('extra1'), npmsHit('extra2')] }));
  assert.equal((await searchPackages('q', impl)).length, 10);
});

for (const failure of [500, 'throw'] as const) {
  test(`search: npms failure (${failure}) is ignored`, async () => {
    const { impl } = fakeFetch(searchRoutes({ npm: [npmHit('a', 3)], npms: failure }));
    const hits = await searchPackages('q', impl);
    assert.deepEqual(hits.map((h) => h.name), ['a']);
  });
}

test('search: npm search failure still throws', async () => {
  const { impl } = fakeFetch((url) => (url.startsWith(NPM_SEARCH) ? 503 : []));
  await assert.rejects(searchPackages('q', impl));
});

test('search: added names get counts from one bulk call (unscoped) and one call per scoped name', async () => {
  const { impl, urls } = fakeFetch(
    searchRoutes({
      npm: [],
      npms: [npmsHit('a'), npmsHit('b'), npmsHit('@s/c')],
      points: {
        'a,b': { a: { package: 'a', downloads: 10 }, b: { package: 'b', downloads: 20 } },
        '@s%2Fc': { package: '@s/c', downloads: 30 },
      },
    }),
  );
  const hits = await searchPackages('zzz', impl);
  assert.deepEqual(
    Object.fromEntries(hits.map((h) => [h.name, h.weeklyDownloads])),
    { a: 10, b: 20, '@s/c': 30 },
  );
  assert.deepEqual(urls.filter((u) => u.startsWith(POINT)).sort(), [POINT + '@s%2Fc', POINT + 'a,b']);
});

test('search: only the first 3 scoped added names get a per-name count call', async () => {
  const scoped = ['@s/a', '@s/b', '@s/c', '@s/d', '@s/e'];
  const points = Object.fromEntries(scoped.map((n) => [n.replace('/', '%2F'), { package: n, downloads: 1 }]));
  const { impl, urls } = fakeFetch(searchRoutes({ npm: [], npms: scoped.map(npmsHit), points }));
  const hits = await searchPackages('zzz', impl);
  assert.deepEqual(urls.filter((u) => u.startsWith(POINT)).sort(), ['@s%2Fa', '@s%2Fb', '@s%2Fc'].map((p) => POINT + p));
  assert.deepEqual(
    Object.fromEntries(hits.map((h) => [h.name, h.weeklyDownloads])),
    { '@s/a': 1, '@s/b': 1, '@s/c': 1, '@s/d': undefined, '@s/e': undefined },
  );
});

test('search: a single unscoped added name reads the bulk answer as that package object', async () => {
  const { impl } = fakeFetch(searchRoutes({ npm: [], npms: [npmsHit('solo')], points: { solo: { package: 'solo', downloads: 7 } } }));
  assert.equal((await searchPackages('zzz', impl))[0].weeklyDownloads, 7);
});

test('search: failed count calls leave weeklyDownloads undefined', async () => {
  const { impl } = fakeFetch(searchRoutes({ npm: [], npms: [npmsHit('a'), npmsHit('@s/c')] }));
  const hits = await searchPackages('zzz', impl);
  assert.deepEqual(hits.map((h) => h.weeklyDownloads), [undefined, undefined]);
});

test('search: npm fields are parsed (string dependents) and emails never leak', async () => {
  const hit = {
    ...npmHit('a', 42, { date: '2026-10-01T00:00:00Z', publisher: { username: 'alice', email: 'alice@npm.example' } }),
    dependents: '17',
  };
  const { impl } = fakeFetch(searchRoutes({ npm: [hit], npms: [npmsHit('b')] }));
  const hits = await searchPackages('zzz', impl);
  assert.equal(hits[0].dependents, 17);
  assert.equal(hits[0].weeklyDownloads, 42);
  assert.equal(hits[0].publisher, 'alice');
  assert.equal(hits[0].date, '2026-10-01T00:00:00Z');
  assert.doesNotMatch(JSON.stringify(hits), /@npm\.example|@npms\.example/);
});

// --- Evidence ---

const reg = (repository?: RegistryDoc['repository']): RegistryDoc => ({ name: 'x', 'dist-tags': {}, time: {}, repository });

type Source = 'eco' | 'deps' | 'cdn' | 'gh';
const sourceOf = (url: string): Source => {
  if (url.includes('/dependent_packages')) return 'deps';
  if (url.startsWith('https://packages.ecosyste.ms/')) return 'eco';
  if (url.startsWith('https://data.jsdelivr.com/')) return 'cdn';
  if (url.startsWith('https://api.github.com/')) return 'gh';
  throw new Error(`unexpected URL ${url}`);
};
const GOOD: Record<Source, unknown> = {
  eco: { dependent_packages_count: 12, dependent_repos_count: '34' },
  deps: [{ name: 'big', downloads: 99 }, { nope: true }],
  cdn: { hits: { total: 5000 } },
  gh: { full_name: 'o/r', stargazers_count: 7, forks_count: 2, open_issues_count: 1, pushed_at: '2026-10-01T00:00:00Z' },
};
const evidenceFetch = (override: Partial<Record<Source, unknown>> = {}) =>
  fakeFetch((url) => {
    const s = sourceOf(url);
    return s in override ? override[s] : GOOD[s];
  });

test('evidence: all sources mapped', async () => {
  const ev = await fetchEvidence('x', reg('github:o/r'), evidenceFetch().impl);
  assert.equal(ev.dependentPackages, 12);
  assert.equal(ev.dependentRepos, 34);
  assert.deepEqual(ev.topDependents, [{ name: 'big', downloads: 99 }]);
  assert.equal(ev.cdnHitsMonth, 5000);
  assert.deepEqual(ev.github, { repo: 'o/r', stars: 7, forks: 2, openIssues: 1, pushedAt: '2026-10-01T00:00:00Z' });
});

const failures: [Source, unknown][] = [
  ['eco', 500],
  ['deps', 'throw'],
  ['cdn', 429],
  ['gh', 403],
  ['gh', { message: 'API rate limit exceeded' }],
];
for (const [source, failure] of failures) {
  test(`evidence: ${source} failing with ${JSON.stringify(failure)} nulls only that source`, async () => {
    const ev = await fetchEvidence('x', reg('github:o/r'), evidenceFetch({ [source]: failure }).impl);
    assert.equal(ev.dependentPackages, source === 'eco' ? null : 12);
    assert.equal(ev.dependentRepos, source === 'eco' ? null : 34);
    assert.equal(ev.topDependents.length, source === 'deps' ? 0 : 1);
    assert.equal(ev.cdnHitsMonth, source === 'cdn' ? null : 5000);
    assert.equal(ev.github === null, source === 'gh');
  });
}

test('evidence: never rejects when every request fails', async () => {
  const ev = await fetchEvidence('x', reg('github:o/r'), fakeFetch(() => 'throw').impl);
  assert.deepEqual({ ...ev, codeSearchUrl: '' }, {
    dependentPackages: null,
    dependentRepos: null,
    topDependents: [],
    cdnHitsMonth: null,
    github: null,
    codeSearchUrl: '',
  });
  assert.match(ev.codeSearchUrl, /^https:\/\/github\.com\/search\?type=code&q=/);
});

test('evidence: scoped name is %2F for ecosyste.ms and a raw slash for jsDelivr', async () => {
  const { impl, urls } = evidenceFetch();
  await fetchEvidence('@scope/pkg', reg(), impl);
  const eco = urls.filter((u) => u.startsWith('https://packages.ecosyste.ms/'));
  assert.equal(eco.length, 2);
  for (const u of eco) assert.ok(u.includes('/packages/@scope%2Fpkg'), u);
  assert.deepEqual(
    urls.filter((u) => u.startsWith('https://data.jsdelivr.com/')),
    ['https://data.jsdelivr.com/v1/stats/packages/npm/@scope/pkg?period=month'],
  );
});

test('evidence: no GitHub request without a GitHub repository', async () => {
  const { impl, urls } = evidenceFetch();
  const ev = await fetchEvidence('x', reg('https://gitlab.com/o/r'), impl);
  assert.equal(ev.github, null);
  assert.ok(!urls.some((u) => u.startsWith('https://api.github.com/')));
});

test('evidence: code search URL looks for the quoted name in package.json', async () => {
  const ev = await fetchEvidence('zod', reg(), evidenceFetch().impl);
  assert.equal(decodeURIComponent(ev.codeSearchUrl.split('q=')[1]), '"\\"zod\\"" path:package.json');
});

const repos: [RegistryDoc['repository'], string | null][] = [
  ['git+https://github.com/o/r.git', 'o/r'],
  ['git://github.com/o/r.git', 'o/r'],
  ['git+ssh://git@github.com/o/r.git', 'o/r'],
  ['git@github.com:o/r.git', 'o/r'],
  ['github:o/r', 'o/r'],
  ['o/r', 'o/r'],
  ['https://github.com/o/r/tree/main/packages/x', 'o/r'],
  [{ type: 'git', url: 'https://github.com/my.org/my-repo.js' }, 'my.org/my-repo.js'],
  ['  https://GitHub.com/O/R  ', 'O/R'],
  ['https://gitlab.com/o/r', null],
  ['gitlab:o/r', null],
  ['bitbucket:o/r', null],
  ['', null],
  [undefined, null],
  [{ type: 'git' }, null],
  // Untrusted registry data: a non-string url must not throw.
  [{ type: 'git', url: 5 } as unknown as RegistryDoc['repository'], null],
  [5 as unknown as RegistryDoc['repository'], null],
];
for (const [input, expected] of repos) {
  test(`parseGithubRepo(${JSON.stringify(input)}) -> ${expected}`, () => assert.equal(parseGithubRepo(input), expected));
}
