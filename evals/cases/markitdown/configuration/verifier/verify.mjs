import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const workspace = process.cwd();
const expected = {
  service: 'orion-gateway',
  port: 4317,
  logLevel: 'warn',
  retries: 4,
  regions: ['eu-west-1', 'us-east-2'],
};

let actual;
try {
  actual = JSON.parse(await readFile(join(workspace, 'config', 'runtime.json'), 'utf8'));
} catch {
  actual = undefined;
}

const pass = isDeepStrictEqual(actual, expected);
await writeFile(join(workspace, '.harness-evals-reward.txt'), pass ? '1\n' : '0\n');
console.log(pass ? '1' : '0');
process.exitCode = pass ? 0 : 1;
