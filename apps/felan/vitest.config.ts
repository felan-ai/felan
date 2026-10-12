import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [{
      find: /^@felan-ai\/daemon\/internal\/(.+)$/,
      replacement: `${fileURLToPath(new URL('../daemon/src/', import.meta.url))}$1.ts`,
    }],
  },
});
