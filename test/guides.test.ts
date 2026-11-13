import assert from 'node:assert/strict';
import test from 'node:test';
import { guideHtml, methodologyHtml } from '../scripts/data-lib.ts';
import { DEPRECATED_GUIDE_PATH, GUIDES } from '../src/core/guides.ts';
import { METHODOLOGY_PATH } from '../src/core/methodology.ts';
import type { FeaturedRow, InsightsFile } from '../src/core/types.ts';

const SHELL = '<!doctype html><html><head><title>x</title></head><body><div id="app"></div></body></html>';
const SITE = 'https://example.test/';
const guide = (path: string) => GUIDES.find((g) => g.path === path)!;
const row = (name: string, npm: number, organic: number, extra: Partial<FeaturedRow> = {}): FeaturedRow => ({
  name, npmWeekly: npm, organicWeekly: organic, low: organic * 0.9, high: organic * 1.1, inflation: 1 - organic / npm, confidence: 'medium', ...extra,
});

test('guide titles stay within 70 characters, the limit seo.ts uses for every other title', () => {
  for (const g of GUIDES) assert.ok(g.title.length <= 70, `${g.title.length}: ${g.title}`);
});

test('article pages: meta line, tl;dr, a TOC that matches the headings, a rail without the page itself, one h1', () => {
  const pages = [...GUIDES.map((g) => [g.path, guideHtml(SHELL, SITE, g)]), [METHODOLOGY_PATH, methodologyHtml(SHELL, SITE)]];
  for (const [path, html] of pages) {
    assert.equal(html.match(/<h1/g)?.length, 1, path);
    assert.match(html, /<p class="num doc-meta">humanloads · \d+ min read<\/p>/, path); // no date without data
    assert.equal(html.match(/<aside class="tldr"[\s\S]*?<\/aside>/)![0].match(/<li>/g)?.length, 3, path);
    const tocIds = [...html.matchAll(/<nav class="doc-toc"[\s\S]*?<\/nav>/g)][0][0].match(/href="#([^"]+)"/g)!.map((h) => h.slice(7, -1));
    const h2Ids = [...html.matchAll(/<h2 class="section-title" id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tocIds, h2Ids, path);
    assert.equal(new Set(h2Ids).size, h2Ids.length, path);
    const rail = html.match(/<aside class="doc-rail"[\s\S]*?<\/aside>/)![0];
    assert.doesNotMatch(rail, new RegExp(`href="/${path}"`), path);
    assert.match(rail, /(Guide|Methodology) · \d+ min/);
    // The closing search is an inert stand-in until the SPA swaps it.
    assert.match(html, /<div class="art-search"><form class="search search-home" inert aria-hidden="true">/, path);
    assert.doesNotMatch(html.replace(/human<span[^>]*>loads|humanloads|class="[^"]*"/g, ''), /\bhumans?\b/i, path);
  }
});

test('"Mentioned in this article" only with real numbers, and never for a package too new to tell', () => {
  const g = guide('docs/npm-download-count');
  assert.doesNotMatch(guideHtml(SHELL, SITE, g), /Mentioned in this article/);
  const html = guideHtml(SHELL, SITE, g, null, { zod: row('zod', 12_300, 2_000), jest: row('jest', 500, 0, { tooNew: true }) });
  assert.match(html, /Mentioned in this article/);
  assert.match(html, /<span class="num rc-npm struck"><span class="sr-only">npm says <\/span>12.3K<\/span>/);
  assert.match(html, /<mark>≈ 1.8K–2.2K<\/mark>/);
  assert.match(html, /class="noise-bar noise-bar-rail"/);
  assert.doesNotMatch(html, /href="\/jest">/);
});

test('data-built guides show the date of their data, the figure is the same on every render', () => {
  const ins: InsightsFile = {
    generated: '2026-11-10T18:50:21Z', market: { growth11m: null, packages: 0 },
    deprecated: Array.from({ length: 10 }, (_, i) => ({ name: `old-${i}`, npmWeekly: 1000, message: 'gone', lastRelease: '2020-01-01' })),
    chains: {},
  };
  assert.match(guideHtml(SHELL, SITE, guide(DEPRECATED_GUIDE_PATH), ins), /humanloads · updated Nov 10, 2026 · \d+ min read/);
  const real = guide('docs/are-npm-downloads-real');
  const a = guideHtml(SHELL, SITE, real);
  assert.equal(a, guideHtml(SHELL, SITE, real));
  assert.match(a, /Illustration of the typical shape, not a specific package\./);
  assert.match(a, /<blockquote class="pull-quote hand" aria-hidden="true">/);
});
