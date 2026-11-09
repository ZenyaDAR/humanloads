import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LISTS, LIST_DEFS, LIST_NAMES, categoryRankHtml, listLinksHtml } from '../src/core/lists.ts';
import { roundCount } from '../src/core/html.ts';
import { isValidPackageName } from '../src/core/sources.ts';
import type { FeaturedRow, ListsFile } from '../src/core/types.ts';
import { archiveNames, buildLists, compareHtml, comparePages, curatedToRefresh, guideHtml, llmsTxt, refreshPlan } from '../scripts/data-lib.ts';

const SHELL = '<html><head><title>x</title></head><body><main id="app"></main></body></html>';
const SITE = 'https://example.test/';
const row = (name: string, organicWeekly: number, extra: Partial<FeaturedRow> = {}): FeaturedRow => ({
  name, npmWeekly: organicWeekly * 2, organicWeekly, low: organicWeekly, high: organicWeekly, inflation: 0.5, confidence: 'high', updated: '2026-11-01T00:00:00.000Z', ...extra,
});
const insightsOf = (rows: FeaturedRow[], pairs: string[][] = []): ListsFile => ({ generated: '2026-11-05T00:00:00.000Z', lists: buildLists(rows, pairs) });
const list = (slug: string) => LISTS.find((g) => g.path === `lists/${slug}`)!;

test('list definitions: within search limits, valid names, no slug clashes', () => {
  assert.equal(new Set(LIST_DEFS.map((d) => d.slug)).size, LIST_DEFS.length);
  for (const g of LISTS) {
    assert.ok(g.title.length <= 75, g.title);
    assert.ok(g.description.length >= 25 && g.description.length <= 160, `${g.description.length}: ${g.description}`);
    assert.equal(isValidPackageName(g.path), false, g.path); // a slash without @scope can't be a package name
    const html = guideHtml(SHELL, SITE, g, null);
    assert.equal(html.match(/<h1/g)?.length, 1);
    assert.match(html, /name="robots" content="noindex"/, g.path);
    assert.match(html, new RegExp(`rel="canonical" href="${SITE}${g.path}"`));
  }
  for (const n of LIST_NAMES) assert.ok(isValidPackageName(n), n);
  for (const g of LISTS) assert.doesNotMatch(g.description, /not raw npm/); // these rankings match npm's order at this scale, so don't imply they differ
});

test('compare.json: valid, unique pairs, keeping the order of URLs already published', () => {
  const pairs: string[][] = JSON.parse(readFileSync(new URL('../data/compare.json', import.meta.url), 'utf8'));
  assert.equal(new Set(pairs.map((p) => [...p].sort().join())).size, pairs.length);
  for (const p of pairs) assert.ok(p.length === 2 && p.every(isValidPackageName), p.join());
  // Published before the list grew: a changed order would change their URLs. Google already shows some of them.
  const published = 'react,vue react,svelte vue,svelte next,nuxt express,fastify express,koa express,hono jest,vitest mocha,jest webpack,vite webpack,rollup esbuild,@swc/core eslint,@biomejs/biome moment,dayjs date-fns,dayjs zod,yup zod,valibot axios,node-fetch axios,ky lodash,underscore lodash,ramda chalk,picocolors commander,yargs redux,zustand mobx,zustand prisma,drizzle-orm mongoose,prisma playwright,puppeteer cypress,playwright tailwindcss,bootstrap uuid,nanoid pnpm,yarn';
  assert.equal(pairs.slice(0, 32).map((p) => p.join()).join(' '), published);
});

test('a curated list ranks by real installs, skips what it has no number for, and waits for enough rows', () => {
  const { names } = LIST_DEFS.find((d) => d.slug === 'best-npm-test-frameworks')!;
  const [a, b, c, d, e] = names!;
  const rows = [row(a, 10), row(b, 500), row(c, 40), row(d, 7), row(e, 900, { tooNew: true }), row('unrelated', 99999)];
  const data = buildLists(rows, [[a, b], [a, 'unrelated']])['best-npm-test-frameworks'];
  assert.deepEqual(data.rows.map((r) => r.name), [b, c, a, d]);
  assert.deepEqual(data.pairs, [[a, b]]);
  const g = list('best-npm-test-frameworks');
  assert.equal(g.ready!(insightsOf(rows)), false); // 4 of 7
  const enough = names!.map((n, i) => row(n, 100 - i));
  assert.equal(g.ready!(insightsOf(enough)), true);
  assert.doesNotMatch(guideHtml(SHELL, SITE, g, insightsOf(enough)), /noindex/);
});

