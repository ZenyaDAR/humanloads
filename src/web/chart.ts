import rough from 'roughjs';
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
  return [0, ...new Set(out)];
}

function text(x: number, y: number, value: string, cls: string, anchor = 'middle'): SVGTextElement {
  const t = document.createElementNS(NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('text-anchor', anchor);
  t.setAttribute('class', cls);
  t.textContent = value; // version strings are third-party: textContent only
  return t;
}

function versionLabel(w: Week): string {
  const v = w.versions[w.versions.length - 1];
  const name = /^\d/.test(v) ? `v${v}` : v;
  const more = w.versions.length > 1 ? ` +${w.versions.length - 1}` : '';
  return `${name}${more}${w.mirrors > 0 ? ' → mirrors' : ''}`;
}

// One line per package. A single series gets the full treatment (range band, publish notes);
// several series (compare page) get one marker line each plus a faint dashed npm line.
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
  const H = Math.round(Math.min(340, Math.max(230, width * 0.48)));
  const m = { t: single ? 44 : 16, r: 12, b: 30, l: narrow ? 36 : 48 };
  const iw = width - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = Math.max(1, ...all.flat().map((w) => Math.max(w.npm, w.high)));
  // ponytail: sqrt scale so a 2/week human line stays visible next to 500-fetch mirror spikes; ticks keep it honest.
  const y = (v: number) => m.t + ih - Math.sqrt(Math.max(0, v) / max) * ih;
  const x = (i: number) => m.l + (i / (weeks.length - 1)) * iw;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${H}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-hidden', 'true'); // the figure carries the text alternative
  const rc = rough.svg(svg);
  const base = { seed: 11, roughness: 1, bowing: 0.7 };

  for (const t of ticks(max)) {
    const ty = y(t);
    const guide = rc.line(m.l, ty, m.l + iw, ty, { ...base, stroke: color('--pencil'), strokeWidth: 0.6, roughness: 0.5, disableMultiStroke: true });
    guide.setAttribute('opacity', t === 0 ? '0' : '0.45');
    svg.append(guide, text(m.l - 7, ty + 4, fmtShort(t), 'c-tick', 'end'));
  }
  svg.append(rc.line(m.l, m.t + ih, m.l + iw, m.t + ih, { ...base, stroke: color('--ink'), strokeWidth: 1.2 }));
  svg.append(rc.line(m.l, m.t - 6, m.l, m.t + ih, { ...base, stroke: color('--ink'), strokeWidth: 1.2 }));

  // Month labels under the axis, thinned out on narrow screens.
  const every = narrow ? 3 : width < 760 ? 2 : 1;
  let lastMonth = -1;
  let seen = 0;
  weeks.forEach((w, i) => {
    const month = new Date(`${w.start}T00:00:00Z`).getUTCMonth();
    if (month === lastMonth) return;
    lastMonth = month;
    if (seen++ % every === 0 && x(i) > m.l + 10 && x(i) < width - 16) svg.append(text(x(i), H - 9, MONTHS[month], 'c-tick'));
  });

  for (const [k, ws] of all.entries()) {
    const ink = color(colors[k]);
    const line = (v: (w: Week) => number) => ws.map((w, i): [number, number] => [x(i), y(v(w))]);
    if (single) {
      const band = rc.polygon([...line((w) => w.high), ...line((w) => w.low).reverse()], {
        ...base, stroke: 'none', fill: ink, fillStyle: 'hachure', hachureAngle: -41, hachureGap: narrow ? 4 : 5, fillWeight: 0.9,
      });
      band.setAttribute('opacity', '0.4');
      svg.append(band);
    }
    const npm = rc.linearPath(line((w) => w.npm), {
      ...base, stroke: single ? color('--pencil') : ink, strokeWidth: single ? 1.7 : 1.3, strokeLineDash: [7, 5], roughness: 1.4, disableMultiStroke: true,
    });
    if (!single) npm.setAttribute('opacity', '0.5');
    const organic = rc.linearPath(line((w) => w.organic), {
      ...base, seed: base.seed + k, stroke: ink, strokeWidth: narrow ? 2.6 : 3.2, roughness: 0.9,
    });
    if (animate) {
      organic.setAttribute('class', 'c-draw');
      organic.querySelectorAll('path').forEach((p) => p.setAttribute('pathLength', '1'));
    }
    svg.append(npm, organic);
  }
  if (!single) return svg;

  // Margin notes: the biggest publish weeks, labelled in note blue with a sketched arrow.
  const picks = weeks
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.versions.length > 0)
    .sort((a, b) => b.w.mirrors - a.w.mirrors || b.w.npm - a.w.npm)
    .slice(0, narrow ? 3 : 5)
    .sort((a, b) => a.i - b.i);
  const placed: { left: number; right: number; level: number }[] = [];
  for (const { w, i } of picks) {
    const label = versionLabel(w);
    const half = label.length * 3.6 + 4; // Caveat at 16px is roughly 7px per character
    const lx = Math.min(Math.max(x(i), half + 2), width - half - 2);
    // Two rows of labels; drop the note when both rows are taken at this x.
    const level = [0, 1].find((lv) => !placed.some((p) => p.level === lv && lx - half < p.right && lx + half > p.left));
    if (level === undefined) continue;
    placed.push({ left: lx - half, right: lx + half, level });
    const ly = 16 + level * 17;
    const px = x(i);
    const py = y(w.npm) - 5;
    const ink = { ...base, stroke: color('--note'), strokeWidth: 1.1, roughness: 0.8, disableMultiStroke: true };
    if (py - ly > 14) {
      svg.append(rc.line(lx, ly + 5, px, py, ink));
      const ang = Math.atan2(py - ly - 5, px - lx);
      for (const d of [0.5, -0.5]) svg.append(rc.line(px, py, px - 7 * Math.cos(ang + d), py - 7 * Math.sin(ang + d), ink));
    }
    svg.append(text(lx, ly, label, 'c-note'));
  }
  return svg;
}

