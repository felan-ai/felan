import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('portable source discipline', () => {
  it('routes process, temporary storage, and execution through AgentRuntime', async () => {
    const files = await sourceFiles(join(root, 'src'));
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
    expect(source).not.toMatch(/node:child_process|\bspawn\s*\(/u);
    expect(source).not.toContain('process.env');
    expect(source).not.toMatch(/node:os|\bos\.tmpdir|\btmpdir\s*\(/u);
  });

  it('preserves upstream attribution in package and root notices', async () => {
    await expect(readFile(join(root, 'NOTICE'), 'utf8')).resolves.toContain('mslavov/pi-extensions');
    await expect(readFile(join(root, '../../NOTICE'), 'utf8')).resolves.toContain('pi-cbm-proxy');
  });
});

async function sourceFiles(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sourceFiles(join(path, entry.name))
    : entry.name.endsWith('.ts') ? [join(path, entry.name)] : []))).flat();
}
