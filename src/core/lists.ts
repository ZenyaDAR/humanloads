// Ranked lists for "best X" and "most downloaded" searches. Each one is a Guide built on nightly data, so routing,
// the sitemap and the noindex gate are the same as for the other guides. The ranking is by real installs: it says what
// is used, not what is good, so every page also carries a few hand-written lines on how the options differ.
import { article, type Guide } from './guides.ts';
import { esc, rangeText, roundCount } from './html.ts';
import { FILTERED_NOTE, NOISE_CAPTION, compareLinksHtml, noiseText } from './seo.ts';
import type { ListRow, ListsFile } from './types.ts';

export const LISTS_FILE = 'data/lists.json';

export interface ListDef {
  slug: string;
  label: string; // link text on the home page
  h1: string;
  what: string; // what is ranked, for the meta description
  lede: string;
  advice: string; // trusted HTML, written here
  names?: string[]; // hand-picked packages, ranked by real installs. Without names: the whole catalog, by npm's count
}

// A small catalog misses much of the real top of npm, and a page titled "most downloaded" would be wrong, so it waits out of indexes.
const AUTO_MIN_CATALOG = 1000;
const CURATED_MIN_SHARE = 0.7; // with less of a list fetched so far the ranking would mislead, so it waits out of indexes
const CURATED_MIN_ROWS = 3;

