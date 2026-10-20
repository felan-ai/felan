import { createInterface } from 'node:readline';

let hold = false;
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const value = JSON.parse(line);
  if (value.kind === 'start') {
    hold = value.provider === 'hold';
    process.stdout.write(`${JSON.stringify({ kind: 'prompt', prompt: { id: 'fixture-key', kind: 'input', secret: true, message: 'Fixture key' } })}\n`);
  } else if (value.kind === 'answer' && !hold) {
    process.stdout.write(`${JSON.stringify({ kind: 'done' })}\n`, () => process.exit(0));
  }
});
process.on('SIGTERM', () => {});
