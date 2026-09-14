const BLOCKED_COMMANDS = new Set([
  'install', 'upgrade', 'doctor', 'mcp', 'chat', 'dashboard', 'stream', 'plugin',
  'plugins', 'batch', 'confirm', 'deny', 'webmcp', 'auth', 'state', 'profile',
  'profiles', 'restore', 'session', 'config', 'addinitscript',
  'removeinitscript',
]);

type OptionKind = 'switch' | 'boolean' | 'value';
type OptionRules = Readonly<Record<string, OptionKind>>;

const CONNECTION_OPTIONS: OptionRules = {
  '--auto-connect': 'boolean', '--autoconnect': 'boolean', '--cdp': 'value',
};
const OWNED_OPTIONS: OptionRules = {
  '--session': 'value', '--namespace': 'value', '--idle-timeout': 'value',
  '--json': 'switch', '--content-boundaries': 'switch', '--max-output': 'value',
  '--config': 'value', '--allowed-domains': 'value', '--action-policy': 'value',
  '--confirm-actions': 'value', '--confirm-interactive': 'boolean',
  '--allow-file-access': 'boolean', '--profile': 'value', '--state': 'value',
  '--session-name': 'value', '--pin-tab': 'boolean', '--no-pin-tab': 'boolean',
  '--no-auto-dialog': 'boolean', '--no-webmcp': 'boolean',
  '--executable-path': 'value', '--extension': 'value', '--init-script': 'value',
  '--enable': 'value', '--args': 'value', '--provider': 'value', '-p': 'value',
  '--engine': 'value', '--plugins': 'value', '--plugin': 'value',
};
const GLOBAL_VALUE_OPTIONS = new Set([
  '--headers', '--proxy', '--proxy-bypass', '--user-agent', '--device',
  '--color-scheme', '--download-path', '--screenshot-dir', '--screenshot-quality',
  '--screenshot-format', '--ca-cert', '--model',
]);

const SCREENSHOT_OPTIONS: OptionRules = {
  '--full': 'switch', '-f': 'switch', '--annotate': 'boolean',
  '--screenshot-format': 'value', '--screenshot-quality': 'value',
};
const KNOWN_BROWSER_COMMANDS = new Set([
  'a11y', 'auth', 'back', 'batch', 'chat', 'check', 'click', 'clipboard', 'close',
  'confirm', 'connect', 'console', 'cookies', 'dashboard', 'deny', 'diff',
  'download', 'drag', 'errors', 'eval', 'fill', 'find', 'focus', 'forward', 'get',
  'goto', 'highlight', 'hover', 'inspect', 'is', 'key', 'keyboard', 'keydown',
  'keyup', 'mcp', 'mouse', 'navigate', 'network', 'open', 'pdf', 'plugin',
  'plugins', 'press', 'profile', 'profiles', 'profiler', 'pushstate', 'react',
  'read', 'record', 'reload', 'removeinitscript', 'restore', 'screenshot', 'scroll',
  'scrollinto', 'scrollintoview', 'select', 'session', 'set', 'skills', 'snapshot',
  'state', 'storage', 'stream', 'trace', 'type', 'uncheck', 'upload', 'vitals',
  'wait', 'webmcp', 'window',
]);

export function findBrowserCommand(args: readonly string[]): string | undefined {
  const first = args[0];
  return first && /^[a-z][a-z0-9-]*$/u.test(first) ? first : undefined;
}

export function validateBrowserCommand(args: readonly string[]): string {
  const command = findBrowserCommand(args);
  if (!command) {
    throw new Error('browser run args must start with an exact lowercase agent-browser command, without whitespace; place global options after the command.');
  }
  if (args.some(arg => arg.includes('\0'))) throw new Error('browser args cannot contain NUL bytes');
  if (BLOCKED_COMMANDS.has(command)) {
    throw new Error(`The browser tool does not run ${command}; use Felan's explicit dependency onboarding or host controls.`);
  }
  if (command === 'connect' || command === 'autoconnect') {
    throw new Error('Existing-browser attachment requires browser_authorize; do not pass connection commands to browser.');
  }
  if (command === 'skills') {
    throw new Error('Use browser operation "skill" to retrieve version-matched agent-browser instructions.');
  }
  // Native global flags are recognized even inside selector and text positions.
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    const option = arg.split('=', 1)[0]!;
    if (option === '--') {
      throw new Error('The browser tool does not accept the -- option terminator because Felan enforces trailing session and output policy.');
    }
    if (Object.hasOwn(CONNECTION_OPTIONS, option)) {
      throw new Error('Existing-browser attachment requires browser_authorize; do not pass CDP or auto-connect options to browser.');
    }
    if (Object.hasOwn(OWNED_OPTIONS, option) || option === '--restore' || option.startsWith('--restore-')) {
      throw new Error(`The browser tool owns ${option}; omit it from args.`);
    }
    if (['close', 'quit', 'exit'].includes(command) && ['--all', '-a'].includes(option)) {
      throw new Error('The browser tool closes only its own Felan session; omit --all.');
    }
    if (GLOBAL_VALUE_OPTIONS.has(option)) {
      if (arg !== option) throw new Error(`Use separate tokens for ${option} and its value; the reviewed CLI does not support this equals form.`);
      // A missing native global value would consume Felan's appended --session.
      const value = args[index + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new Error(`Browser option ${option} requires a non-option value.`);
      }
    }
  }
  return command;
}

