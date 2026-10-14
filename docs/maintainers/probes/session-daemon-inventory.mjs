import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../../..');
const registrations = [];
const presentationRegistrations = [];
const providerRegistrations = [];
const uiCalls = [];
const renderers = [];
const ambientEnvironment = [];
const packages = [];
const skippedDirectories = [];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (/\.tsx?$/.test(entry.name)) {
      const source = await readFile(path, 'utf8');
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const location = (node) => ({ path: relative(root, path), line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          if (['registerCommand', 'registerShortcut', 'registerTool'].includes(method)) {
            const first = node.arguments[0];
            const named = first && ts.isObjectLiteralExpression(first)
              ? first.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(file) === 'name')
              : undefined;
            registrations.push({ ...location(node), method, value: named?.initializer.getText(file) ?? first?.getText(file) ?? '' });
          }
          if (['registerMessageRenderer', 'registerMarkdownTransformer'].includes(method)) {
            presentationRegistrations.push({ ...location(node), method, value: node.arguments[0]?.getText(file) ?? '' });
          }
          if (['registerProvider', 'registerNativeProvider', 'unregisterProvider'].includes(method)) {
            providerRegistrations.push({ ...location(node), method, value: node.arguments[0]?.getText(file) ?? '' });
          }
          if (/\.ui$/.test(node.expression.expression.getText(file))) uiCalls.push({ ...location(node), method });
        }
        if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && ['renderCall', 'renderResult'].includes(node.name?.getText(file))) renderers.push({ ...location(node), method: node.name.getText(file) });
        if (ts.isPropertyAccessExpression(node) && node.getText(file) === 'process.env') ambientEnvironment.push(location(node));
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
  }
}

for (const directory of ['apps/tui', ...(await readdir(resolve(root, 'packages'))).map((name) => `packages/${name}`)]) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(root, directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    skippedDirectories.push(directory);
    continue;
  }
  packages.push({ path: directory, name: manifest.name, version: manifest.version, exports: manifest.exports });
  await scan(resolve(root, directory, 'src'));
}
const piCommands = await readFile(resolve(root, 'apps/tui/node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js'), 'utf8');
const bundledLlama = [];
for (const name of ['index.js', 'provider.js', 'huggingface.js', 'ui.js']) {
  const path = `apps/tui/node_modules/@earendil-works/pi-coding-agent/dist/extensions/llama/${name}`;
  const source = await readFile(resolve(root, path), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const findings = [];
  function visit(node) {
    const location = { line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 };
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (['registerProvider', 'registerNativeProvider', 'registerCommand'].includes(method)) {
        findings.push({ ...location, method, value: node.arguments[0]?.getText(file) ?? '' });
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.getText(file) === 'process.env') findings.push({ ...location, method: 'ambient-env' });
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'homedir') findings.push({ ...location, method: 'ambient-home' });
    ts.forEachChild(node, visit);
  }
  visit(file);
  bundledLlama.push({ path, sourceSha256: createHash('sha256').update(source).digest('hex'), findings });
}
let cliOptions;
if (process.argv.includes('--include-cli')) {
  const { loadLocalExtensionConfigDefinitions } = await import('../../../apps/tui/dist/extensions.js');
  const { getExtensionConfigCliOptions } = await import('../../../packages/agent-core/dist/index.js');
  cliOptions = getExtensionConfigCliOptions(await loadLocalExtensionConfigDefinitions()).map((option) => ({
    name: option.name, type: option.configField.type, deprecated: option.configField.deprecated ?? false,
  }));
}
console.log(JSON.stringify({ packages, skippedDirectories, registrations, presentationRegistrations, providerRegistrations, bundledLlama, uiCalls, renderers, ambientEnvironment, cliOptions, piSlashCommands: [...piCommands.matchAll(/name: "([^"]+)"/g)].map((match) => match[1]) }, null, 2));
