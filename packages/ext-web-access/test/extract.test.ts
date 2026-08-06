import type { AgentRuntime } from '@felan-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractContent } from '../src/extract.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));
import { extractGitHubRepository, parseGitHubUrl } from '../src/github.js';
import { readResponseBytes } from '../src/http.js';

describe('content extraction', () => {
  const proxy = process.env.HTTPS_PROXY;
  const noProxy = process.env.NO_PROXY;

  beforeEach(() => {
    process.env.HTTPS_PROXY = 'http://proxy.example:8080';
    process.env.NO_PROXY = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (proxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = proxy;
    if (noProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = noProxy;
  });

  it('converts Readability HTML to Markdown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<!doctype html><html><head><title>Docs</title></head><body><article><h1>Guide</h1><p>Hello <a href="https://docs.example/link">reader</a>.</p></article></body></html>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })));
    const result = await extractContent('https://docs.example/guide', runtime(), {
      ssrf: {},
    });
    expect(result.title).toMatch(/Guide|Docs/u);
    expect(result.content).toContain('# Guide');
    expect(result.content).toContain('[reader](https://docs.example/link)');
  });

  it('aborts bounded response reads before retaining oversized bodies', async () => {
    const response = new Response(Uint8Array.from([1, 2, 3, 4]));
    await expect(readResponseBytes(response, 3)).rejects.toThrow('Response exceeds the 3-byte limit');
  });

  it('extracts PDF text with unpdf', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(buildPdf('Hello from PDF'), {
      headers: { 'content-type': 'application/pdf' },
    })));
    const result = await extractContent('https://docs.example/sample.pdf', runtime(), {
      ssrf: {},
    });
    expect(result.contentType).toBe('application/pdf');
    expect(result.content).toContain('Hello from PDF');
  });

  it('clones and reads GitHub repositories only through AgentRuntime storage and exec', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ size: 10 }), {
      headers: { 'content-type': 'application/json' },
    })));
    let cloned = false;
    const storage = {
      root: '/session',
      mkdir: vi.fn(),
      remove: vi.fn(),
      listFiles: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        if (!cloned) return [];
        if (options?.recursive && path.includes('/repos/')) return ['README.md', 'src/index.ts'];
        return ['README.md'];
      }),
      readFile: vi.fn(async (path: string) => new TextEncoder().encode(path.endsWith('README.md') ? '# Repo' : 'export const value = 1;')),
      writeFile: vi.fn(),
    };
    const agentRuntime = {
      kind: 'host',
      cwd: '/workspace',
      storage: vi.fn(() => storage),
      exec: vi.fn(async () => {
        cloned = true;
        return { stdout: '', stderr: '', code: 0, killed: false };
      }),
    } as unknown as AgentRuntime;
    const info = parseGitHubUrl('https://github.com/felan-ai/felan')!;
    const result = await extractGitHubRepository('https://github.com/felan-ai/felan', info, agentRuntime, {
      ssrf: {},
    });

    expect(agentRuntime.exec).toHaveBeenCalledWith('git', expect.arrayContaining([
      'clone',
      'https://github.com/felan-ai/felan.git',
    ]), expect.objectContaining({ timeout: 30_000 }));
    expect(storage.readFile).toHaveBeenCalled();
    expect(result.content).toContain('## README.md');
    expect(result.content).toContain('export const value = 1;');
  });
});

function runtime(): AgentRuntime {
  return {
    kind: 'host',
    cwd: '/workspace',
  } as unknown as AgentRuntime;
}

function buildPdf(text: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
