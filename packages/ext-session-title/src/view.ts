const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

export function formatSessionTerminalTitle(sessionName: string | undefined, cwd: string): string {
  const normalizedName = sanitizeTerminalTitlePart(sessionName ?? '');
  if (normalizedName) return normalizedName;
  const normalizedCwd = cwd.replace(/[\\/]+$/gu, '');
  if (!normalizedCwd) return sanitizeTerminalTitlePart(cwd) || '.';
  const separatorIndex = Math.max(normalizedCwd.lastIndexOf('/'), normalizedCwd.lastIndexOf('\\'));
  return sanitizeTerminalTitlePart(normalizedCwd.slice(separatorIndex + 1)) || '.';
}

function sanitizeTerminalTitlePart(value: string): string {
  return value.replace(TERMINAL_CONTROL_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim();
}
