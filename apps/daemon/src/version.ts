import { createRequire } from 'node:module';

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

export const DAEMON_VERSION = packageJson.version;
