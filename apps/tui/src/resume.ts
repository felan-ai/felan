import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { selectLocalSession } from './session-picker.js';
import { getLocalAgentDir } from './runtime.js';
import { createLocalSettingsManager } from './settings.js';

export async function selectLocalSessionManager(): Promise<SessionManager | undefined> {
  const cwd = process.cwd();
  const agentDir = getLocalAgentDir();
  const settings = createLocalSettingsManager(cwd, agentDir);
  const sessionDir = settings.getSessionDir() ?? join(agentDir, 'sessions');
  const [currentSessions, allSessions] = await Promise.all([
    SessionManager.list(cwd, sessionDir),
    SessionManager.listAll(sessionDir),
  ]);
  const path = await selectLocalSession({
    currentSessions,
    allSessions,
    agentDir,
    showHardwareCursor: settings.getShowHardwareCursor(),
    clearOnShrink: settings.getClearOnShrink(),
  });
  return path ? SessionManager.open(path, sessionDir) : undefined;
}

export async function openLocalSessionManager(
  sessionId: string,
  sessionDirOverride?: string,
): Promise<SessionManager> {
  const cwd = process.cwd();
  const agentDir = getLocalAgentDir();
  const sessionDir = sessionDirOverride
    ?? createLocalSettingsManager(cwd, agentDir).getSessionDir()
    ?? join(agentDir, 'sessions');
  const sessions = await SessionManager.listAll(sessionDir);
  const session = sessions.find(({ id }) => id === sessionId)
    ?? sessions.find(({ id }) => id.startsWith(sessionId));
  if (!session) throw new Error(`No session found matching '${sessionId}'`);
  return SessionManager.open(session.path, sessionDir);
}
