import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPackageData, isValidPackageName, searchPackages, trimRegistry } from '../src/core/sources.ts';
import { PackageNotFoundError } from '../src/core/types.ts';

type Route = { status: number; body?: unknown };

// Fake fetch: picks a response by URL prefix and records every requested URL.
function fakeFetch(routes: { downloads?: Route; registry?: Route; versions?: Route; search?: Route }) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const r =
      url.startsWith('https://api.npmjs.org/downloads/') ? routes.downloads
      : url.startsWith('https://api.npmjs.org/versions/') ? routes.versions
      : url.startsWith('https://registry.npmjs.org/-/v1/search') ? routes.search
      : url.startsWith('https://registry.npmjs.org/') ? routes.registry
      : undefined;
    if (!r) throw new Error(`unexpected URL ${url}`);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { impl, urls };
}

const OK = {
  downloads: { status: 200, body: { downloads: [{ day: '2026-01-01', downloads: 5, extra: 1 }] } },
  registry: { status: 200, body: { name: 'x', 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2026-01-01T00:00:00Z' } } },
  versions: { status: 200, body: { package: 'x', downloads: { '1.0.0': 5 } } },
};

for (const [name, encoded] of [
  ['@scope/name', '@scope%2Fname'],
  ['react', 'react'],
]) {
  test(`fetchPackageData encodes "${name}" as "${encoded}" in all three URLs`, async () => {
    const { impl, urls } = fakeFetch(OK);
    await fetchPackageData(name, impl);
    assert.deepEqual(urls.sort(), [
      `https://api.npmjs.org/downloads/range/last-year/${encoded}`,
      `https://api.npmjs.org/versions/${encoded}/last-week`,
      `https://registry.npmjs.org/${encoded}`,
    ]);
  });
}

test('fetchPackageData returns trimmed data from the three endpoints', async () => {
  const data = await fetchPackageData('x', fakeFetch(OK).impl);
  assert.deepEqual(data.downloads, [{ day: '2026-01-01', downloads: 5 }]);
  assert.deepEqual(data.versionsLastWeek, { '1.0.0': 5 });
  assert.equal(data.registry.name, 'x');
});

test('registry 404 throws PackageNotFoundError', async () => {
  const { impl } = fakeFetch({ ...OK, registry: { status: 404 } });
  await assert.rejects(fetchPackageData('x', impl), PackageNotFoundError);
});

test('registry 500 throws a plain Error, not PackageNotFoundError', async () => {
  const { impl } = fakeFetch({ ...OK, registry: { status: 500 } });
  await assert.rejects(fetchPackageData('x', impl), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof PackageNotFoundError));
    return true;
  });
});

test('downloads 404 with registry 200 gives an empty series', async () => {
  const data = await fetchPackageData('x', fakeFetch({ ...OK, downloads: { status: 404 } }).impl);
  assert.deepEqual(data.downloads, []);
});

test('versions 404 with registry 200 gives empty versionsLastWeek', async () => {
  const data = await fetchPackageData('x', fakeFetch({ ...OK, versions: { status: 404 } }).impl);
  assert.deepEqual(data.versionsLastWeek, {});
});

test('trimRegistry keeps only RegistryDoc fields', () => {
  const doc = {
    name: 'x',
    description: 'd',
    license: { type: 'MIT' },
    homepage: 'h',
    repository: { type: 'git', url: 'u' },
    'dist-tags': { latest: '1.0.0' },
    time: { created: 'c' },
    versions: { '1.0.0': { deprecated: 'use y' } },
    readme: 'big',
    maintainers: [{ name: 'a', email: 'a@example.test' }],
  };
  assert.deepEqual(trimRegistry(doc), {
    maintainerCount: 1, // the count only: maintainer emails must not end up in caches or fixtures
    deprecated: 'use y',
    name: 'x',
    description: 'd',
    license: 'MIT',
    homepage: 'h',
    repository: { type: 'git', url: 'u' },
    'dist-tags': { latest: '1.0.0' },
    time: { created: 'c' },
  });
});

test('searchPackages maps objects to name/description/version', async () => {
  const { impl, urls } = fakeFetch({
    search: {
      status: 200,
      body: { objects: [{ package: { name: 'a', description: 'A', version: '1.0.0', links: {} }, score: {} }] },
    },
  });
  assert.deepEqual(await searchPackages('a b', impl), [
    {
      name: 'a',
      description: 'A',
      version: '1.0.0',
      weeklyDownloads: undefined,
      dependents: undefined,
      date: undefined,
      publisher: undefined,
    },
  ]);
  assert.equal(urls[0], 'https://registry.npmjs.org/-/v1/search?text=a%20b&size=10');
});

test('searchPackages throws on a non-OK response', async () => {
  await assert.rejects(searchPackages('a', fakeFetch({ search: { status: 503 } }).impl));
});

for (const name of ['react', '@types/node', 'lodash.debounce', 'a-b_c', 'JSONStream']) {
  test(`isValidPackageName accepts ${JSON.stringify(name)}`, () => assert.equal(isValidPackageName(name), true));
}

for (const name of ['', '../etc', '@scope', '@/x', 'has space', '<script>', 'a'.repeat(215), '.hidden', '_private']) {
  test(`isValidPackageName rejects ${JSON.stringify(name.length > 20 ? name.slice(0, 10) + '...' : name)}`, () =>
    assert.equal(isValidPackageName(name), false));
}
