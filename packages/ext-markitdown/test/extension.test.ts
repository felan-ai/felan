import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  HostAgentRuntime,
  type AgentRuntime,
  type ExecOptions,
  type ExtensionContext,
  type FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import markitdownExtension, {
  MARKITDOWN_CAPABILITY_INSTRUCTION,
  MARKITDOWN_EXCLUDED_EXTENSIONS,
  MARKITDOWN_EXTENSIONS,
  MAX_MARKITDOWN_INPUT_BYTES,
  MAX_MARKITDOWN_OUTPUT_BYTES,
  isMarkitdownDocument,
  setActiveMarkitdownEnabled,
} from '../src/index.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('MarkItDown extension', () => {
  it('keeps the document allowlist without PDF, image, audio, or generic archive formats', () => {
    expect(MARKITDOWN_EXTENSIONS).toEqual([
      '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls',
      '.rtf', '.epub', '.msg',
    ]);
    expect(MARKITDOWN_EXCLUDED_EXTENSIONS).toEqual([
      '.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.gif', '.webp',
    ]);
    expect(isMarkitdownDocument('REPORT.DOCX')).toBe(true);
    for (const extension of [...MARKITDOWN_EXCLUDED_EXTENSIONS, '.zip', '.wav', '.mp3', '.txt', '.html', '.json']) {
      expect(isMarkitdownDocument(`document${extension}`)).toBe(false);
    }
  });

  it('converts a staged copy, preserves read navigation, caches by content, and appends an untrusted-data diagnostic', async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, '-- quarterly report.DOCX');
    await writeFile(sourcePath, 'binary document one');
    const harness = createHarness(fixture.runtime);
    markitdownExtension(harness.pi);

    expect(harness.capabilities).toEqual([{
      id: 'markitdown',
      instructions: MARKITDOWN_CAPABILITY_INSTRUCTION,
    }]);

    const first = readCall('call-1', sourcePath, 4, 8);
    await expect(harness.emit('tool_call', first)).resolves.toBeUndefined();
    expect(first.input).toMatchObject({ offset: 4, limit: 8 });
    expect(first.input.path).not.toBe(sourcePath);
    expect(first.input.path).toContain(join(fixture.session, 'markitdown', 'cache'));
    const cachePath = first.input.path;
    expect(fixture.conversions).toHaveLength(1);
    expect(fixture.conversions[0]!.inputPath).toContain(join(fixture.session, 'markitdown', 'staging'));
    expect(fixture.conversions[0]!.inputPath).not.toContain(basename(sourcePath));
    await expect(readFile(first.input.path, 'utf8')).resolves.toBe('converted markdown\n');

    const firstResult = await harness.emit('tool_result', {
      type: 'tool_result',
      toolName: 'read',
      toolCallId: 'call-1',
      input: first.input,
      content: [{ type: 'text', text: 'converted markdown' }],
      details: undefined,
      isError: false,
    }) as { content: Array<{ type: string; text: string }> };
    expect(firstResult.content[0]!.text).toContain('"cache":"miss"');
    expect(firstResult.content[0]!.text).toContain(JSON.stringify(sourcePath).slice(1, -1));
    expect(firstResult.content[0]!.text).toContain('untrusted data');
    expect(first.input.path).toBe(sourcePath);

    const second = readCall('call-2', sourcePath);
    await harness.emit('tool_call', second);
    expect(second.input.path).toBe(cachePath);
    expect(fixture.conversions).toHaveLength(1);
    const secondResult = await harness.emit('tool_result', {
      type: 'tool_result',
      toolName: 'read',
      toolCallId: 'call-2',
      input: second.input,
      content: [{ type: 'text', text: 'converted markdown' }],
      details: undefined,
      isError: false,
    }) as { content: Array<{ type: string; text: string }> };
    expect(secondResult.content[0]!.text).toContain('"cache":"hit"');

    await writeFile(sourcePath, 'binary document two');
    const changed = readCall('call-3', sourcePath);
    await harness.emit('tool_call', changed);
    expect(changed.input.path).not.toBe(cachePath);
    expect(fixture.conversions).toHaveLength(2);
  });

  it('does not inspect PDFs, images, text files, or non-read tool calls', async () => {
    const fixture = await createFixture();
    const harness = createHarness(fixture.runtime);
    markitdownExtension(harness.pi);

    for (const path of ['local.pdf', 'image.PNG', 'scan.tiff', 'notes.txt']) {
      const event = readCall(`read-${path}`, path);
      await expect(harness.emit('tool_call', event)).resolves.toBeUndefined();
      expect(event.input.path).toBe(path);
    }
    await expect(harness.emit('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'write-1',
      input: { path: 'document.docx', content: 'x' },
    })).resolves.toBeUndefined();
    expect(fixture.exec).not.toHaveBeenCalled();
  });

  it('rejects PDF and image signatures disguised with supported extensions', async () => {
    const fixture = await createFixture();
    const harness = createHarness(fixture.runtime);
    markitdownExtension(harness.pi);
    const disguised = [
      { name: 'renamed-pdf.docx', content: Buffer.from('prefix%PDF-1.7') },
      { name: 'renamed-image.pptx', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ];

    for (const item of disguised) {
      const path = join(fixture.workspace, item.name);
      await writeFile(path, item.content);
      const result = await harness.emit('tool_call', readCall(item.name, path)) as {
        block: boolean;
        reason: string;
      };
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain('intentionally does not handle');
    }
    expect(fixture.conversions).toHaveLength(0);
  });

  it('serializes concurrent reads so identical content is converted once', async () => {
    const fixture = await createFixture();
    const source = join(fixture.workspace, 'shared.xlsx');
    await writeFile(source, 'same workbook');
    const harness = createHarness(fixture.runtime);
    markitdownExtension(harness.pi);
    const first = readCall('parallel-1', source);
    const second = readCall('parallel-2', source);

    await Promise.all([
      harness.emit('tool_call', first),
      harness.emit('tool_call', second),
    ]);

    expect(fixture.conversions).toHaveLength(1);
    expect(first.input.path).toBe(second.input.path);
  });

  it('lets the host disable interception immediately', async () => {
    const fixture = await createFixture();
    const harness = createHarness(fixture.runtime);
    markitdownExtension(harness.pi);
    setActiveMarkitdownEnabled(fixture.runtime, false);
    const call = readCall('disabled', join(fixture.workspace, 'disabled.docx'));

    expect(await harness.emit('tool_call', call)).toBeUndefined();
    expect(call.input.path).toContain('disabled.docx');
    expect(fixture.conversions).toHaveLength(0);
  });

  it('bypasses conversion when MarkItDown is unavailable and still fails closed on path errors', async () => {
    const unavailable = await createFixture({ markitdownAvailable: false });
    const unavailableHarness = createHarness(unavailable.runtime);
    markitdownExtension(unavailableHarness.pi);
    const unavailableCall = readCall('missing-cli', 'report.docx');
    const unavailableResult = await unavailableHarness.emit('tool_call', unavailableCall);
    expect(unavailableResult).toBeUndefined();
    expect(unavailableCall.input.path).toBe('report.docx');
    expect(unavailable.conversions).toHaveLength(0);

    const fixture = await createFixture();
    const harness = createHarness(fixture.runtime);
    markitdownExtension(harness.pi);
    const outside = join(fixture.root, 'outside.docx');
    await writeFile(outside, 'outside');
    const pathResult = await harness.emit('tool_call', readCall('outside', outside)) as {
      block: boolean;
      reason: string;
    };
    expect(pathResult).toMatchObject({ block: true });
    expect(pathResult.reason).toContain('cannot read');
    expect(fixture.conversions).toHaveLength(0);
  });

  it('enforces input, output, timeout, nonzero-exit, and empty-output boundaries', async () => {
    const cases = [
      { mode: 'oversized-input' as const, expected: '20 MiB input limit' },
      { mode: 'oversized-output' as const, expected: '10 MiB' },
      { mode: 'timeout' as const, expected: '60-second limit' },
      { mode: 'failure' as const, expected: 'exited with code 9' },
      { mode: 'empty' as const, expected: 'no document text' },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture({ conversionMode: testCase.mode });
      const source = join(fixture.workspace, `${testCase.mode}.docx`);
      const content = testCase.mode === 'oversized-input'
        ? Buffer.alloc(MAX_MARKITDOWN_INPUT_BYTES + 1)
        : Buffer.from('document');
      await writeFile(source, content);
      const harness = createHarness(fixture.runtime);
      markitdownExtension(harness.pi);
      const result = await harness.emit('tool_call', readCall(testCase.mode, source)) as {
        block: boolean;
        reason: string;
      };
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain(testCase.expected);
      if (testCase.mode === 'oversized-output') {
        expect(fixture.outputBytes).toBe(MAX_MARKITDOWN_OUTPUT_BYTES + 1);
      }
    }
  });

  it('reports only explicit installation and supported-format status through /markitdown', async () => {
    const fixture = await createFixture({ markitdownAvailable: false });
    const harness = createHarness(fixture.runtime);
    markitdownExtension(harness.pi);

    await harness.commands.get('markitdown')!('', context(harness.notifications));
    expect(harness.notifications.at(-1)?.message).toContain('Installation is never automatic');
    expect(harness.notifications.at(-1)?.message).toContain('Converted: .docx');
    expect(harness.notifications.at(-1)?.message).toContain('Excluded PDF/images: .pdf');
  });
});

