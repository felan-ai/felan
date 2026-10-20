import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { createMemoryControlExtension, type CreateMemoryControlExtensionOptions } from '../../src/index.js';

export function controlFixtureExtension(options: Omit<CreateMemoryControlExtensionOptions, 'presentation'>) {
  return (api: FelanExtensionAPI) => {
    let context: ExtensionContext | undefined;
    const bound = {
      ...api,
      ui: {
        async notify(value: { text: string; level: 'info' | 'warning' | 'error' }) { context?.ui.notify(value.text, value.level); },
        async status(value: { key: string; value: { text: string } }) { context?.ui.setStatus(value.key, value.value.text); },
        async removeStatus(key: string) { context?.ui.setStatus(key, undefined); },
      },
      registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
        api.registerCommand(name, { ...command, handler: (args, ctx) => { context = ctx; return command.handler(args, ctx); } });
      },
      on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        (api.on as Function)(name, (event: unknown, ctx: ExtensionContext) => {
          if (name !== 'session_shutdown') context = ctx;
          return handler(event, ctx);
        });
      },
    } as unknown as FelanExtensionAPI;
    return createMemoryControlExtension({ ...options, presentation: {
      async showHistory() {}, async openDirectory() {},
    } })(bound);
  };
}