export const LIST_DEFS: ListDef[] = [
  {
    slug: 'most-downloaded-npm-packages',
    label: 'Most downloaded npm packages',
    h1: 'Most downloaded npm packages',
    what: "The npm packages with the most downloads, with npm's weekly count next to real installs",
    lede: "The packages npm serves most often. At this scale most downloads come from CI runs and from other packages that depend on them, so the top is full of small helpers few people chose on purpose.",
    advice: `A high position here says a package sits deep in many dependency trees, not that it is a good pick. For an example, see <a href="{base}docs/why-is-number-has-so-many-downloads">why is-number has so many downloads</a>.`,
  },
  {
    slug: 'best-npm-test-frameworks',
    label: 'Test frameworks',
    h1: 'Best npm test frameworks',
    what: 'JavaScript and TypeScript test frameworks',
    lede: 'Unit and integration test runners for JavaScript and TypeScript.',
    advice: 'Vitest fits projects already on Vite and reuses their config. Jest is still the default in many React and older Node codebases, with a large ecosystem of matchers and plugins. Mocha only runs tests, so you choose your own assertion and mocking libraries.',
    names: ['vitest', 'jest', 'mocha', 'jasmine', 'ava', 'tap', 'uvu'],
  },
  {
    slug: 'best-npm-e2e-testing-tools',
    label: 'End-to-end testing tools',
    h1: 'Best npm end-to-end testing tools',
    what: 'End-to-end and browser testing tools',
    lede: 'Tools that test an application through a real browser.',
    advice: 'Playwright drives Chromium, Firefox and WebKit from one API. Cypress runs inside the browser and is known for its interactive runner. Puppeteer is a browser automation library more than a test runner. Selenium WebDriver suits teams that need the W3C WebDriver protocol across several languages.',
    names: ['playwright', 'cypress', 'puppeteer', 'selenium-webdriver', 'webdriverio', 'nightwatch', 'testcafe'],
  },
  {
    slug: 'best-javascript-bundlers',
    label: 'Bundlers and build tools',
    h1: 'Best JavaScript bundlers and build tools',
    what: 'JavaScript bundlers and build tools',
    lede: 'Tools that turn source files into what runs in the browser or gets published.',
    advice: 'Vite is a common default for new front-end apps, with a fast dev server. webpack still powers many existing apps and has a very wide plugin ecosystem. esbuild and Rspack focus on build speed. Rollup and tsup are frequent choices for building libraries.',
    names: ['vite', 'webpack', 'rollup', 'esbuild', 'parcel', '@rspack/core', 'tsup', 'rolldown'],
  },
  {
    slug: 'best-javascript-frameworks',
    label: 'Front-end frameworks',
    h1: 'Best JavaScript front-end frameworks',
    what: 'JavaScript front-end frameworks',
    lede: 'UI frameworks and libraries for building web interfaces.',
    advice: 'React has the largest ecosystem. Vue and Svelte are built around single-file components. Angular ships as a complete framework, with routing, forms and dependency injection included. Preact offers a small React-compatible API, and Solid pairs JSX with fine-grained reactivity.',
    names: ['react', 'vue', '@angular/core', 'svelte', 'preact', 'solid-js', 'lit', 'alpinejs'],
  },
  {
    slug: 'best-meta-frameworks',
    label: 'Full-stack web frameworks',
    h1: 'Best full-stack web frameworks',
    what: 'Full-stack JavaScript web frameworks',
    lede: 'Frameworks on top of a UI library that add routing, server rendering and a build setup.',
    advice: 'The UI library usually decides this one: Next.js for React, Nuxt for Vue, SvelteKit for Svelte. Remix is also for React, and its ideas have since moved into React Router. Astro suits content-heavy sites and ships little JavaScript by default. Gatsby focuses on static sites.',
    names: ['next', 'nuxt', '@sveltejs/kit', 'astro', 'gatsby', '@remix-run/react'],
  },
  {
    slug: 'best-node-js-web-frameworks',
    label: 'Node.js web frameworks',
    h1: 'Best Node.js web frameworks',
    what: 'Node.js web and API frameworks',
    lede: 'Server frameworks for building APIs and web back ends.',
    advice: 'Express is the long-time default with the most middleware. Fastify adds schema-based validation and a focus on performance. Hono runs on Node, Bun, Deno and edge runtimes. NestJS adds an opinionated structure on top of Express or Fastify, and Koa stays minimal.',
    names: ['express', 'fastify', 'koa', 'hono', '@nestjs/core', '@hapi/hapi', 'restify', 'h3'],
  },
  {
    slug: 'best-node-js-orms',
    label: 'ORMs and query builders',
    h1: 'Best Node.js ORMs and query builders',
    what: 'Node.js ORMs and query builders',
    lede: 'Libraries for talking to a database from Node.js and TypeScript.',
    advice: 'Prisma generates a typed client from its own schema file. Drizzle defines the schema in TypeScript and stays close to SQL. TypeORM and Sequelize are long-standing ORMs. Mongoose is for MongoDB only. Knex and Kysely are query builders rather than ORMs.',
    names: ['prisma', 'drizzle-orm', 'typeorm', 'sequelize', 'mongoose', 'knex', '@mikro-orm/core', 'kysely'],
  },
  {
    slug: 'best-typescript-validation-libraries',
    label: 'Validation libraries',
    h1: 'Best TypeScript validation libraries',
    what: 'TypeScript and JavaScript validation libraries',
    lede: 'Libraries that check data at runtime, from form input to API payloads.',
    advice: 'Zod infers TypeScript types from its schemas. Valibot has a similar idea with a modular design for small bundles. Yup and Joi are older, and Joi is mostly used on the server. Ajv validates JSON Schema, which helps when a schema is shared across languages. class-validator uses decorators and is common with NestJS.',
    names: ['zod', 'yup', 'joi', 'valibot', 'ajv', 'class-validator', 'superstruct', 'arktype'],
  },
  {
    slug: 'best-javascript-http-clients',
    label: 'HTTP clients',
    h1: 'Best JavaScript HTTP clients',
    what: 'JavaScript and Node.js HTTP clients',
    lede: 'Libraries for making HTTP requests from Node.js and the browser.',
    advice: 'Browsers and current Node.js versions ship <code>fetch</code>, so you may not need a library at all. Axios adds interceptors and works in both environments. Got is a Node client with retries and streams. Ky is a small wrapper over fetch. Undici is the client behind fetch in Node.js.',
    names: ['axios', 'node-fetch', 'got', 'ky', 'undici', 'superagent', 'ofetch'],
  },
  {
    slug: 'best-javascript-date-libraries',
    label: 'Date libraries',
    h1: 'Best JavaScript date libraries',
    what: 'JavaScript date and time libraries',
    lede: 'Libraries for parsing, formatting and calculating with dates.',
    advice: 'date-fns is a set of separate functions that tree-shake well. Day.js is small, with an API close to Moment. Luxon builds on the Intl API and handles time zones well. Moment is in maintenance mode, and its own docs suggest an alternative for new projects.',
    names: ['date-fns', 'dayjs', 'moment', 'luxon', '@js-temporal/polyfill'],
  },
  {
    slug: 'best-react-state-management-libraries',
    label: 'React state management',
    h1: 'Best React state management libraries',
    what: 'React state management libraries',
    lede: 'Libraries for state shared across a React application.',
    advice: 'Redux Toolkit is the recommended way to write Redux today. Zustand is a small store built on hooks. Jotai and Valtio model state as atoms and proxies. MobX uses observables, and XState models state as explicit state machines.',
    names: ['redux', '@reduxjs/toolkit', 'zustand', 'jotai', 'mobx', 'xstate', 'valtio'],
  },
  {
    slug: 'best-react-data-fetching-libraries',
    label: 'React data fetching',
    h1: 'Best React data fetching libraries',
    what: 'React data fetching and server state libraries',
    lede: 'Libraries that fetch, cache and refresh server data in React.',
    advice: 'TanStack Query and SWR cache the result of any async function, so they work with REST and GraphQL alike. Apollo Client and urql are GraphQL clients with their own caches.',
    names: ['@tanstack/react-query', 'swr', '@apollo/client', 'urql'],
  },
  {
    slug: 'best-css-frameworks',
    label: 'CSS frameworks',
    h1: 'Best CSS frameworks on npm',
    what: 'CSS frameworks',
    lede: 'Frameworks that give a project its base styles, components or utility classes.',
    advice: 'Tailwind CSS and UnoCSS are built around utility classes. Bootstrap and Foundation ship ready-made components. Bulma is CSS only, with no JavaScript. Pico styles plain HTML with few or no classes.',
    names: ['tailwindcss', 'bootstrap', 'bulma', 'unocss', '@picocss/pico', 'foundation-sites'],
  },
  {
    slug: 'best-react-ui-libraries',
    label: 'React UI libraries',
    h1: 'Best React UI component libraries',
    what: 'React UI component libraries',
    lede: 'Ready-made React components for building interfaces.',
    advice: 'MUI implements Material Design. Ant Design is common in data-heavy admin interfaces. Chakra UI and Mantine offer styled, themeable components. React Bootstrap wraps Bootstrap, and Headless UI provides accessible behavior with no styles of its own.',
    names: ['@mui/material', 'antd', '@chakra-ui/react', '@mantine/core', 'react-bootstrap', '@headlessui/react'],
  },
  {
    slug: 'best-javascript-linters-and-formatters',
    label: 'Linters and formatters',
    h1: 'Best JavaScript linters and formatters',
    what: 'JavaScript and TypeScript linters and formatters',
    lede: 'Tools that catch mistakes and keep code style consistent.',
    advice: 'ESLint finds problems and has the largest set of plugins. Prettier only formats, so the two are often used together. Biome does both in one fast tool. Oxlint focuses on speed and can run alongside ESLint. Stylelint is for CSS.',
    names: ['eslint', 'prettier', '@biomejs/biome', 'oxlint', 'stylelint', 'standard', 'dprint'],
  },
  {
    slug: 'best-javascript-package-managers',
    label: 'Package managers',
    h1: 'Best JavaScript package managers',
    what: 'JavaScript package managers',
    lede: 'Tools that install the dependencies of a JavaScript project.',
    advice: "Read this ranking with care: npm comes with Node.js, and the others are often installed outside the npm registry, so these counts understate all of them. pnpm saves disk space with a shared store and a strict node_modules. The yarn package on npm is Yarn Classic; newer versions, with Plug'n'Play, are set up per project. Bun is a whole runtime with a fast installer.",
    names: ['npm', 'pnpm', 'yarn', 'bun'],
  },
  {
    slug: 'best-monorepo-tools',
    label: 'Monorepo tools',
    h1: 'Best JavaScript monorepo tools',
    what: 'JavaScript monorepo tools',
    lede: 'Tools for running tasks and publishing packages across a monorepo.',
    advice: 'Turborepo focuses on task caching. Nx adds a project graph, generators and plugins. Lerna is known for versioning and publishing many packages, and Changesets handles versions and changelogs.',
    names: ['turbo', 'nx', 'lerna', '@changesets/cli'],
  },
  {
    slug: 'best-node-js-logging-libraries',
    label: 'Logging libraries',
    h1: 'Best Node.js logging libraries',
    what: 'Node.js logging libraries',
    lede: 'Libraries for writing logs from Node.js applications.',
    advice: 'Pino writes JSON with low overhead. Winston is known for its configurable transports. Bunyan is an older JSON logger. log4js follows the log4j style. Morgan is different: it is HTTP request logging middleware for Express. loglevel also works in the browser, and Consola is aimed at CLI tools.',
    names: ['winston', 'pino', 'bunyan', 'log4js', 'morgan', 'loglevel', 'consola'],
  },
  {
    slug: 'best-node-js-cli-libraries',
    label: 'CLI libraries',
    h1: 'Best Node.js CLI libraries',
    what: 'Node.js libraries for building command line tools',
    lede: 'Libraries for parsing arguments and building command line tools.',
    advice: 'Commander and yargs cover most command line tools. minimist only parses arguments, and much of its count comes from other packages depending on it. oclif is a full framework for large CLIs with plugins. meow, cac and citty are smaller options, and Clipanion is a type-safe one.',
    names: ['commander', 'yargs', 'minimist', 'cac', '@oclif/core', 'meow', 'citty', 'clipanion'],
  },
  {
    slug: 'best-javascript-chart-libraries',
    label: 'Chart libraries',
    h1: 'Best JavaScript chart libraries',
    what: 'JavaScript chart and data visualization libraries',
    lede: 'Libraries for drawing charts and data visualizations on the web.',
    advice: 'Chart.js is a simple way to get common charts on a canvas. Recharts and Nivo are made for React. D3 is low level, so you build the chart yourself. ECharts and Plotly handle large or scientific data sets. Check the license on Highcharts, which requires a paid one for most commercial use.',
    names: ['chart.js', 'recharts', 'd3', 'echarts', 'apexcharts', 'highcharts', 'plotly.js', '@nivo/core'],
  },
  {
    slug: 'best-react-form-libraries',
    label: 'React form libraries',
    h1: 'Best React form libraries',
    what: 'React form libraries',
    lede: 'Libraries that manage form state and validation in React.',
    advice: 'React Hook Form relies on uncontrolled inputs to limit re-renders. Formik uses controlled inputs and is common in older codebases. TanStack Form puts its focus on type safety, and React Final Form on subscribing to only the state a component needs.',
    names: ['react-hook-form', 'formik', '@tanstack/react-form', 'react-final-form'],
  },
  {
    slug: 'best-javascript-utility-libraries',
    label: 'Utility libraries',
    h1: 'Best JavaScript utility libraries',
    what: 'JavaScript utility libraries',
    lede: 'Collections of helpers for arrays, objects and functions.',
    advice: 'Modern JavaScript covers much of what these libraries were first written for, so check for a native method first. Lodash remains the most widespread. es-toolkit offers a smaller, modern take with a Lodash compatibility layer. Ramda is built for functional programming, and Remeda is TypeScript first.',
    names: ['lodash', 'ramda', 'underscore', 'es-toolkit', 'remeda', 'radash'],
  },
];

