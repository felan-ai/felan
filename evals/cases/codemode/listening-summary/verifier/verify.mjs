import { readFile, writeFile } from 'node:fs/promises';

let passed = false;
try {
  const result = JSON.parse(await readFile('/workspace/.eval-output/result.json', 'utf8'));
  passed = result?.grade?.passed === true;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}
await writeFile('/workspace/.harness-evals-reward.txt', passed ? '1\n' : '0\n');
console.log(passed ? 'Scenario grade passed' : 'Scenario grade failed');
if (!passed) process.exitCode = 1;
