import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkMetadata, checkBusiness, safeVerifierValue } from './check.mjs';
const root = process.env.TURN_CLASSIFICATION_WORKSPACE ?? '/workspace';
const id = process.argv[2];
const failures = [];
let result;
await mkdir(join(root,'.eval-output'), { recursive: true });
try {
  result = JSON.parse(await readFile(join(root,'.eval-output/result.json'),'utf8'));
} catch (error) {
  const missing = error?.code === 'ENOENT';
  failures.push({ check: missing ? 'result.artifact.present' : 'result.artifact.valid',
    category: missing ? 'missing-artifact' : 'invalid-input',
    assertion: missing ? 'result.json is missing' : 'result.json is invalid' });
}
if (result !== undefined) {
  try { checkMetadata(result,id); }
  catch (error) { failures.push(safeFailure(error, 'metadata', 'metadata.result.valid')); }
  try { await checkBusiness(join(root,'project'),id); }
  catch (error) { failures.push(safeFailure(error, 'business', 'business.result.matches')); }
}
const diagnostics = { schemaVersion: 1, status: failures.length ? 'failed' : 'passed', failures };
await writeFile(join(root,'.eval-output/verifier-diagnostics.json'), JSON.stringify(diagnostics, null, 2) + '\n');
await writeFile(join(root,'.harness-evals-reward.json'), JSON.stringify({ reward: failures.length ? 0 : 1 }) + '\n');
for (const failure of failures) console.error(`${failure.category}: ${failure.assertion}`);
if (failures.length) process.exitCode = 1;

function safeFailure(error, category, fallbackCheck) {
  const message = error instanceof Error ? error.message.split('\n', 1)[0] : '';
  const assertion = /^(?:metadata:|Inference |Planning |Implementation |Missing root |Benchmark policy |Unknown benchmark |Unexpected change(?::| to)|business:)/u.test(message)
    ? message.replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
      .replace(/Unexpected change(?::| to).*$/u, 'Unexpected change to a protected project file').slice(0, 200)
    : category === 'metadata' ? 'benchmark metadata is invalid' : 'business result does not match the fixture';
  const check = typeof error?.safeCheck === 'string' && /^[a-z][a-z0-9.-]{0,63}$/u.test(error.safeCheck)
    ? error.safeCheck : fallbackCheck;
  return { check, category, assertion,
    ...(Object.hasOwn(error ?? {}, 'safeExpected') ? { expected: safeVerifierValue(error.safeExpected) } : {}),
    ...(Object.hasOwn(error ?? {}, 'safeActual') ? { actual: safeVerifierValue(error.safeActual) } : {}) };
}
