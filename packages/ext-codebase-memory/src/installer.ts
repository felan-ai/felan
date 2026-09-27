import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import { CODEBASE_MEMORY_VERSION, detectCbm, type CbmDetection } from './client.js';
import { joinRuntimePath } from './runtime-path.js';

const INSTALLER_COMMIT = '8972ea69c6ad94b1ef1d4ffbf0a92d78d2db1798';
const INSTALLER_SHA256 = '13049c7cc51bc508d68b8ecb8a9fd9574ecb7c6f2c9dd5a19bf7d4c187321145';
const INSTALLER_URL = `https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/${INSTALLER_COMMIT}/install.sh`;
const RELEASE_URL = `https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CODEBASE_MEMORY_VERSION}`;

export async function installManagedCbm(
  runtime: AgentRuntime,
  onStatus: (message: string) => void = () => {},
): Promise<CbmDetection> {
  const session = runtime.storage('session');
  const installId = randomUUID();
  const relative = `codebase-memory/install-${installId}.sh`;
  const installerHomeRelative = `codebase-memory/install-home-${installId}`;
  const script = joinRuntimePath(session.root, relative);
  const installerHome = joinRuntimePath(session.root, installerHomeRelative);
  const binDir = joinRuntimePath(runtime.storage('agent').root, 'codebase-memory/bin');
  await session.mkdir('codebase-memory', { recursive: true });
  await session.mkdir(installerHomeRelative, { recursive: true });
  await runtime.storage('agent').mkdir('codebase-memory/bin', { recursive: true });
  try {
    onStatus('Downloading the pinned Codebase Memory installer...');
    const downloaded = await runtime.exec('curl', [
      '--proto', '=https', '--tlsv1.2', '--fail', '--silent', '--show-error', '--location',
      '--max-filesize', String(128 * 1024), INSTALLER_URL, '--output', script,
    ], { cwd: runtime.cwd, timeout: 30_000, maxOutputBytes: 64 * 1024 });
    if (!successful(downloaded)) return unavailable(downloaded.stderr || downloaded.stdout || 'download failed');
    const bytes = await session.readFile(relative, { maxBytes: 128 * 1024 + 1 });
    if (createHash('sha256').update(bytes).digest('hex') !== INSTALLER_SHA256) {
      return unavailable('Installer SHA-256 mismatch; refusing to execute it.');
    }
    onStatus(`Installing Codebase Memory ${CODEBASE_MEMORY_VERSION} in Felan agent storage...`);
    const installed = await runtime.shell(`/bin/bash '${script.replaceAll("'", `'"'"'`)}' --dir '${binDir.replaceAll("'", `'"'"'`)}' --skip-config`, {
      cwd: runtime.cwd,
      env: {
        CBM_CACHE_DIR: joinRuntimePath(installerHome, 'cache'),
        CBM_DOWNLOAD_URL: RELEASE_URL,
        HOME: installerHome,
      },
      maxOutputBytes: 5 * 1024 * 1024,
      shellFlavor: 'posix',
      timeout: 180_000,
    });
    if (!successful(installed)) return unavailable(installed.stderr || installed.stdout || 'installer failed');
    return detectCbm(runtime);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  } finally {
    await Promise.allSettled([
      session.remove(relative),
      session.remove(installerHomeRelative, { recursive: true }),
    ]);
  }
}

function successful(result: ExecResult): boolean { return result.code === 0 && !result.killed; }
function unavailable(reason: string): CbmDetection {
  return { available: false, reason: `Managed Codebase Memory installation failed: ${reason.slice(0, 500)}` };
}
