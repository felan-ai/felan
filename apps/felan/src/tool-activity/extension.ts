import type {
  ExtensionContext,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import {
  Key,
} from '@earendil-works/pi-tui';
import { ToolActivityInspector } from './inspector.js';
import { ToolActivityState } from './state.js';

export const TOOL_ACTIVITY_EXTENSION_NAME = '@felan-ai/felan/tool-activity';
export const TOOL_ACTIVITY_SHORTCUT = Key.alt('t');

export function createToolActivityExtension(state: ToolActivityState): InlineExtension {
  return {
    name: TOOL_ACTIVITY_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const overlays = new Set<ToolActivityInspector>();
      const open = (ctx: ExtensionContext) => openToolActivityInspector(ctx, state, overlays);

      pi.registerCommand('tools', {
        description: 'Inspect full tool call arguments and results',
        handler: async (_args, ctx) => open(ctx),
      });
      pi.registerShortcut(TOOL_ACTIVITY_SHORTCUT, {
        description: 'Inspect full tool call arguments and results',
        handler: open,
      });
      pi.on('session_start', () => {
        state.refreshMode();
        state.rebuild();
      });
      pi.on('session_tree', () => state.rebuild());
      pi.on('session_shutdown', (event) => {
        for (const overlay of overlays) overlay.close();
        overlays.clear();
        if (event.reason !== 'reload') state.dispose();
      });
    },
  };
}

async function openToolActivityInspector(
  ctx: ExtensionContext,
  state: ToolActivityState,
  overlays: Set<ToolActivityInspector>,
): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify('Tool activity inspector is available only in the local TUI', 'warning');
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let overlay!: ToolActivityInspector;
      overlay = new ToolActivityInspector(
        state,
        theme,
        tui,
        () => done(undefined),
        () => overlays.delete(overlay),
      );
      overlays.add(overlay);
      return overlay;
    },
  );
}
