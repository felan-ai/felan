import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const roots = {
  '/protocol/': await realpath(resolve(here, '../dist')),
  '/typebox/': await realpath(resolve(here, '../node_modules/typebox/build')),
};
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(await readFile(resolve(here, 'browser-smoke.html')));
      return;
    }
    for (const [prefix, root] of Object.entries(roots)) {
      if (!path.startsWith(prefix)) continue;
      const file = await realpath(resolve(root, decodeURIComponent(path.slice(prefix.length))));
      if (!file.startsWith(root + sep) || !/\.m?js$/.test(file)) break;
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(await readFile(file));
      return;
    }
    response.writeHead(404).end();
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(0, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}/`);
});
