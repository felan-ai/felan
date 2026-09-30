import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const evalsRoot = resolve(import.meta.dirname, '..');
const provenancePath = resolve(evalsRoot, 'source-image.json');
if (!existsSync(provenancePath)) {
  throw new Error('Current-source image is not built; run pnpm --dir evals build:source first');
}
const { image } = JSON.parse(readFileSync(provenancePath, 'utf8'));
if (typeof image !== 'string' || !/^felan-evals-source:[a-f0-9]{24}$/u.test(image)) {
  throw new Error('source-image.json has invalid image metadata');
}
const args = process.argv.slice(2);
const config = args.some(arg => arg === '--config' || arg.startsWith('--config=')) ? [] : ['--config', 'felan-extension-evals.yaml'];
const result = spawnSync('pnpm', ['exec', 'harness-evals', ...args, ...config, '--image', image], {
  cwd: evalsRoot,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
