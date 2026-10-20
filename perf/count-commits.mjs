import { appendFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { now, isolatedRuntime } from './lib.mjs';

if (process.env.COMMIT_LOG && process.argv.some(arg => arg.endsWith('/daemon-host.js'))) {
  isolatedRuntime();
  const { DatabaseSync } = await import('node:sqlite');
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.trim().replace(/;$/, '').toUpperCase() !== 'COMMIT') return exec.call(this, sql);
    const start = now();
    try { return exec.call(this, sql); }
    finally { appendFileSync(process.env.COMMIT_LOG, JSON.stringify({ kind: 'commit', start, duration: now() - start }) + '\n'); }
  };
  const fsync = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    const start = now();
    try { return fsync.call(this, fd); }
    finally { appendFileSync(process.env.COMMIT_LOG, JSON.stringify({ kind: 'fsync', start, duration: now() - start }) + '\n'); }
  };
  syncBuiltinESMExports();
}
