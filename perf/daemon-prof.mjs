import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import { isolatedRuntime, ROOT } from './lib.mjs';

if (process.env.DPROF_FILE && process.argv.some(arg => arg.endsWith('/daemon-host.js'))) {
  isolatedRuntime();
  const session = new Session();
  session.connect();
  session.post('Profiler.setSamplingInterval', { interval: 200 }, () => session.post('Profiler.enable', () => session.post('Profiler.start')));
  setTimeout(() => session.post('Profiler.stop', (error, result) => {
    if (!error) {
      for (const node of result.profile.nodes) node.callFrame.url = node.callFrame.url.replace(ROOT, '<repo>/').replace(process.env.HOME, '<isolated>');
      writeFileSync(process.env.DPROF_FILE, JSON.stringify(result.profile));
    }
    session.disconnect();
  }), Number(process.env.DPROF_MS || 6000)).unref();
}
