import { type AgentRuntime, type FelanExtensionAPI, type ToolDefinition } from '@felan-ai/agent-core';
import { Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import { ApplyPatchError, applyPatch } from './patch.js';

const ApplyPatchParams = Type.Object({
  input: Type.String({
    description: 'Full patch text. Use *** Begin Patch / *** End Patch with Add/Update/Delete File sections. *** Move to: path must immediately follow its Update File header and still needs a nonempty @@ hunk; use one unchanged context line for a pure move. Order each file\'s hunks top-to-bottom; indentation is literal',
  }),
}, { additionalProperties: false });

type ApplyPatchParams = Static<typeof ApplyPatchParams>;

export const CODEX_TOOL_NAMES = ['apply_patch'] as const;

export function createCodexTools(runtime: AgentRuntime): ToolDefinition<any, any, any>[] {
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

  return [applyPatchTool];
}

export function registerPatchResultEvent(pi: Pick<FelanExtensionAPI, 'on'>): void {
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

function preparePatchArguments(args: unknown): unknown {
  if (!isRecord(args) || typeof args.input === 'string') return args;
  if (typeof args.patchText === 'string') return { input: args.patchText };
  if (typeof args.patch === 'string') return { input: args.patch };
  return args;
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
