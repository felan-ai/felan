import { join } from 'node:path';
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
import { fileListingGlobMatcher, normalizeFileListingPath } from './file-listing.js';

const encoder = new TextEncoder();
const MAX_RUNTIME_TOOL_OUTPUT_BYTES = 50 * 1024;

export function createRuntimeCodingTools(runtime: AgentRuntime): ToolDefinition<any, any, any>[] {
  const read = createReadToolDefinition(runtime.cwd, {
    operations: {
      access: async (path) => {
        await runtime.readFile(path);
      },
      readFile: async (path) => Buffer.from(await runtime.readFile(path)),
    },
  });

  const bash = createBashToolDefinition(runtime.cwd) as ToolDefinition<any, any, any>;
  bash.execute = async (_toolCallId, { command, timeout }, signal) => {
    const result = await runtime.shell(command, {
      ...(signal === undefined ? {} : { signal }),
      ...(timeout === undefined ? {} : { timeout: timeout * 1_000 }),
      maxOutputBytes: MAX_RUNTIME_TOOL_OUTPUT_BYTES,
    });
    if (result.killed) {
      throw new Error(signal?.aborted ? 'Command aborted' : `Command timed out after ${timeout} seconds`);
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(no output)';
    const truncationNotice = result.truncated
      ? `\n\n[Output truncated at ${MAX_RUNTIME_TOOL_OUTPUT_BYTES} bytes]`
      : '';
    if (result.code !== 0) {
      throw new Error(`${output}${truncationNotice}\n\nCommand exited with code ${result.code}`);
    }
    return {
      content: [{ type: 'text', text: `${output}${truncationNotice}` }],
      details: result.truncated
        ? { outputTruncated: true, maxOutputBytes: MAX_RUNTIME_TOOL_OUTPUT_BYTES }
        : undefined,
    };
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
    { pattern, path, glob, ignoreCase, literal, context, limit = 100 },
    signal,
  ) => {
    const searchPath = path || '.';
    await validateGrepPath(runtime, searchPath);
    const args = ['--line-number', '--color=never', '--hidden'];
    if (ignoreCase) args.push('--ignore-case');
    if (literal) args.push('--fixed-strings');
    if (glob) args.push('--glob', glob);
    if (context && context > 0) args.push('--context', String(context));
    args.push('--', pattern, searchPath);

    const result = await runtime.exec('rg', args, {
      ...(signal === undefined ? {} : { signal }),
      maxOutputBytes: MAX_RUNTIME_TOOL_OUTPUT_BYTES,
    });
    if (result.killed) throw new Error('Operation aborted');
    if (result.code === 1) {
      return { content: [{ type: 'text', text: 'No matches found' }], details: undefined };
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || `ripgrep exited with code ${result.code}`);
    }

    const lines = result.stdout.replace(/\n$/, '').split('\n');
    const limited = lines.slice(0, limit);
    const notices: string[] = [];
    if (lines.length > limit) notices.push(`${limit} matches limit reached`);
    if (result.truncated) notices.push(`output truncated at ${MAX_RUNTIME_TOOL_OUTPUT_BYTES} bytes`);
    const details = {
      ...(lines.length > limit ? { matchLimitReached: limit } : {}),
      ...(result.truncated
        ? { outputTruncated: true, maxOutputBytes: MAX_RUNTIME_TOOL_OUTPUT_BYTES }
        : {}),
    };
    const text = [
      limited.join('\n'),
      ...(notices.length === 0 ? [] : [`\n[${notices.join('; ')}]`]),
    ].join('');
    return {
      content: [{ type: 'text', text }],
      details: Object.keys(details).length > 0 ? details : undefined,
    };
  };

  const createFindOperations = (signal?: AbortSignal) => ({
    exists: async (path: string) => directoryExists(runtime, path, signal),
    glob: async (pattern: string, cwd: string, { ignore, limit }: {
      readonly ignore: readonly string[];
      readonly limit: number;
    }) => {
      const matcher = fileListingGlobMatcher(pattern);
      const ignoreMatchers = (ignore ?? []).map(fileListingGlobMatcher);
      return (await runtime.listFiles(cwd, {
        recursive: true,
        ignore,
        limit,
        pattern,
        ...(signal === undefined ? {} : { signal }),
      }))
        .map(normalizeFileListingPath)
        .filter((path) => matcher.test(path) && !ignoreMatchers.some((ignoreMatcher) => (
          ignoreMatcher.test(path)
        )))
        .slice(0, limit)
        .map((path) => join(cwd, path));
    },
  });
  const find = createFindToolDefinition(runtime.cwd, {
    operations: createFindOperations(),
  });
  find.execute = async (...args) => {
    const [toolCallId, params, signal, onUpdate, context] = args;
    const perCallFind = createFindToolDefinition(runtime.cwd, {
      operations: createFindOperations(signal),
    });
    return perCallFind.execute(toolCallId, params, signal, onUpdate, context);
  };

  const createLsOperations = (signal: AbortSignal | undefined, limit: number) => ({
    exists: async (path: string) => pathExists(runtime, path, signal),
    stat: async (path: string) => {
      const isDirectory = await directoryExists(runtime, path, signal);
      return { isDirectory: () => isDirectory };
    },
    readdir: async (path: string) => (await runtime.listFiles(path, {
      includeDirectories: true,
      limit,
      recursive: false,
      ...(signal === undefined ? {} : { signal }),
    })).map(normalizeFileListingPath),
  });
  const ls = createLsToolDefinition(runtime.cwd, {
    operations: createLsOperations(undefined, 501),
  });
  ls.execute = async (...args) => {
    const [toolCallId, params, signal, onUpdate, context] = args;
    const effectiveLimit = boundedToolLimit(params.limit);
    const perCallLs = createLsToolDefinition(runtime.cwd, {
      operations: createLsOperations(signal, effectiveLimit === Number.MAX_SAFE_INTEGER
        ? effectiveLimit
        : effectiveLimit + 1),
    });
    return perCallLs.execute(toolCallId, params, signal, onUpdate, context);
  };

  return [read, bash, edit, write, grep, find, ls];
}

async function validateGrepPath(runtime: AgentRuntime, path: string): Promise<void> {
  if (await directoryExists(runtime, path)) return;
  await runtime.readFile(path);
}

async function pathExists(
  runtime: AgentRuntime,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (await directoryExists(runtime, path, signal)) return true;
  if (signal?.aborted) throw new Error('Operation aborted');
  try {
    await runtime.readFile(path);
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

function boundedToolLimit(value: number | undefined): number {
  const limit = value ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('limit must be a non-negative safe integer');
  }
  return limit;
}

async function directoryExists(
  runtime: AgentRuntime,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await runtime.listFiles(path, {
      limit: 0,
      ...(signal === undefined ? {} : { signal }),
    });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}
