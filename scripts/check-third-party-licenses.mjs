import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  cwd: root,
  encoding: 'utf8',
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const inventory = JSON.parse(result.stdout);
const allowedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MIT',
]);
const errors = [];
const packages = [];

for (const [license, entries] of Object.entries(inventory)) {
  if (!allowedLicenses.has(license)) errors.push(`Production dependency license requires review: ${license}`);
  for (const entry of entries) {
    for (const version of entry.versions ?? []) packages.push(`${entry.name}@${version}`);
    if (entry.name.startsWith('@felan-cloud/')) {
      errors.push(`Public production closure contains private package ${entry.name}`);
    }
  }
}

for (const required of [
  '@earendil-works/pi-agent-core@0.82.1',
  '@earendil-works/pi-ai@0.82.1',
  '@earendil-works/pi-coding-agent@0.82.1',
  '@earendil-works/pi-tui@0.82.1',
  'typebox@1.1.38',
]) {
  if (!packages.includes(required)) errors.push(`Production license inventory is missing ${required}`);
}

const notice = readFileSync(resolve(root, 'NOTICE'), 'utf8');
for (const requiredNotice of ['Pi 0.82.1', 'TypeBox 1.1.38']) {
  if (!notice.includes(requiredNotice)) errors.push(`NOTICE is missing ${requiredNotice}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(`Validated ${packages.length} permissively licensed production package versions`);
