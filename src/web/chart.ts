import type { Estimate } from '../core/types.ts';
import { fmt, fmtShort } from './util.ts';

const NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Week {
  start: string;
  npm: number;
  organic: number;
  low: number;
  high: number;
  mirrors: number; // fetches removed as publish spikes this week
  versions: string[];
}

// Daily is too noisy to read: sum into 7-day buckets, aligned to the last day so the newest week is complete.
function toWeeks(est: Estimate): Week[] {
  const pub = new Map(est.publishes.map((p) => [p.day, p.versions]));
  const days = est.daily.slice(-365);
  const weeks: Week[] = [];
  for (let end = days.length; end >= 7; end -= 7) {
    const w: Week = { start: days[end - 7].day, npm: 0, organic: 0, low: 0, high: 0, mirrors: 0, versions: [] };
    for (const d of days.slice(end - 7, end)) {
      w.npm += d.npm;
      w.organic += d.organic;
      w.low += d.low;
      w.high += d.high;
      w.mirrors += Math.max(0, d.npm - d.cleaned);
      w.versions.push(...(pub.get(d.day) ?? []));
    }
    weeks.unshift(w);
  }
  return weeks;
}

// Y ticks on a square-root scale: fractions 1/16, 1/4, 9/16, 1 land evenly spaced, rounded to readable numbers.
function ticks(max: number): number[] {
  const nice = (v: number) => {
    const p = 10 ** Math.floor(Math.log10(v));
    return Math.round(v / p) * p;
  };
  const out = [0.0625, 0.25, 0.5625, 1].map((f) => (max * f >= 1 ? nice(max * f) : 0)).filter((v) => v > 0 && v <= max);
  return [...new Set(out)];
}

// Seeded, so the hand wobble is the same on every redraw.
function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function text(x: number, y: number, value: string, cls: string, anchor = 'middle'): SVGTextElement {
  const t = el('text', { x, y, 'text-anchor': anchor, class: cls });
  t.textContent = value; // version strings are third-party: textContent only
  return t;
}

// A line through the points with a small seeded wobble: drawn by hand, but steady.
const wobbly = (pts: [number, number][], r: () => number, j: number) =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(x + (r() - 0.5) * j).toFixed(1)} ${(y + (r() - 0.5) * j).toFixed(1)}`).join(' ');

function versionLabel(w: Week): string {
  // A stable release names the week better than a canary published next to it; long names are clipped.
  const v = w.versions.filter((x) => !x.includes('-')).at(-1) ?? w.versions[w.versions.length - 1];
  const full = /^\d/.test(v) ? `v${v}` : v;
  const name = full.length > 16 ? `${full.slice(0, 15)}…` : full;
  return w.versions.length > 1 ? `${name} +${w.versions.length - 1}` : name;
}

// One line per package. A single series gets the full treatment (range band, release notes);
// several series (compare page) get one solid line each plus a faint dashed npm line.
export interface Series {
  est: Estimate;
  label: string; // package name, for the text alternative
  color: string; // CSS custom property name, read at draw time so theme changes apply
}

function draw(all: Week[][], colors: string[], width: number, animate: boolean): SVGSVGElement {
  const css = getComputedStyle(document.documentElement);
  const color = (name: string) => css.getPropertyValue(name).trim();
  const single = all.length === 1;
  const weeks = all[0];
  const narrow = width < 480;
  const H = Math.round(Math.min(320, Math.max(220, width * 0.42)));
  const m = { t: single ? 46 : 18, r: 10, b: 28, l: narrow ? 38 : 48 };
  const iw = width - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = Math.max(1, ...all.flat().map((w) => Math.max(w.npm, w.high)));
  // ponytail: sqrt scale so a 2/week filtered line stays visible next to 500-fetch mirror spikes; ticks keep it honest.
  const y = (v: number) => m.t + ih - Math.sqrt(Math.max(0, v) / max) * ih;
  const x = (i: number) => m.l + (i / Math.max(1, weeks.length - 1)) * iw;
  const r = rng(11);

  const svg = el('svg', { viewBox: `0 0 ${width} ${H}`, width, height: H, 'aria-hidden': 'true' }); // the host carries the text alternative

  for (const t of ticks(max)) {
    const ty = y(t);
    svg.append(el('line', { x1: m.l, y1: ty, x2: m.l + iw, y2: ty, class: 'c-grid' }), text(m.l - 8, ty + 4, fmtShort(t), 'c-tick', 'end'));
  }
  svg.append(el('path', { d: `M${m.l} ${m.t - 8} L${m.l} ${m.t + ih} L${m.l + iw} ${m.t + ih}`, class: 'c-axis' }));

  // Month labels under the axis, thinned out on narrow screens.
  // A label is about 30px wide: thin out only when months would run into each other.
  const perMonth = (iw / Math.max(1, weeks.length - 1)) * 4.35;
  const every = narrow ? 3 : Math.max(1, Math.ceil(34 / perMonth));
  let lastMonth = -1;
  let seen = 0;
  weeks.forEach((w, i) => {
    const month = new Date(`${w.start}T00:00:00Z`).getUTCMonth();
    if (month === lastMonth) return;
    lastMonth = month;
    if (seen++ % every === 0 && x(i) > m.l + 10 && x(i) < width - 16) svg.append(text(x(i), H - 8, MONTHS[month], 'c-tick'));
  });

  for (const [k, ws] of all.entries()) {
    const ink = color(colors[k]);
    const pts = (v: (w: Week) => number) => ws.map((w, i): [number, number] => [x(i), y(v(w))]);
    if (single) {
      const band = [...pts((w) => w.high), ...pts((w) => w.low).reverse()];
      svg.append(el('path', { d: `${band.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ')} Z`, fill: color('--blue-soft'), stroke: 'none' }));
    }
    const npm = el('path', { d: wobbly(pts((w) => w.npm), r, 3), class: 'c-npm', stroke: single ? color('--pencil') : ink });
    if (!single) npm.setAttribute('opacity', '0.5');
    const real = el('path', { d: wobbly(pts((w) => w.organic), r, 3), class: 'c-real', stroke: ink, 'stroke-width': single ? (narrow ? 2.6 : 3.2) : 2.6 });
    const echo = el('path', { d: wobbly(pts((w) => w.organic), r, 5), class: 'c-echo', stroke: ink });
    if (animate) {
      for (const p of [real, echo]) {
        p.setAttribute('pathLength', '1');
        p.classList.add('c-draw');
      }
    }
    svg.append(npm, echo, real);
  }
  if (!single) return svg;

  // Release notes: the biggest publish weeks, labelled in red pen above the spike, with a short tick.
  // Weeks with a stable release first: a stream of canaries would otherwise take every label.
  const stable = (w: Week) => w.versions.some((v) => !v.includes('-'));
  const anyStable = weeks.some(stable);
  const picks = weeks
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => (anyStable ? stable(w) : w.versions.length > 0))
    .sort((a, b) => b.w.mirrors - a.w.mirrors || b.w.npm - a.w.npm)
    .slice(0, narrow ? 3 : 5)
    .sort((a, b) => a.i - b.i);
  const placed: { left: number; right: number; level: number }[] = [];
  for (const { w, i } of picks) {
    const label = versionLabel(w);
    const half = label.length * 3.5 + 4; // Caveat at 17px is roughly 7px per character
    const lx = Math.min(Math.max(x(i), m.l + half), width - half - 2);
    // Two rows of labels; drop the note when both rows are taken at this x.
    const level = [0, 1].find((lv) => !placed.some((p) => p.level === lv && lx - half < p.right && lx + half > p.left));
    if (level === undefined) continue;
    placed.push({ left: lx - half, right: lx + half, level });
    const ly = 16 + level * 18;
    // A short pen tick under the note, pointing at the spike's week.
    const py = Math.min(y(w.npm) - 4, ly + 17);
    if (py - ly > 8) svg.append(el('path', { d: `M${x(i)} ${ly + 5} L${x(i)} ${py}`, class: 'c-tickmark' }));
    svg.append(text(lx, ly, label, 'c-note'));
  }
  return svg;
}

