import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonOwnership, type DaemonOwnership } from '../src/daemon/ownership.js';
import { ControlDatabase, type PersistenceBoundary } from '../src/daemon/persistence.js';

const roots: string[] = [];
const owners: DaemonOwnership[] = [];
const databases: ControlDatabase[] = [];
type Fault = (boundary: PersistenceBoundary) => void;

export async function openRemoteDatabase(fault?: Fault) {
  const directory = await mkdtemp(join(tmpdir(), 'remote-database-')); roots.push(directory);
  const owner = await acquireDaemonOwnership({ kind: 'isolated', directory, namespaceId: randomUUID() }); owners.push(owner);
  const path = join(owner.target.agentDir, 'daemon-control');
  let database = new ControlDatabase(owner, path, fault); databases.push(database);
  return {
    database, owner,
    reopen(nextFault?: Fault) {
      database.close(); database = new ControlDatabase(owner, path, nextFault); databases.push(database); return database;
    },
  };
}

export async function closeRemoteDatabases(): Promise<void> {
  for (const database of databases.splice(0)) database.close();
  for (const owner of owners.splice(0)) await owner.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}