// Every hand-picked name: their rows must exist and stay in the catalog.
export const LIST_NAMES: string[] = [...new Set(LIST_DEFS.flatMap((d) => d.names ?? []))];

const dateOf = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
const fullDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const count = (n: number) => Math.round(n).toLocaleString('en-US');

function tableHtml(rows: ListRow[], base: string): string {
  return `<div class="table-wrap"><table class="cmp-table list-table">
      <thead><tr><th scope="col">package</th><th scope="col" class="num">real installs / week</th><th scope="col" class="num">npm / week</th><th scope="col" class="num">noise</th><th scope="col">last release</th><th scope="col">confidence</th></tr></thead>
      <tbody>${rows
        .map(
          (r, i) => `<tr><th scope="row">${i + 1}. <a href="${esc(base + r.name)}">${esc(r.name)}</a>${r.deprecated ? ' <span class="pill pill-low">deprecated</span>' : ''}${r.description ? `<span class="list-desc">${esc(r.description)}</span>` : ''}</th>
          <td class="num above" data-label="real installs / week">${rangeText(r.low, r.high)}</td>
          <td class="num" data-label="npm / week">${count(r.npmWeekly)}</td>
          <td class="num" data-label="noise">${noiseText(r.npmWeekly, r.organicWeekly)}</td>
          <td data-label="last release">${esc(dateOf(r.lastRelease))}</td>
          <td data-label="confidence"><span class="pill pill-${esc(r.confidence)}">${esc(r.confidence)}</span></td></tr>`,
        )
        .join('')}</tbody>
    </table></div>`;
}

