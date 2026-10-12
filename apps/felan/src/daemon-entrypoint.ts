import { fileURLToPath } from 'node:url';

export function resolveInstalledDaemonEntrypoint(): string {
  return fileURLToPath(import.meta.resolve('@felan-ai/daemon'));
}
