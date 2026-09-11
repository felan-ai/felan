const BLOCKED_COMMANDS = new Set([
  'install', 'upgrade', 'doctor', 'mcp', 'chat', 'dashboard', 'stream', 'plugin',
  'plugins', 'batch', 'confirm', 'deny', 'webmcp', 'auth', 'state', 'profile',
  'profiles', 'restore', 'session', 'config', 'addinitscript',
  'removeinitscript',
]);

const CONNECTION_OPTIONS = new Set(['--auto-connect', '--autoconnect', '--cdp']);
const OWNED_OPTIONS = new Set([
  '--session', '--namespace', '--idle-timeout', '--json', '--content-boundaries',
  '--max-output', '--config', '--allowed-domains', '--action-policy',
  '--confirm-actions', '--confirm-interactive', '--allow-file-access',
  '--profile', '--state', '--session-name', '--pin-tab', '--no-pin-tab',
  '--no-auto-dialog', '--no-webmcp', '--executable-path', '--extension',
  '--init-script', '--enable', '--args', '--provider', '-p', '--engine',
  '--plugins', '--plugin',
]);
const GLOBAL_VALUE_OPTIONS = new Set([
  '--headers', '--proxy', '--proxy-bypass', '--user-agent', '--device',
  '--color-scheme', '--download-path', '--screenshot-dir', '--screenshot-quality',
  '--screenshot-format', '--ca-cert', '--model',
]);

type OptionKind = 'switch' | 'boolean' | 'value';
type OptionRules = Readonly<Record<string, OptionKind>>;

