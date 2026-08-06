import { dirname, resolve } from 'node:path';
import { withFileMutationQueue, type AgentRuntime } from '@felan-ai/agent-core';

interface Chunk {
  origIndex: number;
  delLines: string[];
  insLines: string[];
}

interface PatchAction {
  type: 'add' | 'delete' | 'update';
  path: string;
  newFile?: string;
  lines?: string[];
  movePath?: string;
}

export interface ApplyPatchResult {
  changedFiles: string[];
  createdFiles: string[];
  deletedFiles: string[];
  movedFiles: string[];
  fuzz: number;
}

interface ParserState {
  lines: string[];
  index: number;
  fuzz: number;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export async function applyPatch(
  runtime: AgentRuntime,
  patchText: string,
  signal?: AbortSignal,
): Promise<ApplyPatchResult> {
  const actions = parsePatchActions(patchText);
  const result: ApplyPatchResult = {
    changedFiles: [],
    createdFiles: [],
    deletedFiles: [],
    movedFiles: [],
    fuzz: 0,
  };
  for (const action of actions) {
    if (signal?.aborted) throw new Error('apply_patch aborted');
    try {
      const touchedPaths = action.movePath ? [action.path, action.movePath] : [action.path];
      await withMutationQueues(runtime, touchedPaths, () => applyAction(runtime, action, result));
    } catch (error) {
      const partial = result.changedFiles.length > 0;
      const message = `apply_patch ${partial ? 'partially failed' : 'failed'} while patching ${action.path}: ${errorMessage(error)}`;
      throw new ApplyPatchError(message, result, action.path);
    }
  }
  return result;
}

async function applyAction(
  runtime: AgentRuntime,
  action: PatchAction,
  result: ApplyPatchResult,
): Promise<void> {
  if (action.type === 'add') {
    await runtime.mkdir(dirname(action.path), { recursive: true });
    await runtime.writeFile(action.path, encoder.encode(action.newFile ?? ''), { exclusive: true });
    result.createdFiles.push(action.path);
    result.changedFiles.push(action.path);
    return;
  }
  if (action.type === 'delete') {
    await requireFile(runtime, action.path);
    await runtime.remove(action.path);
    result.deletedFiles.push(action.path);
    result.changedFiles.push(action.path);
    return;
  }

  const originalBytes = await requireFile(runtime, action.path);
  const original = decoder.decode(originalBytes);
  const state: ParserState = { lines: action.lines!, index: 0, fuzz: 0 };
  const chunks = parseUpdateChunks(state, original, action.path);
  const updated = applyChunks(original, chunks);
  const destination = action.movePath ?? action.path;
  await runtime.mkdir(dirname(destination), { recursive: true });
  if (!action.movePath) {
    await runtime.writeFile(destination, encoder.encode(updated));
    result.changedFiles.push(destination);
    result.fuzz += state.fuzz;
    return;
  }

  await runtime.writeFile(destination, encoder.encode(updated), { exclusive: true });
  try {
    await runtime.remove(action.path);
  } catch (removeError) {
    const rollbackErrors: unknown[] = [];
    try {
      await runtime.remove(destination);
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      if (!await pathExists(runtime, action.path)) {
        await runtime.writeFile(action.path, originalBytes, { exclusive: true });
      }
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (rollbackErrors.length > 0) {
      await recordPartialMove(runtime, action.path, destination, result);
      throw new AggregateError(
        [removeError, ...rollbackErrors],
        `Failed to remove ${action.path} and rollback ${destination}`,
      );
    }
    throw new Error(`Failed to remove move source ${action.path}: ${errorMessage(removeError)}`, {
      cause: removeError,
    });
  }
  result.movedFiles.push(`${action.path} -> ${destination}`);
  result.changedFiles.push(destination);
  result.fuzz += state.fuzz;
}

async function withMutationQueues<T>(
  runtime: AgentRuntime,
  paths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const absolutePaths = [...new Set(paths.map((path) => resolve(runtime.cwd, path)))].sort();
  const acquire = (index: number): Promise<T> => index === absolutePaths.length
    ? operation()
    : withFileMutationQueue(absolutePaths[index]!, () => acquire(index + 1));
  return acquire(0);
}

async function recordPartialMove(
  runtime: AgentRuntime,
  source: string,
  destination: string,
  result: ApplyPatchResult,
): Promise<void> {
  if (await pathExists(runtime, destination)) {
    pushUnique(result.createdFiles, destination);
    pushUnique(result.changedFiles, destination);
  }
  if (!await pathExists(runtime, source)) {
    pushUnique(result.deletedFiles, source);
    pushUnique(result.changedFiles, source);
  }
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

export class ApplyPatchError extends Error {
  constructor(
    message: string,
    readonly result: ApplyPatchResult,
    readonly failedPath: string,
  ) {
    super(message);
    this.name = 'ApplyPatchError';
  }
}

function parsePatchActions(text: string): PatchAction[] {
  const lines = text.trim().split('\n');
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') {
    throw new Error('Invalid patch text');
  }
  const actions: PatchAction[] = [];
  const seen = new Set<string>();
  let index = 1;
  while (index < lines.length - 1) {
    const header = lines[index]!;
    const match = /^\*\*\* (Add|Delete|Update) File: (.+)$/u.exec(header);
    if (!match) throw new Error(`Invalid patch hunk on line ${index + 1}: ${header}`);
    const type = match[1]!.toLowerCase() as PatchAction['type'];
    const path = normalizePatchPath(match[2]!);
    if (!path) throw new Error('Patch path cannot be empty');
    if (seen.has(path)) throw new Error(`Duplicate patch path: ${path}`);
    seen.add(path);
    index += 1;

    if (type === 'delete') {
      actions.push({ type, path });
      continue;
    }
    let movePath: string | undefined;
    if (type === 'update' && lines[index]?.startsWith('*** Move to: ')) {
      movePath = normalizePatchPath(lines[index]!.slice('*** Move to: '.length));
      if (!movePath) throw new Error('Move destination cannot be empty');
      if (seen.has(movePath)) throw new Error(`Duplicate patch path: ${movePath}`);
      seen.add(movePath);
      index += 1;
    }
    const body: string[] = [];
    while (index < lines.length - 1 && !/^\*\*\* (?:Add|Delete|Update) File: /u.test(lines[index]!)) {
      body.push(lines[index++]!);
    }
    if (body.length === 0) throw new Error(`Patch body for ${path} is empty`);
    if (type === 'add') {
      for (const line of body) {
        if (!line.startsWith('+')) throw new Error(`Invalid Add File line: ${line}`);
      }
      actions.push({ type, path, newFile: `${body.map((line) => line.slice(1)).join('\n')}\n` });
    } else {
      actions.push({ type, path, lines: body, ...(movePath ? { movePath } : {}) });
    }
  }
  if (actions.length === 0) throw new Error('No files were modified');
  return actions;
}

function parseUpdateChunks(state: ParserState, text: string, path: string): Chunk[] {
  const fileLines = splitFileLines(text);
  const chunks: Chunk[] = [];
  let fileIndex = 0;
  while (state.index < state.lines.length) {
    let section = '';
    const header = state.lines[state.index];
    if (header === '@@') state.index += 1;
    else if (header?.startsWith('@@ ')) {
      section = header.slice(3);
      state.index += 1;
    } else if (fileIndex !== 0) {
      throw new Error(`Invalid patch line: ${header ?? ''}`);
    }
    if (section) {
      const anchor = findLine(fileLines, section, fileIndex);
      if (anchor.index >= 0) {
        fileIndex = anchor.index + 1;
        state.fuzz += anchor.fuzz;
      }
    }
    const parsed = readSection(state);
    const match = findContext(fileLines, parsed.context, fileIndex, parsed.eof);
    if (match.index < 0) {
      throw new Error(`Failed to find expected lines in ${path}:\n${parsed.context.join('\n')}`);
    }
    state.fuzz += match.fuzz;
    for (const chunk of parsed.chunks) {
      chunks.push({ ...chunk, origIndex: chunk.origIndex + match.index });
    }
    fileIndex = match.index + parsed.context.length;
  }
  return chunks;
}

function readSection(state: ParserState): { context: string[]; chunks: Chunk[]; eof: boolean } {
  const context: string[] = [];
  const chunks: Chunk[] = [];
  let delLines: string[] = [];
  let insLines: string[] = [];
  let lastMode: 'keep' | 'delete' | 'add' = 'keep';
  const start = state.index;
  while (state.index < state.lines.length) {
    const raw = state.lines[state.index]!;
    if (raw.startsWith('@@') || raw === '*** End of File') break;
    if (!raw || ![' ', '+', '-'].includes(raw[0]!)) throw new Error(`Invalid patch line: ${raw}`);
    state.index += 1;
    const mode = raw[0] === '+' ? 'add' : raw[0] === '-' ? 'delete' : 'keep';
    const value = raw.slice(1);
    if (mode === 'keep' && lastMode !== 'keep' && (delLines.length || insLines.length)) {
      chunks.push({ origIndex: context.length - delLines.length, delLines, insLines });
      delLines = [];
      insLines = [];
    }
    if (mode === 'delete') {
      delLines.push(value);
      context.push(value);
    } else if (mode === 'add') insLines.push(value);
    else context.push(value);
    lastMode = mode;
  }
  if (delLines.length || insLines.length) {
    chunks.push({ origIndex: context.length - delLines.length, delLines, insLines });
  }
  const eof = state.lines[state.index] === '*** End of File';
  if (eof) state.index += 1;
  if (state.index === start) throw new Error('Patch section is empty');
  return { context, chunks, eof };
}

function findContext(lines: string[], context: string[], start: number, eof: boolean): {
  index: number;
  fuzz: number;
} {
  const first = eof ? Math.max(0, lines.length - context.length) : start;
  const preferred = findLines(lines, context, first);
  if (preferred.index >= 0 || !eof) return preferred;
  const fallback = findLines(lines, context, start);
  return { index: fallback.index, fuzz: fallback.fuzz + 10_000 };
}

function findLines(lines: string[], context: string[], start: number): { index: number; fuzz: number } {
  for (const tier of [0, 1, 100]) {
    for (let index = start; index <= lines.length - context.length; index += 1) {
      let fuzz = 0;
      let worst = 0;
      for (let offset = 0; offset < context.length; offset += 1) {
        const quality = lineFuzz(lines[index + offset]!, context[offset]!);
        if (quality === undefined) {
          worst = -1;
          break;
        }
        fuzz += quality;
        worst = Math.max(worst, quality);
      }
      if (worst === tier) return { index, fuzz };
    }
  }
  return { index: -1, fuzz: 0 };
}

function findLine(lines: string[], target: string, start: number): { index: number; fuzz: number } {
  for (const tier of [0, 1, 100]) {
    if (lines.slice(0, start).some((line) => lineFuzz(line, target) === tier)) continue;
    for (let index = start; index < lines.length; index += 1) {
      const fuzz = lineFuzz(lines[index]!, target);
      if (fuzz === tier) return { index, fuzz };
    }
  }
  return { index: -1, fuzz: 0 };
}

function lineFuzz(left: string, right: string): number | undefined {
  if (left === right) return 0;
  if (left.trimEnd() === right.trimEnd()) return 1;
  if (left.trim() === right.trim()) return 100;
  return undefined;
}

function applyChunks(text: string, chunks: Chunk[]): string {
  const lines = splitFileLines(text);
  let delta = 0;
  for (const chunk of chunks) {
    const index = chunk.origIndex + delta;
    lines.splice(index, chunk.delLines.length, ...chunk.insLines);
    delta += chunk.insLines.length - chunk.delLines.length;
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function splitFileLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function normalizePatchPath(path: string): string {
  const trimmed = path.trim();
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return withoutAt.replace(/^['"]|['"]$/gu, '');
}

async function requireFile(runtime: AgentRuntime, path: string): Promise<Uint8Array> {
  try {
    return await runtime.readFile(path);
  } catch (error) {
    throw new Error(`File not found: ${path}`, { cause: error });
  }
}

async function pathExists(runtime: AgentRuntime, path: string): Promise<boolean> {
  try {
    await runtime.readFile(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
