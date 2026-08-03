import { join, sep } from 'node:path';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { AgentRuntime } from './runtime.js';

const encoder = new TextEncoder();

export function createRuntimeCodingTools(runtime: AgentRuntime): ToolDefinition<any, any, any>[] {
  const read = createReadToolDefinition(runtime.cwd, {
    operations: {
      access: async (path) => {
        await runtime.readFile(path);
      },
      readFile: async (path) => Buffer.from(await runtime.readFile(path)),
    },
  });

  const bash = createBashToolDefinition(runtime.cwd);
  bash.execute = async (_toolCallId, { command, timeout }, signal) => {
    const result = await runtime.shell(command, {
      ...(signal === undefined ? {} : { signal }),
      ...(timeout === undefined ? {} : { timeout: timeout * 1_000 }),
    });
    if (result.killed) {
      throw new Error(signal?.aborted ? 'Command aborted' : `Command timed out after ${timeout} seconds`);
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(no output)';
    if (result.code !== 0) {
      throw new Error(`${output}\n\nCommand exited with code ${result.code}`);
    }
    return { content: [{ type: 'text', text: output }], details: undefined };
  };

  const edit = createEditToolDefinition(runtime.cwd, {
    operations: {
      access: async (path) => {
        await runtime.readFile(path);
      },
      readFile: async (path) => Buffer.from(await runtime.readFile(path)),
      writeFile: (path, content) => runtime.writeFile(path, encoder.encode(content)),
    },
  });
  delete edit.renderCall;

  const write = createWriteToolDefinition(runtime.cwd, {
    operations: {
      mkdir: (path) => runtime.mkdir(path, { recursive: true }),
      writeFile: (path, content) => runtime.writeFile(path, encoder.encode(content)),
    },
  });

  const grep = createGrepToolDefinition(runtime.cwd);
  grep.execute = async (
    _toolCallId,
    { pattern, path = '.', glob, ignoreCase, literal, context, limit = 100 },
    signal,
  ) => {
    await runtime.listFiles(path);
    const args = ['--line-number', '--color=never', '--hidden'];
    if (ignoreCase) args.push('--ignore-case');
    if (literal) args.push('--fixed-strings');
    if (glob) args.push('--glob', glob);
    if (context && context > 0) args.push('--context', String(context));
    args.push('--', pattern, path);

    const result = await runtime.exec('rg', args, signal === undefined ? undefined : { signal });
    if (result.killed) throw new Error('Operation aborted');
    if (result.code === 1) {
      return { content: [{ type: 'text', text: 'No matches found' }], details: undefined };
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || `ripgrep exited with code ${result.code}`);
    }

    const lines = result.stdout.replace(/\n$/, '').split('\n');
    const limited = lines.slice(0, limit);
    return {
      content: [{ type: 'text', text: limited.join('\n') }],
      details: lines.length > limit ? { matchLimitReached: limit } : undefined,
    };
  };

  const find = createFindToolDefinition(runtime.cwd, {
    operations: {
      exists: async (path) => directoryExists(runtime, path),
      glob: async (pattern, cwd, { limit }) => {
        const matcher = globMatcher(pattern);
        return (await runtime.listFiles(cwd, { recursive: true }))
          .map(normalizeSeparators)
          .filter((path) => matcher.test(path))
          .slice(0, limit)
          .map((path) => join(cwd, path));
      },
    },
  });

  const ls = createLsToolDefinition(runtime.cwd, {
    operations: {
      exists: async (path) => pathExists(runtime, path),
      stat: async (path) => {
        const isDirectory = await directoryExists(runtime, path);
        return { isDirectory: () => isDirectory };
      },
      readdir: async (path) => {
        const files = await runtime.listFiles(path, { recursive: true });
        return [...new Set(files.map(normalizeSeparators).map((file) => file.split('/')[0]!))];
      },
    },
  });

  return [read, bash, edit, write, grep, find, ls];
}

async function pathExists(runtime: AgentRuntime, path: string): Promise<boolean> {
  if (await directoryExists(runtime, path)) return true;
  try {
    await runtime.readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(runtime: AgentRuntime, path: string): Promise<boolean> {
  try {
    await runtime.listFiles(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeSeparators(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function globMatcher(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 1;
      } else {
        expression += '.*';
      }
      index += 1;
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`);
}
