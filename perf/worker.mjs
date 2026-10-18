import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, isolatedRuntime, ROOT } from './lib.mjs';

const modules = { protocol: './bench-protocol.mjs', daemon: './bench-daemon.mjs', transport: './bench-transport.mjs', fanout: './fanout-burst.mjs', e2e: './probe-e2e.mjs', tui: './bench-tui.mjs', idle: './bench-idle.mjs' };
const suite = process.argv[2];
isolatedRuntime();
const results = [];
const ctx = context(process.argv.includes('--quick'), results);
await ctx.case(suite, async () => {
  if (!modules[suite]) throw new Error(`Unknown suite ${suite}`);
  await (await import(modules[suite])).run(ctx);
});
const sanitize = text => text.replaceAll(ROOT.replace(/\/$/, ''), '<repo>').replaceAll(process.env.HOME, '<isolated>');
writeFileSync(join(process.env.HOME, 'result.json'), sanitize(JSON.stringify(results, null, 2)));
// Client reconnect timers must not keep a completed worker alive.
process.exit(results.some(result => result.status === 'fail') ? 1 : 0);