test('category rank: the same order as the list page, only for ready lists, never the package\'s own number', () => {
  const { names } = LIST_DEFS.find((d) => d.slug === 'best-npm-test-frameworks')!;
  const rows = names!.map((n, i) => row(n, 1_234_567 - i * 100_000));
  const file = insightsOf(rows);
  const order = file.lists['best-npm-test-frameworks'].rows.map((r) => r.name);
  const self = order[2];
  const html = categoryRankHtml(self, file, '/');
  assert.match(html, new RegExp(`<strong>3rd of ${order.length}</strong>`));
  assert.match(html, new RegExp(`behind ${order[1]}[^]*ahead of ${order[3]}`));
  assert.match(html, /href="\/lists\/best-npm-test-frameworks"/);
  const own = rows.find((r) => r.name === self)!;
  assert.doesNotMatch(html, new RegExp(roundCount(own.organicWeekly).replace('.', '\\.')));
  assert.doesNotMatch(html, new RegExp(own.npmWeekly.toLocaleString('en-US')));
  // First place: one-sided sentence, and the table still shows a full window of rows.
  const top = categoryRankHtml(order[0], file, '/');
  assert.match(top, /<strong>1st of/);
  assert.doesNotMatch(top, /behind/);
  assert.equal(top.match(/<tr[ >]/g)!.length - 1, Math.min(5, order.length)); // minus the header row
  // Labels keep their case: "CSS", "HTTP", "Node.js" must not come out lowercased.
  const css = LIST_DEFS.find((d) => d.slug === 'best-css-frameworks')!;
  const cssHtml = categoryRankHtml(css.names![0], insightsOf(css.names!.map((n, i) => row(n, 1000 - i))), '/');
  assert.match(cssHtml, new RegExp(`>${css.label}</a> ranking`));
  // Not ready (too few rows fetched), not in any list, no file: nothing.
  assert.equal(categoryRankHtml(self, insightsOf(rows.slice(0, 3)), '/'), '');
  assert.equal(categoryRankHtml('unrelated', file, '/'), '');
  assert.equal(categoryRankHtml(self, null, '/'), '');
});

test('a list page escapes what maintainers wrote and links packages and comparisons', () => {
  const { names } = LIST_DEFS.find((d) => d.slug === 'best-npm-test-frameworks')!;
  const rows = names!.map((n, i) => row(n, 100_000 - i, i === 0 ? { description: '<img src=x onerror=y>', facts: { deprecated: 'old' } as FeaturedRow['facts'] } : {}));
  const html = guideHtml(SHELL, SITE, list('best-npm-test-frameworks'), insightsOf(rows, [[names![0], names![1]]]));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, new RegExp(`href="/${names![1]}"`));
  assert.match(html, new RegExp(`href="/compare/${names![0]},${names![1]}"`));
  assert.match(html, /pill-low">deprecated/);
  assert.match(html, new RegExp(`<strong>${names![0]}</strong> leads with about`));
  assert.match(html, /Nov 1, 2026/);
});

