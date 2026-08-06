import {
  resizeImage,
  type AgentRuntime,
  type ExtensionAPI,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { Type, type Static } from 'typebox';
import { ExecSessionManager, formatExecResult } from './exec-session-manager.js';
import { ApplyPatchError, applyPatch } from './patch.js';
import { supportsImageInput } from './model-policy.js';

const ExecCommandParams = Type.Object({
  cmd: Type.String({ description: 'Raw command string interpreted by the current shell; do not quote the entire command' }),
  workdir: Type.Optional(Type.String({ description: 'Cwd' })),
  shell: Type.Optional(Type.String()),
  tty: Type.Optional(Type.Boolean({ description: 'Keep the stdin pipe open for input or interruption; this is not an OS PTY' })),
  yield_time_ms: Type.Optional(Type.Number({ description: 'Wait ms' })),
  max_output_tokens: Type.Optional(Type.Number({ description: 'Truncate' })),
  login: Type.Optional(Type.Boolean({ description: 'Login shell' })),
}, { additionalProperties: false });

const WriteStdinParams = Type.Object({
  session_id: Type.Number({ description: 'Session ID' }),
  chars: Type.Optional(Type.String({ description: 'Input. Empty polls' })),
  yield_time_ms: Type.Optional(Type.Number({ description: 'Wait ms' })),
  max_output_tokens: Type.Optional(Type.Number({ description: 'Truncate' })),
}, { additionalProperties: false });

const ApplyPatchParams = Type.Object({
  input: Type.String({
    description: 'Full patch text. Use *** Begin Patch / *** End Patch with Add/Update/Delete File sections. Order each file\'s hunks top-to-bottom; indentation is literal',
  }),
}, { additionalProperties: false });

const ViewImageParams = Type.Object({
  path: Type.String(),
}, { additionalProperties: false });

type ExecCommandParams = Static<typeof ExecCommandParams>;
type WriteStdinParams = Static<typeof WriteStdinParams>;
type ApplyPatchParams = Static<typeof ApplyPatchParams>;
type ViewImageParams = Static<typeof ViewImageParams>;

export const CODEX_TOOL_NAMES = [
  'exec_command',
  'write_stdin',
  'apply_patch',
  'view_image',
] as const;

export const MAX_VIEW_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_VIEW_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;
const MAX_VIEW_IMAGE_DIMENSION = 2_000;

export function createCodexTools(
  runtime: AgentRuntime,
  sessions: ExecSessionManager,
): ToolDefinition<any, any, any>[] {
  const execCommand: ToolDefinition<typeof ExecCommandParams> = {
    name: 'exec_command',
    label: 'exec_command',
    description: 'Run shell commands; may return session_id',
    promptSnippet: 'Run shell commands; use tty=true for input and write_stdin to poll or interact',
    parameters: ExecCommandParams,
    prepareArguments: (args: unknown) => prepareExecArguments(args) as ExecCommandParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      const result = await sessions.exec(params, signal, onUpdate
        ? (partial) => onUpdate({
          content: [{ type: 'text', text: formatExecResult(partial, params.cmd) }],
          details: partial,
        })
        : undefined);
      return {
        content: [{ type: 'text', text: formatExecResult(result, params.cmd) }],
        details: result,
      };
    },
  };

  const writeStdin: ToolDefinition<typeof WriteStdinParams> = {
    name: 'write_stdin',
    label: 'write_stdin',
    description: 'Write or poll a persistent exec_command session',
    promptSnippet: 'Write to or poll a running exec_command session',
    parameters: WriteStdinParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      const command = sessions.getSessionCommand(params.session_id);
      const result = await sessions.write(params, signal, onUpdate
        ? (partial) => onUpdate({
          content: [{ type: 'text', text: formatExecResult(partial, command) }],
          details: partial,
        })
        : undefined);
      return {
        content: [{ type: 'text', text: formatExecResult(result, command) }],
        details: result,
      };
    },
  };

  const applyPatchTool: ToolDefinition<typeof ApplyPatchParams> = {
    name: 'apply_patch',
    label: 'apply_patch',
    description: 'Safely apply a structured patch to workspace files',
    promptSnippet: 'Edit files with a structured patch',
    promptGuidelines: ['Order each Update File section\'s hunks from top to bottom and preserve exact indentation.'],
    parameters: ApplyPatchParams,
    executionMode: 'sequential',
    prepareArguments: (args: unknown) => preparePatchArguments(args) as ApplyPatchParams,
    async execute(_toolCallId, params, signal) {
      try {
        const result = await applyPatch(runtime, params.input, signal);
        return { content: [{ type: 'text', text: formatPatchSuccess(result) }], details: { status: 'success', result } };
      } catch (error) {
        if (!(error instanceof ApplyPatchError) || error.result.changedFiles.length === 0) throw error;
        return {
          content: [{
            type: 'text',
            text: `${error.message}\nFailed file: ${error.failedPath}\nEarlier file actions in this patch were already applied`,
          }],
          details: { status: 'partial_failure', result: error.result, failedPath: error.failedPath },
        };
      }
    },
  };

  const viewImage: ToolDefinition<typeof ViewImageParams> = {
    name: 'view_image',
    label: 'view_image',
    description: 'View an image from the workspace',
    promptSnippet: 'View an image file',
    parameters: ViewImageParams,
    prepareArguments: (args: unknown) => prepareImageArguments(args) as ViewImageParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!supportsImageInput(ctx.model)) {
        throw new Error('view_image is unavailable because the selected model does not support image input');
      }
      if (signal?.aborted) throw new Error('view_image aborted');
      const path = params.path.startsWith('@') ? params.path.slice(1) : params.path;
      const data = await runtime.readFile(path, { maxBytes: MAX_VIEW_IMAGE_INPUT_BYTES });
      if (signal?.aborted) throw new Error('view_image aborted');
      const mimeType = detectImageMimeType(data);
      if (!mimeType) throw new Error('view_image expected a PNG, JPEG, GIF, or WebP image');
      const resized = await resizeImage(data, mimeType, {
        maxWidth: MAX_VIEW_IMAGE_DIMENSION,
        maxHeight: MAX_VIEW_IMAGE_DIMENSION,
        maxBytes: MAX_VIEW_IMAGE_BASE64_BYTES,
      });
      if (!resized) {
        throw new Error('view_image could not decode or resize the image within safety limits');
      }
      return {
        content: [{ type: 'image', data: resized.data, mimeType: resized.mimeType }],
        details: {
          path,
          originalWidth: resized.originalWidth,
          originalHeight: resized.originalHeight,
          width: resized.width,
          height: resized.height,
          wasResized: resized.wasResized,
        },
      };
    },
  };

  return [execCommand, writeStdin, applyPatchTool, viewImage];
}

