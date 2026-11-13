import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const portablePath = (path: string) => path.split(sep).join('/');

interface Boundary {
  reason: string;
  paths: string[];
  graph?: boolean;
  exclude?: RegExp;
  forbidden?: RegExp[];
  required?: RegExp[];
  forbiddenFiles?: RegExp;
  requiredFiles?: RegExp[];
  allowedImports?: RegExp;
}

const extension = (name: string) => `packages/ext-${name}/src`;
const renderer = (name: string) => `apps/felan/src/tui/renderers/${name}`;
const noHostIo = /node:(?:child_process|fs)/u;
const noCloud = /@felan-cloud|felan-platform|daytona-sdk/u;
const noTui = /@earendil-works\/pi-tui/u;
const rendering = ['ask-user', 'background-bash', 'codebase-memory', 'codex', 'context-view', 'fusion', 'powerline', 'prewalk', 'prompt-history', 'tasks'];

const boundaries: Boundary[] = [
  {
    reason: 'Extensions emit portable data, not terminal renderers',
    paths: rendering.map(extension),
    forbidden: [/\b(?:renderCall|renderResult|renderCalls|toolPresentation|registerMessageRenderer)\b/u],
  },
  {
    reason: 'Only prompt-history ranking may import the pinned TUI helper',
    paths: rendering.map(extension),
    exclude: /packages\/ext-prompt-history\/src\/history\.ts$/u,
    forbidden: [noTui],
  },
  { reason: 'Prompt-history may use only the public pinned ranking helper', paths: [`${extension('prompt-history')}/history.ts`], forbidden: [/@earendil-works\/pi-tui\//u], required: [/from\s*['"]@earendil-works\/pi-tui['"]/u] },
  { reason: 'Fusion execution must not load terminal rendering', paths: [`${extension('fusion')}/index.ts`], graph: true, forbidden: [noTui], forbiddenFiles: /\/(?:tui|model-picker)\.ts$/u },
  { reason: 'Fusion rendering must not load model execution or storage', paths: [renderer('fusion.ts')], graph: true, forbidden: [/from\s*['"]node:(?:fs|child_process|net|https?)|streamSimple|readFile|writeFile/u], forbiddenFiles: /\/(?:index|models|orchestration|session-state)\.ts$/u },
  { reason: 'Prewalk execution must not load terminal rendering', paths: [`${extension('prewalk')}/index.ts`], graph: true, forbidden: [noTui], forbiddenFiles: /\/plan-review\.ts$/u },
  { reason: 'Prewalk rendering must not load execution or classification', paths: [renderer('prewalk/plan-review.ts')], graph: true, forbiddenFiles: /\/(?:index|state|classification)\.ts$/u },
  ...['codex', 'codebase-memory'].map(name => ({
    reason: `${name} execution must load runtime without terminal modules`, paths: [`${extension(name)}/index.ts`], graph: true,
    forbidden: [noTui], forbiddenFiles: name === 'codex' ? /\/tui\.ts$/u : /\/(?:tui|tools)\.ts$/u, requiredFiles: [/\/runtime\.ts$/u],
  })),
  { reason: 'Codebase-memory rendering must not construct clients or installers', paths: [renderer('codebase-memory.ts')], forbidden: [/import (?!type)[^;]*from ['"]\.\/(?:client|services|installer)/u] },
  { reason: 'Powerline contracts must not construct host I/O or footers', paths: [`${extension('powerline')}/extension.ts`, `${extension('powerline')}/runtime.ts`], forbidden: [/node:|process\.|fetch\(|setFooter\(|new PowerlineFooter/u] },
  { reason: 'Powerline execution loads only portable core services', paths: [`${extension('powerline')}/extension.ts`], graph: true, forbidden: [noTui], forbiddenFiles: /\/(?:tui|footer|footer-renderer|projected-footer|colors|service)\.ts$/u, requiredFiles: [/\/runtime\.ts$/u, /\/core-services\.ts$/u] },
  { reason: 'Projected powerline rendering must not fetch data or construct runtimes', paths: ['projected-footer.ts', 'footer-renderer.ts', 'colors.ts', 'symbols.ts'].map(name => renderer(`powerline/${name}`)), forbidden: [/from ['"].*\/(git|subscription|savings|index|footer)\.js['"]/u, /\b(exec|fetch|setInterval)\(/u] },
  { reason: 'Llama providers must not load mixed extension or client renderers', paths: ['sdk', 'management', 'presentation', 'extension'].map(name => `apps/felan/src/providers/llama/${name}.ts`), forbidden: [/(?:pi-tui|\/llama\/ui|\/llama\/index|apps\/felan|@felan-ai\/felan)/u] },
  { reason: 'Interactive clients must not own execution or session stores', paths: ['apps/felan/src/client-application.ts'], forbidden: [/InteractiveMode|createLocalFelanRuntime|SessionManager|createLocalSettingsManager/u] },
  { reason: 'CLI startup loads the client without importing a local runtime', paths: ['apps/felan/src/cli-main.ts'], forbidden: [/^import .*from ['"].*(?:internal\/settings|\.\/runtime)/mu], required: [/await import\('\.\/client-application\.js'\)/u] },
  { reason: 'Host and runtime provider entrypoints must not load clients', paths: ['apps/felan/src/daemon-host.ts', 'apps/felan/src/providers/runtime.ts'], forbidden: [/tui|acp|presenter/iu] },
  { reason: 'Daemon execution contracts must not own subagent presentation', paths: ['apps/daemon/src/daemon/session-execution.ts'], forbidden: [/Subagent|AgentView|Navigator/u] },
  { reason: 'Client agent presentation must use the daemon-backed host', paths: ['apps/felan/src/client/agents-presenter.ts'], forbidden: [/registerCustom/u], required: [/new ClientAgentHost\(client, parent, settings, toolPresentation\)/u] },
  { reason: 'Client agent hosts must use canonical execution services', paths: ['apps/felan/src/client/agent-host.ts'], forbidden: [/createLocalFelanRuntime/u], required: [/'executions.list'/u] },
  { reason: 'Ask-user must not install a global bridge', paths: [extension('ask-user')], forbidden: [/Symbol\.for|pi-ask-user:external-bridge/u] },
  { reason: 'Ask-user root must not load a terminal entrypoint', paths: [`${extension('ask-user')}/index.ts`], forbidden: [noTui, /\.\/tui\.js/u] },
  { reason: 'Background bash and tasks route host I/O through Runtime', paths: [extension('background-bash'), extension('tasks')], forbidden: [noHostIo, noCloud] },
  { reason: 'Tasks own session persistence without subagent coupling', paths: [extension('tasks')], forbidden: [/@felan-ai\/ext-subagents/u], required: [/storage\('session'\)/u] },
  { reason: 'Tasks execution must not load terminal overlays', paths: [`${extension('tasks')}/index.ts`], forbidden: [/from ['"][^'"]*(?:pi-tui|tasks-overlay|\/tui)/u, noTui] },
  { reason: 'Browser host operations use Runtime without ambient credentials', paths: [extension('browser')], forbidden: [noHostIo, /\bprocess\s*(?:\.\s*env|\[\s*['"]env['"]\s*\])/u, /(?:from\s*|import\s*\()['"](?:node:)?process['"]/u, /@felan-cloud/u], required: [/runtime\.exec/u, /runtime\.readFile/u, /storage\('session'\)/u] },
  { reason: 'Context-view remains portable and consumes Agent Core', paths: [extension('context-view')], forbidden: [/node:(?:child_process|fs|net|http)/u, /@earendil-works\/pi-coding-agent/u], required: [/@felan-ai\/agent-core/u] },
  { reason: 'Memory coordination remains host-neutral', paths: [extension('memory')], forbidden: [/felan-platform|supabase|daytona|InteractiveMode|pi-tui/u, /from ['"]node:(?:fs|child_process)/u] },
  { reason: 'Memory history must not depend on client renderers', paths: [`${extension('memory')}/local/history.ts`], forbidden: [/@felan-ai\/felan|apps\/felan|pi-tui/u] },
  { reason: 'Title and compaction use injected services without ambient host I/O', paths: [`${extension('session-title')}/index.ts`, `${extension('session-title')}/models.ts`, `${extension('session-compaction')}/index.ts`], forbidden: [/node:|supabase|daytona|fetch\(|process\.|@earendil-works/u] },
  { reason: 'Output-style file reads must use Runtime', paths: [extension('output-style')], forbidden: [/node:(?:fs|os|http|net)|@felan-cloud|@earendil-works/u, /fetch\(|process\./u], required: [/runtime\.readFile\(resolvedPath\)/u] },
  { reason: 'Prompt history remains runtime-neutral', paths: [extension('prompt-history')], forbidden: [/node:(?:fs|net|http)/u, /@earendil-works\/pi-coding-agent/u] },
  { reason: 'Subagents must not import private cloud or terminal clients', paths: [extension('subagents')], forbidden: [/felan-platform|supabase|daytona|pi-tui|InteractiveMode/u] },
  { reason: 'Felan API roots must not embed credentials or private cloud modules', paths: [`${extension('felan-api')}/index.ts`], forbidden: [/@felan-cloud|TEAM_API_KEY|secret-key/u] },
  { reason: 'Felan API execution obtains credentials only from its service', paths: [`${extension('felan-api')}/extension.ts`], forbidden: [/process\.|createFelanApiExtension\(|https?:\/\//u], required: [/pi\.services\.get\(FELAN_PLATFORM_SERVICE\)/u] },
  { reason: 'MCP native credentials and browser launching belong to host providers', paths: [`${extension('mcp')}/index.ts`], forbidden: [/@napi-rs\/keyring|from 'open'/u] },
  { reason: 'MCP callbacks must not bind listeners or discover ambient credentials', paths: [`${extension('mcp')}/oauth-host.ts`], forbidden: [/process\.env|node:http/u] },
  { reason: 'MCP credential storage must not use native keyrings', paths: [`${extension('mcp')}/oauth-store.ts`], forbidden: [/@napi-rs\/keyring/u] },
  { reason: 'Codebase-memory routes storage and commands through Runtime', paths: [extension('codebase-memory')], forbidden: [/node:child_process|\bspawn\s*\(/u, /process\.env|node:os|\btmpdir\s*\(/u], required: [/'bash'/u, /'exec_command'/u, /runtime\.storage\('agent'\)/u] },
  { reason: 'Codebase-memory installers must not modify host configuration', paths: [`${extension('codebase-memory')}/installer.ts`], forbidden: [/settings\.json|mcp\.json|AGENTS\.md/u], required: [/--skip-config/u, /8972ea69c6ad94b1ef1d4ffbf0a92d78d2db1798/u, /13049c7cc51bc508d68b8ecb8a9fd9574ecb7c6f2c9dd5a19bf7d4c187321145/u, /HOME: installerHome/u, /CBM_CACHE_DIR:/u] },
  { reason: 'RTK host I/O uses Runtime and supports both command families', paths: [extension('rtk-optimizer')], forbidden: [noHostIo, /@earendil-works\/pi-coding-agent/u], required: [/'exec_command'/u, /'write_stdin'/u, /record\.cmd = command/u, /CODEX_OUTPUT_MARKER/u] },
  { reason: 'Web access owns only bounded remote search and content delivery', paths: [extension('web-access')], forbidden: [noHostIo, /\.\/(?:github|source-check|storage|promise-try)\.js/u, /(?:unpdf|pdfjs|PDF_WORKER_SOURCE)/u, /fetch_image|image-resize|native image|image-capable/iu, /@felan-ai\/ext-markitdown|documents\.pdf\/v1|getExtensionService/u, /schedulePdfDeliveries|deliverScheduledPdfs|scheduledPdfCount|sendMessage/u, /\b(?:get_search_content|source_check|registerCapability|appendEntry)\b/u, /runtime\.storage|storage\(['"]session['"]\)|session_(?:start|shutdown)|before_agent_start/u], required: [/MARKITDOWN_PDF_EVENT = 'felan:markitdown:pdf-convert:v1'/u] },
  { reason: 'Session protocol must remain browser-safe and runtime-neutral', paths: ['packages/session-protocol/src'], allowedImports: /^(?:\.\/|typebox$|typebox\/value$)/u, forbidden: [/\bprocess\.(?:env|cwd|chdir|pid|platform|stdout|stdin|stderr)\b|\b(?:Buffer|require)\s*[.(]/u] },
];

function files(path: string): string[] {
  return statSync(path).isDirectory()
    ? readdirSync(path).flatMap(name => files(resolve(path, name)))
    : path.endsWith('.ts') ? [path] : [];
}

const imports = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/gu;

it('enforces package ownership and portable execution boundaries', () => {
  const sources = new Map<string, string>();
  const source = (path: string) => {
    if (!sources.has(path)) sources.set(path, readFileSync(path, 'utf8'));
    return sources.get(path)!;
  };
  for (const boundary of boundaries) {
    const selected = new Set<string>();
    const visit = (path: string) => {
      if (selected.has(path)) return;
      selected.add(path);
      if (boundary.graph) for (const match of source(path).matchAll(imports)) {
        if (match[2]!.startsWith('.')) visit(resolve(dirname(path), match[2]!.replace(/\.js$/u, '.ts')));
      }
    };
    for (const path of boundary.paths) for (const file of files(resolve(root, path))) visit(file);
    const paths = [...selected].filter(path => !boundary.exclude?.test(portablePath(relative(root, path))));
    expect(paths.length, boundary.reason).toBeGreaterThan(0);
    for (const path of paths) {
      const label = `${boundary.reason}: ${relative(root, path)}`;
      if (boundary.forbiddenFiles) expect(portablePath(path), label).not.toMatch(boundary.forbiddenFiles);
      for (const forbidden of boundary.forbidden ?? []) expect(source(path), label).not.toMatch(forbidden);
      if (boundary.allowedImports) for (const match of source(path).matchAll(imports)) expect(match[2], label).toMatch(boundary.allowedImports);
    }
    const combined = paths.map(source).join('\n');
    for (const required of boundary.required ?? []) expect(combined, boundary.reason).toMatch(required);
    for (const required of boundary.requiredFiles ?? []) expect(paths.some(path => required.test(portablePath(path))), boundary.reason).toBe(true);
  }
});
