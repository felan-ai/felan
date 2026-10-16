import { formatSessionTerminalTitle } from '@felan-ai/ext-session-title/view';
import type { SessionSnapshot } from '@felan-ai/session-protocol';

/** Shows the session name, or the folder name without one. Writes only when the shown title changes. */
export function createSessionTitleSync(terminal: { setTitle(title: string): void }, fallbackCwd: string): (session: Pick<SessionSnapshot, 'title' | 'cwd'> | undefined) => void {
  let shown: string | undefined;
  return session => {
    const title = formatSessionTerminalTitle(session?.title, session?.cwd ?? fallbackCwd);
    if (title === shown) return;
    shown = title; terminal.setTitle(title);
  };
}
