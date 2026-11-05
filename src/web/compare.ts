import { awaitingEvidence, estimate } from '../core/estimate.ts';
import { fetchConfidenceEvidence } from '../core/sources.ts';
import { PackageNotFoundError, type Estimate, type RawPackageData } from '../core/types.ts';
import { mountChart } from './chart.ts';
import { calibration, getData } from './package.ts';
import { BASE, esc, fmt, METHODOLOGY_URL, pkgHref } from './util.ts';
import { CHECKING_LABEL, NOISE_CAPTION, compareLinksHtml, noiseText, rangeText, roundCount } from '../core/seo.ts';
import COMPARE_PAIRS from '../../data/compare.json';

// Ballpoint blue, berry, green ink: each checked for 3:1 against paper in both themes (see style.css).
const COLORS = ['--marker', '--berry', '--green'];

const title = (names: string[]) => names.map((n) => `<span class="pkg-name">${esc(n)}</span>`).join(' <span class="vs hand">vs</span> ');

// Same caption in the skeleton, the live page and the prerendered page (scripts/data-lib.ts), so the
// chart doesn't move when the data arrives (CLS).
const caption = (names: string[]) => `<figcaption>
            <h2 class="section-title">Real installs, week by week</h2>
            <ul class="legend">
              ${names.map((n, i) => `<li><span class="key key-line" style="--c:var(${COLORS[i]})" aria-hidden="true"></span>${esc(n)}</li>`).join('')}
              <li><span class="key key-npm" aria-hidden="true"></span>npm downloads (same color, dashed)</li>
            </ul>
          </figcaption>`;

export function renderCompare(view: HTMLElement, names: string[]): void {
  view.innerHTML = `
    <article class="pkg compare" aria-busy="true">
      <header class="pkg-head"><h1 tabindex="-1">${title(names)}</h1></header>
      <figure class="chart-fig">${caption(names)}<div class="sk sk-chart" role="status" aria-label="Loading the chart"></div></figure>
    </article>`;
  void load(view, names);
}

async function load(view: HTMLElement, names: string[]): Promise<void> {
  const cal = await calibration();
  const results = await Promise.allSettled(names.map((n) => getData(n)));
  if (!view.isConnected) return;
  const hadFocus = view.contains(document.activeElement);

  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ name: names[i], err: r.reason }] : []));
  if (failed.length) {
    view.innerHTML = `
      <section class="state state-error" role="alert">
        <h1 tabindex="-1">Can't compare these yet</h1>
        <ul>${failed
          .map(
            (f) => `<li><code>${esc(f.name)}</code>: ${
              f.err instanceof PackageNotFoundError ? 'npm has never heard of it.' : 'the npm API did not answer. Try again in a minute.'
            }</li>`,
          )
          .join('')}</ul>
        <p><a href="${BASE}">Search for a package</a></p>
      </section>`;
  } else {
    const data = results.map((r) => (r as PromiseFulfilledResult<RawPackageData>).value);
    const ests = data.map((d) => estimate(d, { calibration: cal }));
    view.innerHTML = `
      <article class="pkg compare">
        <header class="pkg-head"><h1 tabindex="-1">${title(names)}</h1></header>
        <figure class="chart-fig">
          ${caption(names)}
          <div class="chart"></div>
          <p class="fineprint">Square-root vertical scale. Weeks are aligned on the newest one.</p>
          ${unevenNote(names, ests)}
        </figure>
        ${table(names, ests)}
        <p class="method"><a href="${METHODOLOGY_URL}">How we filter this <span aria-hidden="true">→</span></a></p>
        ${compareLinksHtml(BASE, COMPARE_PAIRS.filter((p) => p.join() !== names.join()).slice(0, 8), esc, 'More comparisons')}
      </article>`;
    mountChart(
      view.querySelector<HTMLElement>('.chart')!,
      ests.map((est, i) => ({ est, label: names[i], color: COLORS[i] })),
    );
    if (hadFocus) view.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
    // Confidence needs independent evidence, so the pills firm up once it arrives; the chart doesn't wait for it.
    // Only the pills change, so a keyboard user on a link in the table keeps their place.
    const evidence = await Promise.all(names.map((n) => fetchConfidenceEvidence(n)));
    if (!view.isConnected) return;
    view.querySelectorAll<HTMLElement>('.cmp-table tbody .pill').forEach((pill, i) => {
      const { confidence } = estimate(data[i], { calibration: cal, evidence: evidence[i] });
      pill.className = `pill pill-${confidence}`;
      pill.textContent = confidence;
    });
    return;
  }
  if (hadFocus) view.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
}

// With a very uneven pair the small package's line hugs the axis; say so and point to its own page, which has its own scale.
function unevenNote(names: string[], ests: Estimate[]): string {
  const sizes = ests.map((e) => e.lastWeek.organic);
  const big = sizes.indexOf(Math.max(...sizes));
  const small = sizes.indexOf(Math.min(...sizes));
  if (big === small || sizes[big] < sizes[small] * 20 + 20) return '';
  const link = `<a href="${esc(pkgHref(names[small]))}">${esc(names[small])}</a>`;
  return `<p class="fineprint">${link} is far smaller than ${esc(names[big])} (${rangeText(ests[small].lastWeek.low, ests[small].lastWeek.high)} against ${roundCount(sizes[big])} real installs a week), so its line hugs the bottom. Its own page has its own scale.</p>`;
}

function table(names: string[], ests: Estimate[]): string {
  return `
    <section class="versions compare-table">
      <h2 class="section-title">Last 7 days, side by side</h2>
      <div class="table-wrap">
        <table class="cmp-table">
          <thead><tr>
            <th scope="col">package</th><th scope="col" class="num">npm / week</th>
            <th scope="col" class="num">real installs / week</th><th scope="col" class="num">noise</th><th scope="col">confidence</th>
          </tr></thead>
          <tbody>${ests
            .map((e, i) => {
              const w = e.lastWeek;
              const pill = awaitingEvidence(e) ? `<span class="pill pill-checking">${CHECKING_LABEL}</span>` : `<span class="pill pill-${e.confidence}">${e.confidence}</span>`;
              return `<tr>
                <th scope="row"><span class="key key-line" style="--c:var(${COLORS[i]})" aria-hidden="true"></span>
                  <a href="${esc(pkgHref(names[i]))}">${esc(names[i])}</a></th>
                <td class="num" data-label="npm / week">${fmt(w.npm)}</td>
                <td class="num above" data-label="real installs / week">${rangeText(w.low, w.high)}</td>
                <td class="num" data-label="noise">${noiseText(w.npm, w.organic, e.tooNew)}</td>
                <td data-label="confidence">${pill}</td>
              </tr>`;
            })
            .join('')}</tbody>
        </table>
      </div>
      <p class="fineprint">${NOISE_CAPTION}</p>
    </section>`;
}
