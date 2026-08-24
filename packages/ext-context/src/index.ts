import type {
  ExtensionContext,
  FelanExtension,
} from '@felan-ai/agent-core';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';

type ContextFile = {
  readonly path: string;
  readonly content: string;
};

type ContextAnchor = {
  readonly afterKey?: string;
  readonly fallbackIndex: number;
  readonly instructionTimestamp: number;
};

type State = {
  readonly loadedContextFiles: Map<string, ContextFile>;
  readonly processedDirs: Set<string>;
  contextAnchor: ContextAnchor | undefined;
};

const CONTEXT_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;
const CUSTOM_TYPE = 'pi-progressive-context';
const decoder = new TextDecoder();

const contextExtension: FelanExtension = (pi) => {
  pi.registerCapability({
    id: 'progressive-context',
    instructions: 'Nested project instructions are discovered progressively when files under their directories are read or attached. Apply loaded instructions to their scoped paths, prefer the most specific applicable guidance, and retain them for subsequent work in those paths.',
  });

  const state: State = {
    loadedContextFiles: new Map(),
    processedDirs: new Set(),
    contextAnchor: undefined,
  };

  pi.on('session_start', (_event, ctx) => {
    state.loadedContextFiles.clear();
    state.processedDirs.clear();
    state.contextAnchor = undefined;
    ctx.ui.setStatus('progressive-context', undefined);
  });

  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName !== 'read' || event.isError) return;

    const filePath = typeof event.input.path === 'string' ? event.input.path : undefined;
    if (!filePath) return;

    await discoverForPath(filePath, ctx, state, pi.runtime.readFile.bind(pi.runtime));
  });

  pi.on('input', async (event, ctx) => {
    for (const filePath of parseFileBlockNames(event.text)) {
      await discoverForPath(filePath, ctx, state, pi.runtime.readFile.bind(pi.runtime));
    }
  });

  pi.on('context', (event) => {
    const messages = event.messages.filter((message) => !isProgressiveContextMessage(message));
    if (state.loadedContextFiles.size === 0) {
      state.contextAnchor = undefined;
      return messages.length === event.messages.length ? undefined : { messages };
    }

    const { anchor, index } = resolveContextAnchor(messages, state.contextAnchor);
    state.contextAnchor = anchor;

    return {
      messages: [
        ...messages.slice(0, index),
        {
          role: 'custom',
          customType: CUSTOM_TYPE,
          content: formatProgressiveContext([...state.loadedContextFiles.values()]),
          display: false,
          timestamp: anchor.instructionTimestamp,
        },
        ...messages.slice(index),
      ],
    };
  });

  pi.registerCommand('progressive-context', {
    description: 'Show progressively loaded nested AGENTS.md / CLAUDE.md files',
    handler: async (_args, ctx) => {
      const output = formatLoadedFiles([...state.loadedContextFiles.values()]);
      if (ctx.hasUI) {
        ctx.ui.notify(output, 'info');
      } else {
        console.error(output);
      }
    },
  });
};