// Renders into `host` and redraws whenever its width or the color theme changes. Returns a setter for the
// number of weeks shown (the 3 mo / 6 mo / 1 yr buttons).
export function mountChart(host: HTMLElement, series: Series[]): (weeks: number) => void {
  // Align on the newest week: every package's year ends on the same day, but young ones are shorter.
  const full = series.map((s) => toWeeks(s.est));
  const n = Math.min(...full.map((w) => w.length));
  const aligned = full.map((w) => w.slice(w.length - n));
  if (n < 2) {
    host.innerHTML = '<p class="chart-empty hand">Less than two weeks of downloads so far, too little to chart.</p>';
    return () => {};
  }
  host.setAttribute('role', 'img');
  if (aligned.length === 1) {
    const weeks = aligned[0];
    const sum = (k: 'npm' | 'organic' | 'low' | 'high') => weeks.reduce((s, w) => s + w[k], 0);
    host.setAttribute(
      'aria-label',
      `Chart of weekly downloads over the last ${weeks.length} weeks. npm counted ${fmt(sum('npm'))} downloads; ` +
        `real installs about ${fmt(sum('organic'))} (likely range ${fmt(sum('low'))} to ${fmt(sum('high'))}). ` +
        `Peak npm week: ${fmt(Math.max(...weeks.map((w) => w.npm)))}.`,
    );
  } else {
    const parts = series.map((s, k) => {
      const ws = aligned[k];
      return `${s.label}: npm ${fmt(ws.reduce((t, w) => t + w.npm, 0))}, real installs about ${fmt(ws.reduce((t, w) => t + w.organic, 0))}`;
    });
    host.setAttribute('aria-label', `Weekly downloads over the last ${n} weeks. ${parts.join('; ')}. The table below has the numbers.`);
  }
  const colors = series.map((s) => s.color);

  let shown = n;
  let lastWidth = 0;
  let drawn = false;
  const redraw = (force: boolean) => {
    const width = Math.floor(host.clientWidth);
    if (!width || (width === lastWidth && !force)) return;
    lastWidth = width;
    const all = aligned.map((w) => w.slice(-Math.max(2, shown)));
    host.replaceChildren(draw(all, colors, width, !drawn));
    drawn = true;
  };
  new ResizeObserver(() => redraw(false)).observe(host);
  const onTheme = () => (host.isConnected ? redraw(true) : removeEventListener('hl:theme', onTheme));
  addEventListener('hl:theme', onTheme);
  return (weeks: number) => {
    shown = Math.min(n, weeks);
    redraw(true);
  };
}