const SCREENSHOT_OPTIONS: OptionRules = {
  '--full': 'switch', '-f': 'switch', '--annotate': 'boolean',
  '--screenshot-format': 'value', '--screenshot-quality': 'value',
};
const SELECTOR_OPTIONS: OptionRules = { '--selector': 'value', '-s': 'value' };
const ATTACHED_OPTIONS: Readonly<Record<string, OptionRules>> = {
  screenshot: SCREENSHOT_OPTIONS,
  snapshot: {
    '-i': 'switch', '--interactive': 'switch', '-c': 'switch', '--compact': 'switch',
    '-C': 'switch', '--cursor': 'switch', '-u': 'switch', '--urls': 'switch',
    '-d': 'value', '--depth': 'value', ...SELECTOR_OPTIONS,
  },
  scroll: SELECTOR_OPTIONS,
  type: { '--clear': 'switch', '--delay': 'value' },
  wait: {
    '--url': 'value', '-u': 'value', '--load': 'value', '-l': 'value',
    '--text': 'value', '-t': 'value', '--timeout': 'value',
  },
  read: { '--raw': 'switch', '--outline': 'switch', '--filter': 'value', '--timeout': 'value' },
  a11y: { '--tags': 'value', ...SELECTOR_OPTIONS },
};
const ONE_ARGUMENT_COMMANDS = new Set([
  'click', 'dblclick', 'hover', 'focus', 'check', 'uncheck', 'press', 'key',
  'keydown', 'keyup', 'scrollintoview', 'scrollinto', 'highlight',
]);
const NO_ARGUMENT_COMMANDS = new Set(['back', 'forward', 'reload', 'close', 'quit', 'exit']);
const FIND_LOCATORS = new Set(['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth']);
const FIND_ACTIONS = new Set(['click', 'fill', 'check', 'hover', 'text']);
const EXACT_LOCATORS = new Set(['role', 'text', 'label', 'placeholder', 'alt', 'title']);

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
    if (CONNECTION_OPTIONS.has(option)) {
      throw new Error('Existing-browser attachment requires browser_authorize; do not pass CDP or auto-connect options to browser.');
    }
    if (OWNED_OPTIONS.has(option) || option === '--restore' || option.startsWith('--restore-')) {
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

export function validateAttachedBrowserCommand(args: readonly string[], origin?: string): void {
  const command = validateBrowserCommand(args);
  let rules = ATTACHED_OPTIONS[command] ?? {};
  if (command === 'find') {
    rules = {
      ...(args[1] === 'role' ? { '--name': 'value' as const } : {}),
      ...(EXACT_LOCATORS.has(args[1] ?? '') ? { '--exact': 'switch' as const } : {}),
    };
  }
  const { positional, options, firstOption } = parseOptions(args.slice(1), rules);
  const count = (minimum: number, maximum = minimum) => requireCount(command, positional, minimum, maximum);

  if (ONE_ARGUMENT_COMMANDS.has(command)) { count(1); return; }
  if (NO_ARGUMENT_COMMANDS.has(command)) { count(0); return; }
  switch (command) {
    case 'open': case 'goto': case 'navigate':
      count(1);
      validateNavigation(positional[0]!, origin);
      return;
    case 'fill': case 'type':
      count(2, Infinity);
      if (firstOption === 0) throw new Error('Place type options after the selector.');
      validateIntegerOptions(options, ['--delay'], 0, 300_000);
      return;
    case 'select': count(2, Infinity); return;
    case 'drag': count(2); return;
    case 'keyboard':
      count(2, Infinity);
      if (!['type', 'inserttext', 'insertText'].includes(positional[0]!)) unsupported(command);
      return;
    case 'scroll':
      count(0, 2);
      if (positional[0] !== undefined && !['up', 'down', 'left', 'right'].includes(positional[0])) unsupported(command);
      if (positional[1] !== undefined) requireInteger(positional[1], 0, 2_147_483_647);
      return;
    case 'snapshot':
      count(0);
      validateIntegerOptions(options, ['--depth', '-d'], 0, 2_147_483_647);
      return;
    case 'screenshot':
      count(0, 1);
      validateScreenshotOptions(options);
      if (positional[0] !== undefined && isScreenshotPath(positional[0])) {
        throw new Error('Authorized browser screenshots use Felan-generated paths; omit the output path.');
      }
      return;
    case 'get': {
      const subcommand = positional[0];
      if (subcommand === 'title' || subcommand === 'url') count(1);
      else if (subcommand === 'attr') count(3);
      else if (['text', 'html', 'value', 'count', 'box', 'styles'].includes(subcommand ?? '')) count(2);
      else unsupported(command);
      return;
    }
    case 'is':
      count(2);
      if (!['visible', 'enabled', 'checked'].includes(positional[0]!)) unsupported(command);
      return;
    case 'find': {
      const locator = positional[0] ?? '';
      if (!FIND_LOCATORS.has(locator)) unsupported(command);
      const actionIndex = locator === 'nth' ? 3 : 2;
      count(actionIndex, Infinity);
      if (locator === 'nth') requireInteger(positional[1]!, -2_147_483_648, 2_147_483_647);
      const action = positional[actionIndex] ?? 'click';
      if (!FIND_ACTIONS.has(action)) unsupported('find action');
      count(action === 'fill' ? actionIndex + 2 : actionIndex, action === 'fill' ? Infinity : actionIndex + 1);
      if (firstOption !== undefined && firstOption <= actionIndex) {
        throw new Error('Place find options after an explicit supported action.');
      }
      return;
    }
    case 'mouse': {
      const action = positional[0];
      if (action === 'move') count(3);
      else if (action === 'wheel') count(1, 3);
      else if (action === 'down' || action === 'up') {
        count(1, 2);
        if (positional[1] !== undefined && !['left', 'right', 'middle'].includes(positional[1])) unsupported(command);
        return;
      } else unsupported(command);
      for (const value of positional.slice(1)) requireInteger(value, -2_147_483_648, 2_147_483_647);
      return;
    }
    case 'dialog':
      if (positional[0] === 'status') count(1);
      else if (positional[0] === 'accept' || positional[0] === 'dismiss') count(1, 2);
      else unsupported(command);
      return;
    case 'wait': {
      const modes = [...options.keys()].filter(option => option !== '--timeout');
      count(modes.length === 0 ? 1 : 0);
      if (modes.length > 1) throw new Error('Use one supported wait condition at a time.');
      for (const option of ['--load', '-l']) {
        const state = options.get(option);
        if (state !== undefined && !['load', 'domcontentloaded', 'networkidle'].includes(state)) unsupported('wait load state');
      }
      validateIntegerOptions(options, ['--timeout'], 1, 300_000);
      return;
    }
    case 'read':
      count(0);
      validateIntegerOptions(options, ['--timeout'], 1, 300_000);
      return;
    case 'a11y': count(0); return;
    default: unsupported(command);
  }
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

function validateNavigation(target: string, origin?: string): void {
  let url: URL;
  try { url = new URL(target); } catch { throw new Error('Authorized browser navigation requires an absolute HTTP(S) URL.'); }
  if (!/^https?:\/\//iu.test(target) || /[\s\\]/u.test(target) || url.username || url.password) {
    throw new Error('Authorized browser navigation requires an unambiguous HTTP(S) URL without credentials.');
  }
  if (origin !== undefined && url.origin !== origin) {
    throw new Error('Browser navigation is outside the authorized origin; revoke and authorize the new origin.');
  }
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

function unsupported(command: string): never {
  throw new Error(`The ${command} command or subcommand is unavailable on an authorized existing browser session.`);
}
