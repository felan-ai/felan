import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import sourceExtension from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));

const packageRoot = resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);

describe('built Web Access runtime', () => {
  it('matches the two source tools and excludes image and PDF worker modules', async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    const distEntry = resolve(packageRoot, manifest.exports['.'].import);
    await access(distEntry);

    const builtExtension = (await import(`${pathToFileURL(distEntry).href}?smoke=${Date.now()}`)).default;
    const sourceTools = await registeredTools(sourceExtension);
    const builtTools = await registeredTools(builtExtension);
    expect([...sourceTools.keys()]).toEqual(['web_search', 'fetch_content']);
    expect([...builtTools.keys()]).toEqual(['web_search', 'fetch_content']);

    const distSources = (await readdir(resolve(packageRoot, 'dist'))).filter((entry) => entry.endsWith('.js'));
    expect(distSources).not.toContain('image.js');
    expect(distSources).not.toContain('image-resize.js');
    expect(distSources).not.toContain('pdf.js');
    const combinedSource = (await Promise.all(distSources.map((entry) => (
      readFile(resolve(packageRoot, 'dist', entry), 'utf8')
    )))).join('\n');
    expect(combinedSource).not.toMatch(/unpdf|pdfjs|PDF_WORKER_SOURCE/iu);
    expect(combinedSource).toContain('felan:markitdown:pdf-convert:v1');
    expect(combinedSource).not.toMatch(/@felan-ai\/ext-markitdown|documents\.pdf\/v1|getExtensionService/u);
    await exerciseToolEntrypoints(builtTools);
  });

  it('packs only the public package surface and executes both packed tools offline', async () => {
    const temporary = await mkdtemp(resolve(packageRoot, '.packed-test-'));
    try {
      const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      const packageManager = process.env.npm_execpath;
      if (packageManager) {
        await execFileAsync(process.execPath, [packageManager, 'pack', '--pack-destination', temporary], {
          cwd: packageRoot,
        });
      } else {
        await execFileAsync(pnpm, ['pack', '--pack-destination', temporary], {
          cwd: packageRoot,
          shell: process.platform === 'win32',
        });
      }
      const archiveName = (await readdir(temporary)).find((name) => name.endsWith('.tgz'));
      expect(archiveName).toBeDefined();
      const listing = await execFileAsync('tar', ['-tzf', archiveName!], { cwd: temporary });
      const entries = listing.stdout.split(/\r?\n/u).filter(Boolean);
      expect(entries).toContain('package/package.json');
      expect(entries.some((entry) => entry === 'package/dist/index.js')).toBe(true);
      expect(entries.some((entry) => /package\/dist\/image(?:-resize)?\./u.test(entry))).toBe(false);
      expect(entries.some((entry) => entry === 'package/dist/pdf.js')).toBe(false);
      expect(entries.every((entry) => /^(?:package\/(?:dist(?:\/|$)|LICENSE$|NOTICE$|README\.md$|package\.json$))/u.test(entry)))
        .toBe(true);

      await execFileAsync('tar', ['-xzf', archiveName!], { cwd: temporary });
      const entry = resolve(temporary, 'package/dist/index.js');
      const packedExtension = (await import(`${pathToFileURL(entry).href}?packed=${Date.now()}`)).default;
      const packedTools = await registeredTools(packedExtension);
      expect([...packedTools.keys()]).toEqual(['web_search', 'fetch_content']);
      await exerciseToolEntrypoints(packedTools);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 30_000);
});

async function registeredTools(extension: any): Promise<Map<string, any>> {
  const tools = new Map<string, any>();
  await extension({
    config: {},
    runtime: {
      kind: 'host',
      cwd: '/workspace',
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCapability: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
    sendMessage: vi.fn(),
    on: vi.fn(),
  } as unknown as FelanExtensionAPI);
  return tools;
}

async function exerciseToolEntrypoints(tools: Map<string, any>): Promise<void> {
  const fetchContent = tools.get('fetch_content');
  expect(fetchContent.parameters.properties.ignoreLlmsTxt).toMatchObject({
    type: 'boolean',
    default: false,
  });
  expect(fetchContent.description).toContain('Origin-root /llms.txt replaces HTML by default');
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.pathname === '/llms.txt') {
      return new Response('PACKED_LLMS_TERM', { headers: { 'content-type': 'text/plain' } });
    }
    return new Response('<html><body>REQUESTED_HTML_ONLY</body></html>', {
      headers: { 'content-type': 'text/html' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const fetched = await fetchContent.execute(
    'content-success',
    { urls: ['https://93.184.216.34/guide'], findText: ['PACKED_LLMS_TERM'] },
    undefined,
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetched.content[0].text).toContain('PACKED_LLMS_TERM');
  expect(fetched.content[0].text).toContain('https://93.184.216.34/llms.txt');
  expect(fetched.content[0].text).not.toContain('REQUESTED_HTML_ONLY');
  await expect(tools.get('web_search').execute(
    'search',
    { query: '', provider: 'searxng' },
    undefined,
    undefined,
    { modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false } },
  )).rejects.toThrow('non-empty strings');
  await expect(fetchContent.execute(
    'content',
    { urls: ['file:///private'], findText: ['evidence'] },
    undefined,
  )).rejects.toThrow('Only HTTP and HTTPS URLs are supported');
}
