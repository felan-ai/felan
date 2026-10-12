import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { acquireDaemonOwnership } from '../../dist/daemon/ownership.js';

const mounts = process.platform === 'linux' ? readFileSync('/proc/self/mountinfo', 'utf8').split('\n') : [];
if (process.platform !== 'linux' || process.getuid() !== 0 || !existsSync('/.dockerenv') || process.env.FELAN_S103_DISPOSABLE_ACCOUNT_TEST !== '1'
  || !mounts.some(line => line.split(' ')[4] === '/tmp' && line.includes(' - tmpfs '))
  || mounts.some(line => ['/work', '/evidence', '/root'].includes(line.split(' ')[4]))) {
  throw new Error('Production ownership tests require the explicit disposable UID-0 container with private tmpfs and no host work/config mounts. Never run on the host.');
}

const directory = mkdtempSync('/tmp/s103-production-');
const a = { kind: 'production', agentDir: join(directory, 'a'), storeRoots: [] };
const b = { kind: 'production', agentDir: join(directory, 'b'), storeRoots: [] };
let ledgerPath;
async function cycle(target) {
  const owner = await acquireDaemonOwnership(target);
  ledgerPath = join(owner.target.accountDirectory, 'claims.json');
  const instanceId = owner.instanceId;
  await owner.release();
  return instanceId;
}
const ledger = () => JSON.parse(readFileSync(ledgerPath, 'utf8'));

try {
  await test('unchanged production stores survive more than 1024 acquisition/release cycles', async () => {
    let previous;
    for (let i = 0; i < 1030; i++) {
      const current = await cycle(a);
      assert.notEqual(current, previous);
      previous = current;
    }
    assert.equal(ledger().claims.length, 1);
    assert.equal(ledger().claims[0].instanceId, previous);
  });

  await test('pre-existing duplicate history is compacted before the namespace capacity check', async () => {
    const current = ledger();
    current.claims = Array.from({ length: 1024 }, () => ({ ...current.claims[0], instanceId: randomUUID() }));
    const encoded = JSON.stringify(current);
    assert(Buffer.byteLength(encoded) <= 1_048_576);
    writeFileSync(ledgerPath, encoded);
    const instanceId = await cycle(a);
    assert.equal(ledger().claims.length, 1);
    assert.equal(ledger().claims[0].instanceId, instanceId);
  });

  await test('distinct former production roots remain excluded from isolated targets', async () => {
    await cycle(b);
    assert.equal(ledger().claims.length, 2);
    await assert.rejects(acquireDaemonOwnership({ kind: 'isolated', directory: a.agentDir, namespaceId: 'former-root' }), { code: 'target_mismatch' });
  });

  await test('different inode generations at the same path retain their former-store protection', async () => {
    const retired = join(directory, 'retired-a');
    renameSync(a.agentDir, retired);
    mkdirSync(a.agentDir, { mode: 0o700 });
    await cycle(a);
    assert.equal(ledger().claims.length, 3);
    await assert.rejects(acquireDaemonOwnership({ kind: 'isolated', directory: retired, namespaceId: 'retired-inode' }), { code: 'target_mismatch' });
    await cycle(b);
    assert.equal(ledger().claims.length, 3);
  });
  console.log(JSON.stringify({ productionCycles: 1030, duplicateHistoryCompacted: 1024, finalDistinctClaims: ledger().claims.length, formerRootsProtected: true }));
} finally { rmSync(directory, { recursive: true, force: true }); }