const leader = (def: ListDef, rows: ListRow[]): string => {
  const [top, next] = rows;
  if (!top || !next) return '';
  if (!def.names) return ` <strong>${esc(top.name)}</strong> leads with about ${roundCount(top.npmWeekly)} downloads a week, followed by ${esc(next.name)}.`;
  return ` <strong>${esc(top.name)}</strong> leads with about ${roundCount(top.organicWeekly)} real installs a week, followed by ${esc(next.name)} with about ${roundCount(next.organicWeekly)}.`;
};

const asOf = (rows: ListRow[]): string => {
  const oldest = rows.map((r) => r.updated).filter((d): d is string => Boolean(d)).sort()[0];
  return oldest ? ` Rows are refreshed in rotation, the oldest here on ${esc(fullDate(oldest))}.` : '';
};

function listGuide(def: ListDef): Guide<ListsFile> {
  const name = def.names ?? [];
  const lead = name.length ? `${name.slice(0, 3).join(', ')} and more` : 'kept up to date';
  return {
    path: `lists/${def.slug}`,
    title: `${def.h1} · humanloads`,
    description: name.length ? `${def.what} ranked by real installs: ${lead}.` : `${def.what}, ${lead}.`,
    dataFile: LISTS_FILE,
    ready: (ins) => {
      const data = ins?.lists?.[def.slug];
      return name.length
        ? (data?.rows.length ?? 0) >= Math.max(CURATED_MIN_ROWS, Math.ceil(name.length * CURATED_MIN_SHARE))
        : (data?.catalog ?? 0) >= AUTO_MIN_CATALOG;
    },
    body: (base, ins) => {
      const data = ins?.lists?.[def.slug];
      const rows = data?.rows ?? [];
      const order = !def.names
        ? `Ranked by npm's weekly count, among the ${count(data?.catalog ?? 0)} packages we track, not all of npm. @types stubs and packages under two weeks old are left out.`
        : 'Ranked by real installs. That measures use, not quality: read the notes below before choosing.';
      return article(
        esc(def.h1),
        `${esc(def.lede)}${leader(def, rows)}`,
        `${rows.length
          ? `<section>
    ${tableHtml(rows, base)}
    <p class="fineprint">${order} ${esc(FILTERED_NOTE)} ${esc(NOISE_CAPTION)}${asOf(rows)}</p>
  </section>`
          : '<section><p>The ranking fills in as the nightly data run reaches these packages.</p></section>'}
  <section>
    <h2 class="section-title">${def.names ? 'How do they differ?' : 'What does it tell you?'}</h2>
    <p>${def.advice.replaceAll('{base}', base)}</p>
  </section>
  ${compareLinksHtml(base, data?.pairs ?? [], esc, 'Compare them')}`,
        base,
      );
    },
  };
}

