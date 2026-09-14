import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const workspace = process.cwd();
const path = join(workspace, 'src', 'calculator.js');
const source = await readFile(path, 'utf8').catch(() => '');
let implemented = false;
try {
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  implemented = typeof module.add === 'function'
    && [[2, 3, 5], [-4, 1.5, -2.5], [0, 0, 0]].every(([left, right, expected]) => module.add(left, right) === expected);
} catch {}
await writeFile(join(workspace, '.harness-evals-reward.txt'), `${implemented ? 1 : 0}\n`);
console.log(implemented ? '1' : '0');
process.exitCode = implemented ? 0 : 1;
