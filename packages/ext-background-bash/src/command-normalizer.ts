const SHELL_VALUE_PATTERN = String.raw`(?:"(?:\\.|[^"])*"|'(?:'\\''|[^'])*'|[^\s;]+)`;
const RTK_DB_EXPORT_PATTERN = new RegExp(
  String.raw`^\s*export\s+RTK_DB_PATH=${SHELL_VALUE_PATTERN}\s*;\s*([\s\S]+)$`,
  'u',
);
const LEADING_ENV_ASSIGNMENTS_BEFORE_RTK_PATTERN = new RegExp(
  String.raw`^((?:[A-Za-z_][A-Za-z0-9_]*=${SHELL_VALUE_PATTERN}\s+)*)rtk\s+([\s\S]+)$`,
  'u',
);

export interface NormalizedBackgroundCommand {
  command: string;
  originalCommand?: string;
  rtkRewriteRemoved: boolean;
}

export function normalizeBackgroundCommand(command: string): NormalizedBackgroundCommand {
  const exportMatch = command.match(RTK_DB_EXPORT_PATTERN);
  if (!exportMatch) return { command, rtkRewriteRemoved: false };

  const afterExport = exportMatch[1] ?? '';
  const rtkMatch = afterExport.match(LEADING_ENV_ASSIGNMENTS_BEFORE_RTK_PATTERN);
  if (!rtkMatch) return { command, rtkRewriteRemoved: false };

  const envPrefix = rtkMatch[1] ?? '';
  const rawCommand = rtkMatch[2] ?? '';
  const normalized = `${envPrefix}${rawCommand}`.trim();
  if (!normalized) return { command, rtkRewriteRemoved: false };

  return {
    command: normalized,
    originalCommand: command,
    rtkRewriteRemoved: true,
  };
}
