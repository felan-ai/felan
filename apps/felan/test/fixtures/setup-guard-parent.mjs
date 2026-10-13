import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('./setup-guard-child.mjs', import.meta.url))], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', data => process.stdout.write(data, () => process.exit(0)));
child.once('error', () => process.exit(1));
child.once('exit', () => process.exit(1));
