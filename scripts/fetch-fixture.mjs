// Usage: node scripts/fetch-fixture.mjs <pkg> [...more]
// Saves the RawPackageData pieces to test/fixtures/<pkg>/ ("@scope/name" -> "scope__name").
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchPackageData } from '../src/core/sources.ts';

const root = fileURLToPath(new URL('../test/fixtures/', import.meta.url));

for (const name of process.argv.slice(2)) {
  const data = await fetchPackageData(name);
  const dir = root + name.replace(/^@/, '').replace('/', '__');
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/downloads.json`, JSON.stringify(data.downloads, null, 1) + '\n');
  await writeFile(`${dir}/registry.json`, JSON.stringify(data.registry, null, 1) + '\n');
  await writeFile(`${dir}/versions.json`, JSON.stringify(data.versionsLastWeek, null, 1) + '\n');
  console.log(`${name} -> ${dir}`);
}
