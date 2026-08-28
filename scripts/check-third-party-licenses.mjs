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
  'BSD-2-Clause',
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
  '@earendil-works/pi-agent-core@0.84.3',
  '@earendil-works/pi-ai@0.84.3',
  '@earendil-works/pi-coding-agent@0.84.3',
  '@earendil-works/pi-tui@0.84.3',
  '@lydell/node-pty@1.2.0-beta.14',
  '@modelcontextprotocol/client@2.0.0',
  '@modelcontextprotocol/core@2.0.0',
  '@napi-rs/keyring@1.3.0',
  'open@11.0.0',
  'typebox@1.1.38',
]) {
  if (!packages.includes(required)) errors.push(`Production license inventory is missing ${required}`);
}

const notice = readFileSync(resolve(root, 'NOTICE'), 'utf8');
for (const requiredNotice of [
  'Pi 0.84.3',
  '@lydell/node-pty 1.2.0-beta.14',
  'TypeBox 1.1.38',
  'pi-mcp-adapter 2.21.0',
  'pi-mcp-adapter 2.26.0',
  'pi-ask-user 0.14.0',
  'pi-web-access 0.23.0',
  '@howaboua/pi-codex-conversion 3.0.15',
  '@modelcontextprotocol/client 2.0.0',
  '@napi-rs/keyring 1.3.0',
  'open 11.0.0',
  'pi-rtk-optimizer 0.9.0',
  'Microsoft MarkItDown 0.1.7',
  'https://github.com/JuliusBrussee/caveman',
]) {
  if (!notice.includes(requiredNotice)) errors.push(`NOTICE is missing ${requiredNotice}`);
}
const agentCoreNotice = readFileSync(resolve(root, 'packages/agent-core/NOTICE'), 'utf8');
if (!agentCoreNotice.includes('@lydell/node-pty 1.2.0-beta.14')) {
  errors.push('packages/agent-core/NOTICE is missing @lydell/node-pty 1.2.0-beta.14');
}
const outputStyleNotice = readFileSync(resolve(root, 'packages/ext-output-style/NOTICE'), 'utf8');
for (const requiredNotice of [
  'https://github.com/JuliusBrussee/caveman',
  'Copyright (c) 2026 Julius Brussee',
]) {
  if (!outputStyleNotice.includes(requiredNotice)) {
    errors.push(`packages/ext-output-style/NOTICE is missing ${requiredNotice}`);
  }
}
const subagentsNotice = readFileSync(resolve(root, 'packages/ext-subagents/NOTICE'), 'utf8');
if (!subagentsNotice.includes('TypeBox 1.1.38')) {
  errors.push('packages/ext-subagents/NOTICE is missing TypeBox 1.1.38');
}
const askUserNotice = readFileSync(resolve(root, 'packages/ext-ask-user/NOTICE'), 'utf8');
for (const requiredNotice of [
  'https://github.com/mslavov/pi-extensions',
  'https://github.com/edlsh/pi-ask-user',
  '7e72e509fe45a5a87c4c2e176cb711de994a8c1d',
  'pi-ask-user 0.14.0',
  '2de7e145227f7a527e995e323a50e7ee9bf88b0e',
  'Pi-TUI 0.84.3',
  'TypeBox 1.1.38',
]) {
  if (!askUserNotice.includes(requiredNotice)) {
    errors.push(`packages/ext-ask-user/NOTICE is missing ${requiredNotice}`);
  }
}
const backgroundBashNotice = readFileSync(resolve(root, 'packages/ext-background-bash/NOTICE'), 'utf8');
if (!backgroundBashNotice.includes('TypeBox 1.1.38')) {
  errors.push('packages/ext-background-bash/NOTICE is missing TypeBox 1.1.38');
}
const browserNotice = readFileSync(resolve(root, 'packages/ext-browser/NOTICE'), 'utf8');
for (const requiredNotice of [
  'agent-browser 0.31.1',
  'Apache License 2.0',
  'RjgfT0EsHe1oZQbwzUqJTPb7w3sU8DGbbAjMxLNI5dW1y0cc81TbVsqgjqQJmsy3GEbEcKe/ryARwmWGqJAXXQ==',
  'TypeBox 1.1.38',
]) {
  if (!browserNotice.includes(requiredNotice)) {
    errors.push(`packages/ext-browser/NOTICE is missing ${requiredNotice}`);
  }
}
const codexNotice = readFileSync(resolve(root, 'packages/ext-codex/NOTICE'), 'utf8');
for (const requiredNotice of [
  '@howaboua/pi-codex-conversion 3.0.8',
  '62d1501ac0c6acb39c4b4d225a9e9056a7ba3b91',
  '@howaboua/pi-codex-conversion 3.0.15',
  'b4b99630cda3c066749af0fb3ac9b8184b2a4c7d',
  'TypeBox 1.1.38',
]) {
  if (!codexNotice.includes(requiredNotice)) {
    errors.push(`packages/ext-codex/NOTICE is missing ${requiredNotice}`);
  }
}
const rtkOptimizerNotice = readFileSync(resolve(root, 'packages/ext-rtk-optimizer/NOTICE'), 'utf8');
for (const requiredNotice of [
  'pi-rtk-optimizer 0.9.0',
  'd155d253cb2f1358e34e717d47a82ebccb08cb8e',
]) {
  if (!rtkOptimizerNotice.includes(requiredNotice)) {
    errors.push(`packages/ext-rtk-optimizer/NOTICE is missing ${requiredNotice}`);
  }
}
const markitdownNotice = readFileSync(resolve(root, 'packages/ext-markitdown/NOTICE'), 'utf8');
for (const requiredNotice of [
  'packages/pi-markitdown',
  '7e72e509fe45a5a87c4c2e176cb711de994a8c1d',
  'Microsoft MarkItDown 0.1.7',
  'https://github.com/microsoft/markitdown',
]) {
  if (!markitdownNotice.includes(requiredNotice)) {
    errors.push(`packages/ext-markitdown/NOTICE is missing ${requiredNotice}`);
  }
}
const contextViewNotice = readFileSync(resolve(root, 'packages/ext-context-view/NOTICE'), 'utf8');
for (const requiredNotice of [
  'packages/pi-context',
  '7e72e509fe45a5a87c4c2e176cb711de994a8c1d',
  'Pi-TUI 0.84.3',
]) {
  if (!contextViewNotice.includes(requiredNotice)) {
    errors.push(`packages/ext-context-view/NOTICE is missing ${requiredNotice}`);
  }
}
const tasksNotice = readFileSync(resolve(root, 'packages/ext-tasks/NOTICE'), 'utf8');
if (!tasksNotice.includes('TypeBox 1.1.38')) {
  errors.push('packages/ext-tasks/NOTICE is missing TypeBox 1.1.38');
}
const webAccessNotice = readFileSync(resolve(root, 'packages/ext-web-access/NOTICE'), 'utf8');
for (const requiredNotice of [
  'pi-web-access 0.18.0',
  'https://github.com/nicobailon/pi-web-access',
  'd2aab00dcf0547572276d9de4bc4a2a49d640e13',
  'pi-web-access 0.23.0',
  'c77b28221d527f298d409d7e61ade661e548f50c',
  'TypeBox 1.1.38',
  'undici 8.10.0',
]) {
  if (!webAccessNotice.includes(requiredNotice)) {
    errors.push(`packages/ext-web-access/NOTICE is missing ${requiredNotice}`);
  }
}
const mcpNotice = readFileSync(resolve(root, 'packages/ext-mcp/NOTICE'), 'utf8');
for (const requiredNotice of [
  'pi-mcp-adapter 2.21.0',
  'eaf379782fddf836828811d1b71ad85d27bc70dd',
  'pi-mcp-adapter 2.26.0',
  '5ee81b47b571b3c4ac2e68a03812c64e3f95cb98',
  '1bf36719cec478a163bb52e3390182963aab9f85',
  '@modelcontextprotocol/client 2.0.0',
  'TypeBox 1.1.38',
]) {
  if (!mcpNotice.includes(requiredNotice)) {
    errors.push(`packages/ext-mcp/NOTICE is missing ${requiredNotice}`);
  }
}
const felanApiNotice = readFileSync(resolve(root, 'packages/ext-felan-api/NOTICE'), 'utf8');
if (!felanApiNotice.includes('TypeBox 1.1.38')) {
  errors.push('packages/ext-felan-api/NOTICE is missing TypeBox 1.1.38');
}
const tuiNotice = readFileSync(resolve(root, 'apps/tui/NOTICE'), 'utf8');
for (const requiredNotice of ['@napi-rs/keyring 1.3.0', 'open 11.0.0']) {
  if (!tuiNotice.includes(requiredNotice)) {
    errors.push(`apps/tui/NOTICE is missing ${requiredNotice}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(`Validated ${packages.length} permissively licensed production package versions`);
