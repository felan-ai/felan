import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-web-access package boundary', () => {
  it('publishes only the current pinned runtime dependencies', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-web-access',
      version: '0.5.0',
      description: 'Secure bounded web search and content access for Felan',
      license: 'MIT',
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
      peerDependencies: { '@felan-ai/agent-core': '^0.5.0' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
      scripts: {
        test: 'vitest run && pnpm run test:dist',
        'test:dist': 'pnpm run build && vitest run --config test/vitest.dist.config.ts',
      },
    });
    expect(manifest.dependencies).toEqual({
      '@mozilla/readability': '0.6.0',
      linkedom: '0.16.11',
      turndown: '7.2.0',
      typebox: '1.1.38',
      undici: '8.10.0',
    });
    expect(notice).toContain('pi-web-access 0.18.0');
    expect(notice).toContain('d2aab00dcf0547572276d9de4bc4a2a49d640e13');
    expect(notice).toContain('undici 8.10.0');
    expect(notice).not.toMatch(/promise\.try|unpdf|PDF\.js|pdfjs-dist/iu);
    expect(notice).not.toMatch(/pi-web-access 0\.23\.0/u);
  });

  it('contains only the bounded search/content modules and approved runtime boundaries', async () => {
    const sourcePaths = await sourceFiles(join(packageRoot, 'src'));
    const relativePaths = sourcePaths
      .map((path) => relative(join(packageRoot, 'src'), path).replaceAll('\\', '/'))
      .sort();
    const sources = await Promise.all(sourcePaths.map((path) => readFile(path, 'utf8')));
    const combined = sources.join('\n');

    expect(relativePaths).toEqual([
      'boundary.ts',
      'config.ts',
      'content-find.ts',
      'credentials.ts',
      'extract.ts',
      'http.ts',
      'index.ts',
      'pdf-service.ts',
      'providers.ts',
      'ssrf.ts',
      'types.ts',
      'url.ts',
    ]);
    expect(combined).not.toMatch(/node:(?:child_process|fs)/u);
    expect(combined).not.toMatch(/\.\/(?:github|source-check|storage|promise-try)\.js/u);
    expect(combined).not.toMatch(/(?:unpdf|pdfjs|PDF_WORKER_SOURCE)/u);
    expect(combined).not.toMatch(/fetch_image|image-resize|native image|image-capable/iu);
    expect(combined).toContain("MARKITDOWN_PDF_EVENT = 'felan:markitdown:pdf-convert:v1'");
    expect(combined).not.toMatch(/@felan-ai\/ext-markitdown|documents\.pdf\/v1|getExtensionService/u);
    expect(combined).not.toMatch(/schedulePdfDeliveries|deliverScheduledPdfs|scheduledPdfCount|sendMessage/u);
    expect(combined).not.toMatch(/\b(?:get_search_content|source_check|registerCapability|appendEntry)\b/u);
    expect(combined).not.toMatch(/runtime\.storage|storage\(['"]session['"]\)|session_(?:start|shutdown)|before_agent_start/u);
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return nested.flat().filter((path) => path.endsWith('.ts'));
}
