export const DAEMON_COMMANDS = ['status', 'start', 'foreground', 'stop', 'restart', 'logs'] as const;

const TOP_LEVEL_COMMANDS = ['daemon', 'update', 'savings', 'acp'] as const;

export function suggestCommand(input: string, candidates: readonly string[]): string | undefined {
  if (!/^[a-z]{3,}$/u.test(input) || candidates.includes(input)) return undefined;
  const matches = candidates.filter(candidate => candidate.length >= 4
    && Math.abs(candidate.length - input.length) <= 1 && editDistance(input, candidate) === 1);
  return matches.length === 1 ? matches[0] : undefined;
}

export function suggestTopLevelCommand(args: readonly string[]): string | undefined {
  const input = args[0];
  if (!input || args.includes('--')) return undefined;
  const candidate = suggestCommand(input, TOP_LEVEL_COMMANDS);
  if (!candidate) return undefined;
  if (args.length === 1) return isTransposition(input, candidate) ? candidate : undefined;
  if (candidate === 'daemon') {
    const hasAction = DAEMON_COMMANDS.includes(args[1] as typeof DAEMON_COMMANDS[number]);
    const options = args.slice(hasAction ? 2 : 1);
    if (!hasAction && options.length === 0) return undefined;
    return hasOnlyOptions(options, ['--force', '--help', '-h'], ['--daemon-runtime', '--host-config']) ? candidate : undefined;
  }
  if (candidate === 'savings') {
    return hasOnlyOptions(args.slice(1), ['--project', '--daily', '--monthly', '--help'], ['--session', '--format']) ? candidate : undefined;
  }
  return undefined;
}

function hasOnlyOptions(args: readonly string[], flags: readonly string[], valueFlags: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (flags.includes(arg)) continue;
    if (!valueFlags.includes(arg) || !args[index + 1] || args[index + 1]!.startsWith('-')) return false;
    index++;
  }
  return true;
}

function isTransposition(input: string, candidate: string): boolean {
  if (input.length !== candidate.length) return false;
  const index = [...input].findIndex((letter, position) => letter !== candidate[position]);
  return index >= 0 && input[index] === candidate[index + 1] && input[index + 1] === candidate[index]
    && input.slice(index + 2) === candidate.slice(index + 2);
}

function editDistance(input: string, candidate: string): number {
  const rows = Array.from({ length: input.length + 1 }, (_, index) => [index]);
  rows[0] = Array.from({ length: candidate.length + 1 }, (_, index) => index);
  for (let i = 1; i <= input.length; i++) {
    for (let j = 1; j <= candidate.length; j++) {
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (input[i - 1] === candidate[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && input[i - 1] === candidate[j - 2] && input[i - 2] === candidate[j - 1]) {
        rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1);
      }
    }
  }
  return rows[input.length]![candidate.length]!;
}
