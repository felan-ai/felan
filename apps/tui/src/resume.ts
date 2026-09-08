import { join } from 'node:path';
import { initTheme, SessionManager } from '@earendil-works/pi-coding-agent';
import { selectLocalSession } from './session-picker.js';
import { getLocalAgentDir } from './runtime.js';
import { createLocalSettingsManager } from './settings.js';
import { listLocalSessionHistory } from './memory/history.js';
import { MemoryHistoryView } from './memory/history-view.js';

export async function selectLocalSessionManager(): Promise<SessionManager | undefined> {
  const cwd = process.cwd();
  const agentDir = getLocalAgentDir();
  const settings = createLocalSettingsManager(cwd, agentDir);
  const sessionDir = settings.getSessionDir() ?? join(agentDir, 'sessions');
  const history = await listLocalSessionHistory({ cwd, agentDir, sessionDir });
  const path = await selectLocalSession({
    currentSessions: history.currentSessions,
    allSessions: history.allSessions,
    agentDir,
    showHardwareCursor: settings.getShowHardwareCursor(),
    clearOnShrink: settings.getClearOnShrink(),
    ...(history.memorySessions.size > 0 ? {
      createPicker: (tui, done) => {
        initTheme(settings.getTheme(), false);
        return new MemoryHistoryView(tui, history, done);
      },
    } satisfies Pick<Parameters<typeof selectLocalSession>[0], 'createPicker'> : {}),
  });
  return path ? SessionManager.open(path, sessionDir) : undefined;
}

export async function openLocalSessionManager(
  sessionId: string,
  sessionDirOverride?: string,
): Promise<SessionManager> {
  const sessionManager = await findLocalSessionManager(sessionId, sessionDirOverride);
  if (!sessionManager) throw new Error(`No session found matching '${sessionId}'`);
  return sessionManager;
}

export async function findLocalSessionManager(
  sessionId: string,
  sessionDirOverride?: string,
): Promise<SessionManager | undefined> {
  const cwd = process.cwd();
  const agentDir = getLocalAgentDir();
  const sessionDir = sessionDirOverride
    ?? createLocalSettingsManager(cwd, agentDir).getSessionDir()
    ?? join(agentDir, 'sessions');
  const sessions = await SessionManager.listAll(sessionDir);
  const session = sessions.find(({ id }) => id === sessionId)
    ?? sessions.find(({ id }) => id.startsWith(sessionId));
  return session ? SessionManager.open(session.path, sessionDir) : undefined;
}
