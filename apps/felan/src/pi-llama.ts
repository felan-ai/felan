import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolvePiLlamaCppExtensionPath(
  resolveEntry: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
): string {
  try {
    const entry = resolveEntry('@earendil-works/pi-coding-agent');
    const provider = fileURLToPath(new URL('./extensions/llama/provider.js', entry));
    if (!statSync(provider).isFile()) throw new Error('Pi llama.cpp provider is not a file');
    const path = fileURLToPath(resolveEntry('@felan-ai/daemon/internal/llama/extension'));
    if (!statSync(path).isFile()) throw new Error('Felan llama.cpp adapter is not a file');
    return path;
  } catch (cause) {
    throw new Error(
      'Could not resolve the bundled Pi llama.cpp extension. The installed Pi version may be incompatible with Felan\'s llama.cpp adapter.',
      { cause },
    );
  }
}
