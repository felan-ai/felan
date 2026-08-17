import {
  resizeImage,
  type AgentRuntime,
  type ExtensionAPI,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import { ExecSessionManager, formatExecResult } from './exec-session-manager.js';
import { ApplyPatchError, applyPatch } from './patch.js';
import { supportsImageInput } from './model-policy.js';

const ExecCommandParams = Type.Object({
  cmd: Type.String({ description: 'Raw command string interpreted by the current shell; do not quote the entire command' }),
  workdir: Type.Optional(Type.String({ description: 'Cwd' })),
  shell: Type.Optional(Type.String()),
  tty: Type.Optional(Type.Boolean({ description: 'Run the command in a real PTY for ongoing interaction' })),
  yield_time_ms: Type.Optional(Type.Number({ description: 'Wait before yielding output. Defaults to 10000 ms and clamps to 250-30000 ms; Windows uses a 10000 ms minimum.' })),
  max_output_tokens: Type.Optional(Type.Number({ description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' })),
  login: Type.Optional(Type.Boolean({ description: 'Login shell' })),
}, { additionalProperties: false });

const WriteStdinParams = Type.Object({
  session_id: Type.Number({ description: 'Session ID' }),
  chars: Type.Optional(Type.String({ description: 'Bytes to write to stdin. Defaults to empty, which polls without writing.' })),
  yield_time_ms: Type.Optional(Type.Number({ description: 'Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.' })),
  max_output_tokens: Type.Optional(Type.Number({ description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' })),
}, { additionalProperties: false });

const ApplyPatchParams = Type.Object({
  input: Type.String({
    description: 'Full patch text. Use *** Begin Patch / *** End Patch with Add/Update/Delete File sections. *** Move to: path must immediately follow its Update File header and still needs a nonempty @@ hunk; use one unchanged context line for a pure move. Order each file\'s hunks top-to-bottom; indentation is literal',
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
    description: 'Runs a command, returning output or a session ID for ongoing interaction.',
    promptSnippet: 'Run commands; use tty=true for a PTY and write_stdin to poll or interact',
    parameters: ExecCommandParams,
    prepareArguments: (args: unknown) => prepareExecArguments(args) as ExecCommandParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      const result = await sessions.exec(params, signal, onUpdate
        ? (partial) => onUpdate({
          content: [{ type: 'text', text: formatExecResult(partial) }],
          details: partial,
        })
        : undefined);
      return {
        content: [{ type: 'text', text: formatExecResult(result) }],
        details: result,
      };
    },
    renderCall(params, theme, context) {
      const title = context.isError ? 'Command failed' : context.isPartial ? 'Running' : 'Ran';
      return renderFriendlyCall(theme, title, params.cmd, context.isError);
    },
  };

  const writeStdin: ToolDefinition<typeof WriteStdinParams> = {
    name: 'write_stdin',
    label: 'write_stdin',
    description: 'Writes characters to an existing exec_command session and returns recent output.',
    promptSnippet: 'Write to or poll a running exec_command session',
    parameters: WriteStdinParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      const result = await sessions.write(params, signal, onUpdate
        ? (partial) => onUpdate({
          content: [{ type: 'text', text: formatExecResult(partial) }],
          details: partial,
        })
        : undefined);
      return {
        content: [{ type: 'text', text: formatExecResult(result) }],
        details: result,
      };
    },
    renderCall(params, theme, context) {
      const interacted = typeof params.chars === 'string' && params.chars.length > 0;
      let title: string;
      if (context.isError) title = 'Terminal interaction failed';
      else if (interacted) {
        title = context.isPartial ? 'Interacting with background terminal' : 'Interacted with background terminal';
      } else title = context.isPartial ? 'Waiting for background terminal' : 'Waited for background terminal';
      return renderFriendlyCall(theme, title, `#${params.session_id}`, context.isError, interacted ? '↳' : '•');
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
    renderCall(_params, theme, context) {
      const title = context.isError ? 'Patch failed' : context.isPartial ? 'Patching' : 'Patched';
      return renderFriendlyCall(theme, title, undefined, context.isError);
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
    renderCall(params, theme, context) {
      const title = context.isError ? 'Image view failed' : context.isPartial ? 'Viewing image' : 'Viewed image';
      const path = params.path.startsWith('@') ? params.path.slice(1) : params.path;
      return renderFriendlyCall(theme, title, path, context.isError);
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

interface FriendlyRenderTheme {
  fg(role: 'dim' | 'muted' | 'error', text: string): string;
  bold(text: string): string;
}

function renderFriendlyCall(
  theme: FriendlyRenderTheme,
  title: string,
  detail: string | undefined,
  isError: boolean,
  marker = '•',
): Text {
  const heading = theme.bold(title);
  const styledHeading = isError ? theme.fg('error', heading) : heading;
  const preview = detail === undefined ? '' : formatPreview(detail);
  const suffix = preview ? `${theme.fg('dim', ' · ')}${theme.fg('muted', preview)}` : '';
  return new Text(`${theme.fg('dim', marker)} ${styledHeading}${suffix}`, 0, 0);
}

function formatPreview(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= 100 ? singleLine : `${singleLine.slice(0, 97)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
