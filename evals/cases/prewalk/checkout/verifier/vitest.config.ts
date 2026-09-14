import { resolve } from 'node:path';

const workspace = resolve(process.env.STORZY_ROOT ?? '/workspace');

export default {
  root: workspace,
  resolve: {
    alias: { '@': workspace },
  },
  test: {
    environment: 'node',
    environmentOptions: {
      jsdom: { url: 'http://localhost/' },
    },
    passWithNoTests: false,
  },
};