export const LISTS: Guide<ListsFile>[] = LIST_DEFS.map(listGuide);

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
};
const RANK_WINDOW = 2; // neighbours shown on each side

// "3rd of 8 test frameworks", read straight from the ranked list so it always matches the list page. Only lists that
// are ready (enough rows fetched), and never the package's own number: the SPA shows live numbers above, this is a
// nightly snapshot, and the two would disagree.
export function categoryRankHtml(name: string, file: ListsFile | null | undefined, base: string): string {
  const parts = LIST_DEFS.flatMap((def, k) => {
    const rows = file?.lists?.[def.slug]?.rows;
    const i = rows?.findIndex((r) => r.name === name) ?? -1;
    if (!def.names?.includes(name) || !rows || i < 0 || !LISTS[k].ready!(file ?? null)) return [];
    const href = esc(`${base}lists/${def.slug}`);
    // Names only: the table below carries the numbers, as ranges.
    const [above, below] = [rows[i - 1], rows[i + 1]];
    const near = [above && `behind ${esc(above.name)}`, below && `ahead of ${esc(below.name)}`].filter(Boolean).join(' and ');
    // Same number of rows wherever the package sits, as far as the list allows.
    const size = 2 * RANK_WINDOW + 1;
    const start = Math.max(0, Math.min(i - RANK_WINDOW, rows.length - size));
    const window = rows.slice(start, start + size);
    const table = `<div class="table-wrap"><table class="cmp-table">
          <thead><tr><th scope="col">package</th><th scope="col" class="num">real installs / week</th><th scope="col" class="num">npm / week</th></tr></thead>
          <tbody>${window
            .map((r, j) =>
              r.name === name
                ? `<tr class="is-self"><th scope="row">${start + j + 1}. ${esc(r.name)}</th><td class="num" data-label="real installs / week">this package</td><td class="num" data-label="npm / week">—</td></tr>`
                : `<tr><th scope="row">${start + j + 1}. <a href="${esc(base + r.name)}">${esc(r.name)}</a></th><td class="num above" data-label="real installs / week">${rangeText(r.low, r.high)}</td><td class="num" data-label="npm / week">${count(r.npmWeekly)}</td></tr>`,
            )
            .join('')}</tbody>
        </table></div>`;
    // The label as written: lowercasing it would break CSS, HTTP, React, Node.js.
    return [`<p>In last night's <a href="${href}">${esc(def.label)}</a> ranking, ${esc(name)} is <strong>${ordinal(i + 1)} of ${rows.length}</strong> by real installs${near ? `, ${near}` : ''}.</p>
        ${table}
        <p class="fineprint">From the nightly build.${asOf(rows)} <a href="${href}">See the full ranking <span aria-hidden="true">→</span></a></p>`];
  });
  if (!parts.length) return '';
  return `<section class="insights rank">
        <h2 class="section-title">How does ${esc(name)} rank?</h2>
        ${parts.join('\n        ')}
      </section>`;
}

// Links to the lists, on the home page in both static and app markup.
export function listLinksHtml(base: string): string {
  return `<section class="cmp-links-sec">
      <h2 class="section-title">Best npm packages by category</h2>
      <ul class="cmp-links">${LIST_DEFS.map((d) => `<li><a class="tag" href="${esc(`${base}lists/${d.slug}`)}">${esc(d.label)}</a></li>`).join('')}</ul>
    </section>`;
}
