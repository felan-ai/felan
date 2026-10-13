import { guardAuthenticationParent } from '../../dist/providers/setup/parent-guard.js';

const guard = guardAuthenticationParent();
guard.ref();
guard.once('online', () => {
  process.stdout.write(`${process.pid}\n`, () => { for (;;) {} });
});
