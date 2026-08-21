import type { RunLocalFelanOptions } from './application.js';
import { runFelanUpdate } from './update.js';
import { FELAN_VERSION } from './version.js';

export interface CliDependencies {
  readonly writeOutput?: (line: string) => void;
  readonly writeError?: (line: string) => void;
  readonly launch?: (options: RunLocalFelanOptions) => Promise<void>;
  readonly update?: () => Promise<number>;
}

const help = `Usage: felan [options] [message]

Options:
  -c, --continue     Continue the most recent session for this directory
  --diagnostics      Print local runtime versions and configuration mode
  update             Update a global npm installation of Felan
  -h, --help         Show this help
  -v, --version      Print the Felan version
  --verbose          Show verbose startup details`;

export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const writeOutput = dependencies.writeOutput ?? ((line) => console.log(line));
  const writeError = dependencies.writeError ?? ((line) => console.error(line));
  if (args[0] === 'update') {
    if (args.length !== 1) {
      writeError('Usage: felan update');
      return 1;
    }
    return dependencies.update?.() ?? runFelanUpdate({ writeOutput, writeError });
  }

  let continueRecent = false;
  let verbose = false;
  const messageParts: string[] = [];
  let positionalOnly = false;

  for (const argument of args) {
    if (positionalOnly) {
      messageParts.push(argument);
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
    } else if (argument === '-c' || argument === '--continue') {
      continueRecent = true;
    } else if (argument === '--verbose') {
      verbose = true;
    } else if (argument === '-h' || argument === '--help') {
      writeOutput(help);
      return 0;
    } else if (argument === '-v' || argument === '--version') {
      writeOutput(FELAN_VERSION);
      return 0;
    } else if (argument === '--diagnostics') {
      const [{ AGENT_CORE_VERSION }, { VERSION: PI_VERSION }] = await Promise.all([
        import('@felan-ai/agent-core'),
        import('@earendil-works/pi-coding-agent'),
      ]);
      writeOutput(`Felan version: ${FELAN_VERSION}`);
      writeOutput(`Agent Core version: ${AGENT_CORE_VERSION}`);
      writeOutput(`Pi version: ${PI_VERSION}`);
      writeOutput(`Node version: ${process.versions.node}`);
      writeOutput('Runtime: host');
      writeOutput('Credentials: local');
      return 0;
    } else if (argument.startsWith('-')) {
      writeError(`Unknown option: ${argument}`);
      return 1;
    } else {
      messageParts.push(argument);
    }
  }

  const launch = dependencies.launch ?? (async (options: RunLocalFelanOptions) => {
    const { runLocalFelan } = await import('./application.js');
    await runLocalFelan(options);
  });
  await launch({
    continueRecent,
    verbose,
    ...(messageParts.length === 0 ? {} : { initialMessage: messageParts.join(' ') }),
  });
  return 0;
}