export function registerPatchResultEvent(pi: ExtensionAPI): void {
  pi.on('tool_result', (event) => {
    if (
      event.toolName === 'apply_patch'
      && typeof event.details === 'object'
      && event.details !== null
      && 'status' in event.details
      && event.details.status === 'partial_failure'
    ) return { isError: true };
    return undefined;
  });
}

function prepareExecArguments(args: unknown): unknown {
  if (!isRecord(args)) return args;
  const prepared = { ...args };
  if (!('cmd' in prepared) && typeof prepared.command === 'string') prepared.cmd = prepared.command;
  if (!('workdir' in prepared)) {
    if (typeof prepared.cwd === 'string') prepared.workdir = prepared.cwd;
    else if (typeof prepared.working_directory === 'string') prepared.workdir = prepared.working_directory;
  }
  return prepared;
}

function preparePatchArguments(args: unknown): unknown {
  if (!isRecord(args) || typeof args.input === 'string') return args;
  if (typeof args.patchText === 'string') return { input: args.patchText };
  if (typeof args.patch === 'string') return { input: args.patch };
  return args;
}

function prepareImageArguments(args: unknown): unknown {
  if (!isRecord(args) || typeof args.path === 'string') return args;
  if (typeof args.file_path === 'string') return { path: args.file_path };
  if (typeof args.image_path === 'string') return { path: args.image_path };
  return args;
}

function detectImageMimeType(data: Uint8Array): string | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const header = new TextDecoder().decode(data.subarray(0, 12));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte);
}

function formatPatchSuccess(result: Awaited<ReturnType<typeof applyPatch>>): string {
  return [
    'Applied patch successfully',
    `Changed files: ${result.changedFiles.length}`,
    `Created files: ${result.createdFiles.length}`,
    `Deleted files: ${result.deletedFiles.length}`,
    `Moved files: ${result.movedFiles.length}`,
    `Fuzz: ${result.fuzz}`,
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
