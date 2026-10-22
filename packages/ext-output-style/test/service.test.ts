import { createExtensionServiceAccess, createFelanServiceRegistry, getExtensionConfigDefinition, type AgentRuntime, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { expect, it, vi } from 'vitest';
import extension, { OUTPUT_STYLE_CONFIG } from '../src/extension.js';

function harness(config: Record<string, unknown> = {}) {
  const services = createFelanServiceRegistry();
  const readFile = vi.fn(async (_path: string) => new TextEncoder().encode('  Runtime instructions.  '));
  const runtime = { readFile } as unknown as AgentRuntime;
  const on = vi.fn();
  const pi = { config, agentDir: '/agent', runtime, on,
    services: createExtensionServiceAccess(services, extension.serviceRequirements!),
  } as unknown as FelanExtensionAPI;
  const section = () => {
    const event = { messageType: 'user', prompt: '', systemPrompt: 'Base', systemPromptOptions: { sections: {} as Record<string, string> } };
    on.mock.calls.find(([name]) => name === 'before_agent_start')![1](event);
    return event.systemPromptOptions.sections.output_style;
  };
  return { services, pi, runtime, readFile, on, section };
}

it('preserves root configuration and works without optional services for built-in and inline styles', async () => {
  expect(getExtensionConfigDefinition(extension)).toBe(OUTPUT_STYLE_CONFIG);
  expect(extension.serviceRequirements).toEqual({});
  const builtin = harness(); await extension(builtin.pi);
  expect(builtin.section()).toContain('Use the fewest words'); expect(builtin.readFile).not.toHaveBeenCalled();
  const inline = harness({ style: 'custom', instructions: 'Inline instructions.' }); await extension(inline.pi);
  expect(inline.section()).toContain('Inline instructions.'); expect(inline.readFile).not.toHaveBeenCalled();
});

it('loads custom instructions through the runtime through core runtime I/O', async () => {
  const h = harness({ style: 'custom', instructionsFile: 'style.md' });
  await extension(h.pi);
  expect(h.readFile).toHaveBeenCalledWith('/agent/style.md'); expect(h.section()).toContain('Runtime instructions.');
});

it.each(['/explicit/style.md', '~/style.md'])("leaves host path authority with the runtime for %s", async path => {
  const h = harness({ style: 'custom', instructionsFile: path });
  await extension(h.pi); expect(h.readFile).toHaveBeenCalledWith(path);
});

it('preserves precise file failures and registers no partial extension', async () => {
  const missing = harness({ style: 'custom', instructionsFile: 'missing.md' });
  missing.readFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await expect(extension(missing.pi)).rejects.toThrow('outputStyle.instructionsFile not found: /agent/missing.md');
  expect(missing.on).not.toHaveBeenCalled();
  const empty = harness({ style: 'custom', instructionsFile: 'empty.md' });
  empty.readFile.mockResolvedValueOnce(new Uint8Array());
  await expect(extension(empty.pi)).rejects.toThrow('outputStyle.instructionsFile is empty: /agent/empty.md');
  expect(empty.on).not.toHaveBeenCalled();
});

it('rejects conflicting sources, NUL paths, and NUL paths', async () => {
  const conflict = harness({ style: 'custom', instructions: 'inline', instructionsFile: 'file' });
  expect(() => extension(conflict.pi)).toThrow('cannot both be set');
  const nul = harness({ style: 'custom', instructionsFile: 'bad\0path' });
  expect(() => extension(nul.pi)).toThrow('must not contain NUL bytes'); expect(nul.readFile).not.toHaveBeenCalled();
});