async function discoverForPath(
  observedPath: string,
  ctx: ExtensionContext,
  state: State,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<void> {
  const filePath = resolveObservedPath(observedPath, ctx.cwd);
  if (!filePath) return;

  try {
    await readFile(filePath);
  } catch {
    return;
  }

  let discovered = false;
  for (const dir of collectNestedDirs(ctx.cwd, dirname(filePath))) {
    const dirKey = comparisonPath(dir);
    if (state.processedDirs.has(dirKey)) continue;
    state.processedDirs.add(dirKey);

    const contextFile = await loadContextFileFromDir(dir, readFile);
    if (!contextFile) continue;

    const fileKey = comparisonPath(contextFile.path);
    if (state.loadedContextFiles.has(fileKey)) continue;

    state.loadedContextFiles.set(fileKey, contextFile);
    discovered = true;
  }

  if (discovered) {
    state.contextAnchor = undefined;
    const count = state.loadedContextFiles.size;
    ctx.ui.setStatus(
      'progressive-context',
      `${count} nested context file${count === 1 ? '' : 's'}`,
    );
  }
}

function resolveContextAnchor(
  messages: readonly unknown[],
  currentAnchor?: ContextAnchor,
): { anchor: ContextAnchor; index: number } {
  if (currentAnchor) {
    if (currentAnchor.afterKey !== undefined) {
      const anchoredIndex = messages.findIndex(
        (message) => contextMessageKey(message) === currentAnchor.afterKey,
      );
      if (anchoredIndex >= 0) return { anchor: currentAnchor, index: anchoredIndex + 1 };
    } else if (currentAnchor.fallbackIndex <= messages.length) {
      return { anchor: currentAnchor, index: currentAnchor.fallbackIndex };
    }
  }

  const fallbackIndex = messages.length;
  const afterKey = fallbackIndex > 0 ? contextMessageKey(messages[fallbackIndex - 1]) : undefined;
  const anchor: ContextAnchor = {
    fallbackIndex,
    instructionTimestamp: Date.now(),
    ...(afterKey === undefined ? {} : { afterKey }),
  };
  return { anchor, index: fallbackIndex };
}

function contextMessageKey(message: unknown): string | undefined {
  if (!isRecord(message) || typeof message.role !== 'string') return undefined;
  const timestamp = message.timestamp;
  if (typeof timestamp !== 'number' && typeof timestamp !== 'string') return undefined;

  return JSON.stringify([
    message.role,
    timestamp,
    typeof message.toolCallId === 'string' ? message.toolCallId : '',
    typeof message.customType === 'string' ? message.customType : '',
    typeof message.responseId === 'string' ? message.responseId : '',
  ]);
}

function isProgressiveContextMessage(message: unknown): boolean {
  return isRecord(message)
    && message.role === 'custom'
    && message.customType === CUSTOM_TYPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveObservedPath(observedPath: string, cwd: string): string | undefined {
  let path = observedPath.trim();
  if (path.startsWith('@')) path = path.slice(1);
  if (!path) return undefined;

  const cwdPath = normalize(resolve(cwd));
  const filePath = normalize(isAbsolute(path) ? resolve(path) : resolve(cwdPath, path));

  return isPathInsideOrEqual(filePath, cwdPath) ? filePath : undefined;
}

function collectNestedDirs(cwd: string, fileDir: string): string[] {
  const cwdPath = normalize(resolve(cwd));
  let current = normalize(resolve(fileDir));
  const dirs: string[] = [];

  while (comparisonPath(current) !== comparisonPath(cwdPath) && isPathInsideOrEqual(current, cwdPath)) {
    dirs.push(current);
    const parent = normalize(dirname(current));
    if (comparisonPath(parent) === comparisonPath(current)) break;
    current = parent;
  }

  return dirs.reverse();
}

async function loadContextFileFromDir(
  dir: string,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<ContextFile | undefined> {
  for (const fileName of CONTEXT_FILE_CANDIDATES) {
    const filePath = normalize(resolve(dir, fileName));
    try {
      return { path: filePath, content: decoder.decode(await readFile(filePath)) };
    } catch {
      continue;
    }
  }
}

function isPathInsideOrEqual(path: string, root: string): boolean {
  const normalizedPath = comparisonPath(path);
  const normalizedRoot = comparisonPath(root);

  return normalizedPath === normalizedRoot || normalizedPath.startsWith(withTrailingSlash(normalizedRoot));
}

function comparisonPath(path: string): string {
  const normalized = normalize(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

function parseFileBlockNames(text: string): string[] {
  const names = new Set<string>();
  const fileTagPattern = /<file\s+[^>]*\bname=(["'])(.*?)\1[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = fileTagPattern.exec(text)) !== null) {
    const name = decodeXmlAttribute(match[2] ?? '').trim();
    if (name) names.add(name);
  }

  return [...names];
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function formatProgressiveContext(files: ContextFile[]): string {
  return [
    '# Progressive Project Context',
    '',
    'The following nested AGENTS.md / CLAUDE.md files became relevant because files under their directories were read or attached. Follow these instructions for work in the corresponding paths.',
    '',
    ...files.map((file) => `## ${file.path}\n\n${file.content.trimEnd()}`),
  ].join('\n');
}

function formatLoadedFiles(files: ContextFile[]): string {
  if (files.length === 0) return 'No progressive context files loaded.';

  return [
    'Progressive Context',
    `Loaded ${files.length} nested context file${files.length === 1 ? '' : 's'}:`,
    ...files.map((file) => `- ${file.path}`),
  ].join('\n');
}

export default contextExtension;
