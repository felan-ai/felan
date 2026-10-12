import { formatSessionTerminalTitle } from '@felan-ai/ext-session-title/view';
import type { SessionSnapshot } from '@felan-ai/session-protocol';

export function presentSessionTitle(
  session: Pick<SessionSnapshot, 'title' | 'cwd'>,
  terminal: { setTitle(title: string): void },
): void {
  terminal.setTitle(formatSessionTerminalTitle(session.title, session.cwd));
}