test('a list over the whole catalog: by npm count, without @types stubs and too-new names, with the rows capped', () => {
  const rows = [row('@types/node', 1e9), row('fresh', 1e8, { tooNew: true }), ...Array.from({ length: 1000 }, (_, i) => row(`p${i}`, 1000 + i))];
  const data = buildLists(rows);
  const top = data['most-downloaded-npm-packages'];
  assert.equal(top.rows.length, 50);
  assert.equal(top.rows[0].name, 'p999');
  assert.deepEqual(top.pairs, []);
  assert.equal(list('most-downloaded-npm-packages').ready!(insightsOf(rows)), true);
  // Too small a catalog misses the real top: the page shows what there is and says so, out of indexes.
  const small = guideHtml(SHELL, SITE, list('most-downloaded-npm-packages'), insightsOf(rows.slice(0, 200)));
  assert.match(small, /name="robots" content="noindex"/);
  assert.match(small, /among the 200 packages we track, not all of npm\. @types stubs/);
  assert.match(llmsTxt(SITE, [], undefined, [], [list('most-downloaded-npm-packages')]), /## Ranked lists\n\n- \[Most downloaded npm packages\]\(https:\/\/example.test\/lists\/most-downloaded-npm-packages\)/);
});

test('home links reach every list', () => {
  const links = listLinksHtml('/sub/');
  for (const g of LISTS) assert.ok(links.includes(`href="/sub/${g.path}"`), g.path);
});

test('curatedToRefresh: names with no row first, then the stalest; every name gets its turn', () => {
  const at = (n: string, day: number) => row(n, 1, { updated: `2026-11-0${day}T00:00:00.000Z` });
  const previous = Object.fromEntries([at('new', 3), at('old', 1), at('mid', 2)].map((r) => [r.name, r]));
  assert.deepEqual(curatedToRefresh(['new', 'old', 'mid', 'missing', 'constructor', 'missing'], previous, 3), ['missing', 'constructor', 'old']);
  const rows: Record<string, FeaturedRow> = {};
  const nights: string[][] = [];
  for (let night = 1; night <= 4; night++) {
    const plan = curatedToRefresh(['a', 'b', 'c', 'd', 'e', 'f'], rows, 2);
    nights.push(plan);
    for (const n of plan) rows[n] = at(n, night);
  }
  assert.deepEqual(nights, [['a', 'b'], ['c', 'd'], ['e', 'f'], ['a', 'b']]); // wraps around to the stalest
});

test('curatedToRefresh: names with no row may exceed the nightly share, up to their own limit', () => {
  const names = Array.from({ length: 10 }, (_, i) => `n${i}`);
  assert.equal(curatedToRefresh(names, {}, 3, 8).length, 8);
  const someRows = Object.fromEntries(names.slice(0, 8).map((n) => [n, row(n, 1)]));
  assert.equal(curatedToRefresh(names, someRows, 3, 8).length, 3); // two missing: the usual share is enough
});

test('the nightly budget: curated names leave room for new ones, and a model change is worked off first', () => {
  const curated = Array.from({ length: 200 }, (_, i) => `c${i}`);
  const previous = Object.fromEntries(curated.map((n) => [n, row(n, 1)]));
  const plan = refreshPlan(curatedToRefresh(curated, previous, 60, 150), ['new1', 'new2'], previous, 150);
  assert.equal(plan.length, 150);
  assert.ok(plan.includes('new1') && plan.includes('new2'));
  // After a model change: nothing has a row, and everything is pending. All of the budget goes to pending names.
  const pending = Array.from({ length: 500 }, (_, i) => `p${i}`);
  const bump = refreshPlan(['must'], ['new1'], {}, 150, pending);
  assert.equal(bump.length, 150);
  assert.equal(bump.filter((n) => n.startsWith('p')).length, 149);
});

test('comparePages: only pairs with numbers are linked; pending and archived names keep the page; unknown names get none', () => {
  const all = [['a', 'b'], ['a', 'wait'], ['a', 'gone'], ['a', 'never'], ['constructor', 'a']];
  const { pairs, pages } = comparePages(all, { a: 1, b: 1 }, ['wait', 'gone']);
  assert.deepEqual(pairs, [['a', 'b']]);
  assert.deepEqual(pages, [['a', 'b'], ['a', 'wait'], ['a', 'gone']]);
});

test('archiveNames: dropped rows stay as pages, unpublished ones and live ones do not, the oldest go past the cap', () => {
  assert.deepEqual(archiveNames(['old', 'live', 'gone', 'wait', 'old', 'dropped'], new Set(['live', 'wait']), new Set(['gone'])), ['old', 'dropped']);
  assert.deepEqual(archiveNames(['a', 'b', 'c'], new Set(), new Set(), 2), ['b', 'c']);
});

test('compareHtml: a page without numbers keeps working but stays out of indexes', () => {
  assert.match(compareHtml(SHELL, ['a', 'b'], [row('a', 5), undefined], SITE), /name="robots" content="noindex"/);
  assert.doesNotMatch(compareHtml(SHELL, ['a', 'b'], [row('a', 5), row('b', 7)], SITE), /noindex/);
});