export function normalizeAttachedBrowserCommand(args: readonly string[]): readonly string[] {
  if (args.some(arg => arg.includes('\0'))) throw new Error('browser args cannot contain NUL bytes');
  const normalized: string[] = [];
  let commandSeen = false;

  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    const option = token.split('=', 1)[0]!;
    const kind = CONNECTION_OPTIONS[option] ?? OWNED_OPTIONS[option]
      ?? (option.startsWith('--restore-') ? 'value' : undefined);

    if (option === '--restore') {
      if (!token.includes('=')) {
        const next = args[index + 1];
        const following = args[index + 2];
        if (next && !next.startsWith('-') && ((commandSeen && !KNOWN_BROWSER_COMMANDS.has(next))
          || (!commandSeen && following && KNOWN_BROWSER_COMMANDS.has(following)))) index++;
      }
      continue;
    }
    if (kind) {
      if (token.includes('=')) continue;
      const next = args[index + 1];
      if (kind === 'value') {
        if (!next || next.startsWith('-') || (!commandSeen && KNOWN_BROWSER_COMMANDS.has(next))) {
          throw new Error(`Browser option ${option} requires a non-option value.`);
        }
        index++;
      } else if (kind === 'boolean' && (next === 'true' || next === 'false')) index++;
      continue;
    }

    normalized.push(token);
    if (!commandSeen && /^[a-z][a-z0-9-]*$/u.test(token)) commandSeen = true;
  }

  const commandIndex = findAttachedCommandIndex(normalized);
  const reordered = commandIndex > 0
    ? [...normalized.slice(commandIndex), ...normalized.slice(0, commandIndex)]
    : normalized;
  const command = validateBrowserCommand(reordered);
  if (command === 'get' && reordered[1] === 'cdp-url') {
    throw new Error('The authorized browser connection endpoint is not exposed to browser commands.');
  }
  return reordered;
}

function findAttachedCommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith('-') || /^-\d+$/u.test(token)) return index;
    const option = token.split('=', 1)[0]!;
    if (GLOBAL_VALUE_OPTIONS.has(option) && !token.includes('=')) index++;
  }
  return 0;
}

export function inspectScreenshotArguments(args: readonly string[]): { path?: string; format: string } {
  const { positional, options } = parseOptions(args.slice(1), {
    ...SCREENSHOT_OPTIONS,
    '--screenshot-dir': 'value', '--headed': 'boolean', '--debug': 'boolean',
    '--hide-scrollbars': 'boolean', '--ignore-https-errors': 'boolean',
    '--proxy': 'value', '--proxy-bypass': 'value', '--user-agent': 'value',
    '--color-scheme': 'value', '--download-path': 'value', '--ca-cert': 'value',
    '--no-ca-cert': 'boolean', '--webgpu': 'boolean', '--headers': 'value',
  });
  requireCount('screenshot', positional, 0, 2);
  validateScreenshotOptions(options);
  const path = positional[1] ?? (positional[0] !== undefined && isScreenshotPath(positional[0]) ? positional[0] : undefined);
  return { ...(path === undefined ? {} : { path }), format: options.get('--screenshot-format') ?? 'png' };
}

function parseOptions(args: readonly string[], rules: OptionRules): {
  positional: string[];
  options: Map<string, string>;
  firstOption?: number;
} {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let firstOption: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith('-') || /^-\d+$/u.test(token)) { positional.push(token); continue; }
    const name = token.split('=', 1)[0]!;
    if (!Object.hasOwn(rules, name)) throw new Error(`Unsupported browser option ${name} for this command.`);
    if (token !== name) throw new Error(`Use separate tokens for ${name} and its value; the reviewed CLI does not support this equals form.`);
    if (options.has(name)) throw new Error(`Duplicate browser option ${name}.`);
    firstOption ??= positional.length;
    const kind = rules[name];
    const next = args[index + 1];
    if (kind === 'value') {
      if (next === undefined || next === '' || next.startsWith('-')) throw new Error(`Browser option ${name} requires a non-option value.`);
      options.set(name, next);
      index++;
    } else if (kind === 'boolean' && (next === 'true' || next === 'false')) {
      options.set(name, next);
      index++;
    } else options.set(name, 'true');
  }
  return { positional, options, ...(firstOption === undefined ? {} : { firstOption }) };
}

function isScreenshotPath(value: string): boolean {
  const relative = value.startsWith('./') || value.startsWith('../');
  const selector = !relative && /^[.#@]/u.test(value);
  return !selector && (relative || value.includes('/') || /\.(?:png|jpg|jpeg|webp)$/u.test(value));
}

function validateScreenshotOptions(options: ReadonlyMap<string, string>): void {
  const format = options.get('--screenshot-format');
  if (format !== undefined && format !== 'png' && format !== 'jpeg') throw new Error('Screenshot format must be png or jpeg.');
  validateIntegerOptions(options, ['--screenshot-quality'], 0, 100);
}

function validateIntegerOptions(options: ReadonlyMap<string, string>, names: readonly string[], minimum: number, maximum: number): void {
  for (const name of names) {
    const value = options.get(name);
    if (value !== undefined) requireInteger(value, minimum, maximum);
  }
}

function requireInteger(value: string, minimum: number, maximum: number): void {
  if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Browser command requires an integer between ${minimum} and ${maximum}.`);
  }
}

function requireCount(command: string, args: readonly string[], minimum: number, maximum: number): void {
  if (args.length < minimum || args.length > maximum) throw new Error(`Unsupported arguments for browser ${command}.`);
}