// Renders into `host` and redraws whenever its width or the color theme changes.
export function mountChart(host: HTMLElement, series: Series[]): void {
  // Align on the newest week: every package's year ends on the same day, but young ones are shorter.
  const full = series.map((s) => toWeeks(s.est));
  const n = Math.min(...full.map((w) => w.length));
  const all = full.map((w) => w.slice(w.length - n));
  if (n < 2) {
    host.innerHTML = '<p class="chart-empty hand">Not enough history to draw a chart yet.</p>';
    return;
  }
  host.setAttribute('role', 'img');
  if (all.length === 1) {
    const weeks = all[0];
    const sum = (k: 'npm' | 'organic' | 'low' | 'high') => weeks.reduce((s, w) => s + w[k], 0);
    host.setAttribute(
      'aria-label',
      `Chart of weekly downloads over the last ${weeks.length} weeks. npm counted ${fmt(sum('npm'))} downloads; ` +
        `estimated human installs ${fmt(sum('organic'))} (range ${fmt(sum('low'))} to ${fmt(sum('high'))}). ` +
        `Peak npm week: ${fmt(Math.max(...weeks.map((w) => w.npm)))}.`,
    );
  } else {
    const parts = series.map((s, k) => {
      const ws = all[k];
      return `${s.label}: npm ${fmt(ws.reduce((t, w) => t + w.npm, 0))}, humans about ${fmt(ws.reduce((t, w) => t + w.organic, 0))}`;
    });
    host.setAttribute('aria-label', `Weekly downloads over the last ${n} weeks. ${parts.join('; ')}. The table below has the numbers.`);
  }
  const colors = series.map((s) => s.color);

  let lastWidth = 0;
  let drawn = false;
  const redraw = (force: boolean) => {
    const width = Math.floor(host.clientWidth);
    if (!width || (width === lastWidth && !force)) return;
    lastWidth = width;
    host.replaceChildren(draw(all, colors, width, !drawn));
    drawn = true;
  };
  new ResizeObserver(() => redraw(false)).observe(host);
  const onTheme = () => (host.isConnected ? redraw(true) : removeEventListener('hl:theme', onTheme));
  addEventListener('hl:theme', onTheme);
}
