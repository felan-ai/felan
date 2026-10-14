import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { loadHostConfig, resolveHostComposition, type HostCompositionInfo } from '@felan-ai/daemon/daemon-bootstrap';
import type { DaemonTarget } from '@felan-ai/daemon/client';
import { FELAN_VERSION } from './version.js';

export function resolveInstalledDaemonEntrypoint(): string {
  return fileURLToPath(import.meta.resolve('@felan-ai/felan/daemon-host'));
}

export async function resolveClientHostComposition(target: DaemonTarget, hostConfigPath?: string): Promise<HostCompositionInfo> {
  const agentDir = target.kind === 'production' ? resolve(target.agentDir) : join(resolve(target.directory), 'agent');
  const manager = { packageName: '@felan-ai/felan', version: FELAN_VERSION, resolveFrom: import.meta.url,
    resolveProvider: (specifier: string) => import.meta.resolve(specifier),
    packagedDefaultPath: fileURLToPath(new URL('./host.json', import.meta.url)) };
  const config = await loadHostConfig({ agentDir, ...(hostConfigPath ? { explicitPath: hostConfigPath } : {}), packagedDefaultPath: manager.packagedDefaultPath });
  const { managerPackage, managerVersion, providerDigest, configDigest } = await resolveHostComposition(config, manager);
  return { managerPackage, managerVersion, providerDigest, configDigest };
}