type ConversionMode = 'success' | 'oversized-input' | 'oversized-output' | 'timeout' | 'failure' | 'empty';

async function createFixture(options: {
  markitdownAvailable?: boolean;
  conversionMode?: ConversionMode;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'felan-markitdown-'));
  temporaryPaths.push(root);
  const workspace = join(root, 'workspace');
  const session = join(root, 'session');
  const agent = join(root, 'agent');
  await Promise.all([workspace, session, agent].map((path) => mkdir(path, { recursive: true })));
  const host = new HostAgentRuntime(workspace, {
    sessionStorageRoot: session,
    agentStorageRoot: agent,
  });
  const conversions: Array<{ inputPath: string; outputPath: string }> = [];
  let outputBytes = 0;
  const exec = vi.fn(async (command: string, args: readonly string[], _options?: ExecOptions) => {
    if (args.at(-1) === '--version') {
      const available = options.markitdownAvailable !== false && command === 'markitdown';
      return available
        ? { stdout: 'markitdown 0.1.7\n', stderr: '', code: 0, killed: false }
        : { stdout: '', stderr: 'not found', code: 127, killed: false };
    }

    const outputIndex = args.indexOf('-o');
    if (command !== 'markitdown' || outputIndex < 0 || outputIndex > args.length - 3) {
      return { stdout: '', stderr: 'unexpected command', code: 2, killed: false };
    }
    const outputPath = args[outputIndex + 1]!;
    const inputPath = args[outputIndex + 2]!;
    conversions.push({ inputPath, outputPath });
    await readFile(inputPath);
    const mode = options.conversionMode ?? 'success';
    if (mode === 'timeout') return { stdout: '', stderr: '', code: 143, killed: true };
    if (mode === 'failure') return { stdout: '', stderr: 'unsafe\u001b[31m failure', code: 9, killed: false };
    const output = mode === 'oversized-output'
      ? Buffer.alloc(MAX_MARKITDOWN_OUTPUT_BYTES + 1, 65)
      : Buffer.from(mode === 'empty' ? ' \n' : 'converted markdown\u0000');
    outputBytes = output.byteLength;
    await writeFile(outputPath, output);
    return { stdout: '', stderr: '', code: 0, killed: false };
  });
  const runtime: AgentRuntime = {
    kind: host.kind,
    cwd: host.cwd,
    storage: host.storage.bind(host),
    exec,
    shell: host.shell.bind(host),
    readFile: host.readFile.bind(host),
    writeFile: host.writeFile.bind(host),
    listFiles: host.listFiles.bind(host),
    mkdir: host.mkdir.bind(host),
    remove: host.remove.bind(host),
  };
  return {
    root,
    workspace,
    session,
    runtime,
    exec,
    conversions,
    get outputBytes() { return outputBytes; },
  };
}

function createHarness(runtime: AgentRuntime) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const capabilities: Array<{ id: string; instructions: string }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = {
    runtime,
    agentDir: '/agent',
    registerCapability: (capability: { id: string; instructions: string }) => capabilities.push(capability),
    on: (name: string, handler: Handler) => {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
  } as unknown as FelanExtensionAPI;
  return {
    pi,
    commands,
    capabilities,
    notifications,
    async emit(name: string, event: unknown) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, context(notifications));
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

function context(notifications: Array<{ message: string; type?: string }>): ExtensionContext {
  return {
    mode: 'print',
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      notify: (message: string, type?: string) => notifications.push({
        message,
        ...(type === undefined ? {} : { type }),
      }),
    },
  } as unknown as ExtensionContext;
}

function readCall(toolCallId: string, path: string, offset?: number, limit?: number) {
  return {
    type: 'tool_call',
    toolName: 'read',
    toolCallId,
    input: {
      path,
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    },
  };
}
