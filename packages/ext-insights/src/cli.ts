const SUPPORTED_FLAGS = [
  { value: "--no-open", label: "--no-open", description: "Generate the report without opening it" },
  { value: "--since", label: "--since <N>d", description: "Analyze sessions from the last N days" },
  { value: "--refresh", label: "--refresh", description: "Refresh cached data when caching is available" },
  { value: "-r", label: "-r", description: "Alias for --refresh" },
  { value: "--md", label: "--md", description: "Export Markdown when Markdown output is available" },
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface InsightsCommandOptions {
  openReport: boolean;
  sinceDays?: number;
  refresh: boolean;
  markdown: boolean;
}

export type ParseInsightsArgsResult =
  | { ok: true; options: InsightsCommandOptions }
  | { ok: false; error: string };

export function parseInsightsArgs(args: string): ParseInsightsArgsResult {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const options: InsightsCommandOptions = {
    openReport: true,
    refresh: false,
    markdown: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === "--no-open") {
      options.openReport = false;
      continue;
    }

    if (token === "--refresh" || token === "-r") {
      options.refresh = true;
      continue;
    }

    if (token === "--md") {
      options.markdown = true;
      continue;
    }

    if (token === "--since") {
      const value = tokens[i + 1];
      if (!value) {
        return { ok: false, error: "Missing value for --since. Use --since <N>d, for example --since 7d." };
      }

      const days = parseSinceDays(value);
      if (!days) {
        return { ok: false, error: `Invalid --since value \"${value}\". Use a positive day range like 7d or 30d.` };
      }

      options.sinceDays = days;
      i++;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option \"${token}\". Supported options: ${supportedUsage()}.` };
    }

    return { ok: false, error: `Unexpected argument \"${token}\". Usage: /insights ${supportedUsage()}.` };
  }

  return { ok: true, options };
}

export function getSinceCutoff(options: InsightsCommandOptions, now = new Date()): Date | undefined {
  if (!options.sinceDays) return undefined;
  return new Date(now.getTime() - options.sinceDays * MS_PER_DAY);
}

export function getInsightsArgumentCompletions(argumentPrefix: string) {
  const currentToken = argumentPrefix.trim().split(/\s+/).pop() ?? "";
  const prefix = currentToken.startsWith("-") ? currentToken : "";
  return SUPPORTED_FLAGS.filter(flag => flag.value.startsWith(prefix));
}

function parseSinceDays(value: string): number | undefined {
  const match = /^(\d+)d$/.exec(value);
  if (!match) return undefined;
  const days = Number(match[1]);
  return Number.isSafeInteger(days) && days > 0 ? days : undefined;
}

function supportedUsage(): string {
  return "[--no-open] [--since <N>d] [--refresh|-r] [--md]";
}
