import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolvePiLlamaCppExtensionPath(
  resolveEntry: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
): string {
  try {
    const entry = resolveEntry('@earendil-works/pi-coding-agent');
    const path = fileURLToPath(new URL('./extensions/llama/index.js', entry));
    if (!statSync(path).isFile()) throw new Error('Pi llama.cpp entry is not a file');
    return path;
  } catch (cause) {
    throw new Error(
      'Could not resolve the bundled Pi llama.cpp extension. The installed Pi version may be incompatible with Felan\'s llama.cpp adapter.',
      { cause },
    );
  }
}
