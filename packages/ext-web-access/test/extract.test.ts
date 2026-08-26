import type { AgentRuntime } from '@felan-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractContent } from '../src/extract.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
import { cleanupGitHubRepositories, extractGitHubRepository, parseGitHubUrl } from '../src/github.js';
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
    const commit = 'b'.repeat(40);
    const agentRuntime = {
      kind: 'host',
      cwd: '/workspace',
      storage: vi.fn(() => storage),
      exec: vi.fn(async (_command: string, args: readonly string[]) => {
        cloned = true;
        return { stdout: args.includes('rev-parse') ? `${commit}\n` : '', stderr: '', code: 0, killed: false };
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
    expect(result.repository).toMatchObject({ mode: 'local-checkout', commit });
    expect(storage.readFile).toHaveBeenCalled();
    expect(result.content).toContain('## README.md');
    expect(result.content).toContain('## Structure');
    expect(result.content).toContain('## README.md');
  });

  it('rejects malformed or separator-containing GitHub path segments', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo/tree/%E0%A4%A')).toBeUndefined();
    expect(parseGitHubUrl('https://github.com/owner/repo/tree/main%2Fsrc')).toBeUndefined();
    expect(parseGitHubUrl('https://github.com/owner/repo/tree/main/src%5Cindex.ts')).toBeUndefined();
  });

  it('uses a bounded GitHub API view for managed runtimes without executing git', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://api.github.com/repos/owner/repo') return jsonResponse({ default_branch: 'main' });
      if (url === 'https://api.github.com/repos/owner/repo/commits/main') return jsonResponse({ sha: 'A'.repeat(40) });
      if (url === 'https://api.github.com/repos/owner/repo/git/trees/' + 'a'.repeat(40) + '?recursive=1') {
        return jsonResponse({ tree: [{ path: 'README.md', type: 'blob' }, { path: 'src/index.ts', type: 'blob' }], truncated: false });
      }
      if (url === 'https://api.github.com/repos/owner/repo/readme?ref=' + 'a'.repeat(40)) {
        return jsonResponse({ encoding: 'base64', content: Buffer.from('# API repo').toString('base64') });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const agentRuntime = {
      kind: 'docker',
      cwd: '/workspace',
      exec: vi.fn(),
      storage: vi.fn(),
    } as unknown as AgentRuntime;
    const info = parseGitHubUrl('https://github.com/owner/repo')!;
    const result = await extractGitHubRepository('https://github.com/owner/repo', info, agentRuntime, { ssrf: {} });

    expect(agentRuntime.exec).not.toHaveBeenCalled();
    expect(result.repository).toEqual({ owner: 'owner', repo: 'repo', mode: 'github-api', commit: 'a'.repeat(40) });
    expect(result.content).toContain('README.md');
    expect(result.content).toContain('# API repo');
  });

  it('fetches and verifies full commit SHA checkouts without using --branch', async () => {
    const commit = 'c'.repeat(40);
    let cloned = false;
    const storage = {
      root: '/session',
      mkdir: vi.fn(),
      remove: vi.fn(),
      listFiles: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        if (!cloned) return [];
        if (options?.recursive && path.includes('/repos/')) return ['README.md'];
        return ['README.md'];
      }),
      readFile: vi.fn(async () => new TextEncoder().encode('# Repo')),
      writeFile: vi.fn(),
    };
    const agentRuntime = {
      kind: 'host',
      cwd: '/workspace',
      storage: vi.fn(() => storage),
      exec: vi.fn(async (_command: string, args: readonly string[]) => {
        if (args.includes('clone')) cloned = true;
        return { stdout: args.includes('rev-parse') ? `${commit}\n` : '', stderr: '', code: 0, killed: false };
      }),
    } as unknown as AgentRuntime;
    const url = `https://github.com/owner/repo/tree/${commit}`;
    const result = await extractGitHubRepository(url, parseGitHubUrl(url)!, agentRuntime, { ssrf: {} }, undefined, true);

    const calls = (agentRuntime.exec as ReturnType<typeof vi.fn>).mock.calls as Array<[string, readonly string[]]>;
    expect(calls.some(([, args]) => args.includes('--branch'))).toBe(false);
    expect(calls.some(([, args]) => args.includes('fetch') && args.includes(commit))).toBe(true);
    expect(calls.some(([, args]) => args.includes('checkout') && args.includes('--detach'))).toBe(true);
    expect(result.repository).toMatchObject({ mode: 'local-checkout', commit });
  });

  it('cleans session checkouts through the runtime storage boundary', async () => {
    const remove = vi.fn(async () => undefined);
    const agentRuntime = {
      kind: 'host',
      cwd: '/workspace',
      storage: vi.fn(() => ({ root: '/session', remove })),
    } as unknown as AgentRuntime;

    await cleanupGitHubRepositories(agentRuntime);

    expect(remove).toHaveBeenCalledWith('/session/web-access/repos', { recursive: true });
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}
