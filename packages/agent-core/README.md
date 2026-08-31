# @felan-ai/agent-core

Portable Felan agent contracts and the Node.js host runtime.

`@felan-ai/agent-core` is the feature-neutral composition layer between a
Felan host and the pinned Pi packages. It is intended for applications and
portable extensions, not as a complete end-user CLI.

```ts
import { HostAgentRuntime } from '@felan-ai/agent-core';

const runtime = new HostAgentRuntime(process.cwd(), {
  sessionStorageRoot: '/var/lib/felan/sessions/current',
  agentStorageRoot: '/var/lib/felan/agent',
  agentDir: '/etc/felan',
  pathAccess: 'host',
});
const result = await runtime.exec('node', ['--version']);
```

`HostAgentRuntime` uses its immutable `cwd` to resolve relative paths. The
default `pathAccess: 'workspace'` contains ordinary file operations and process
working directories to that cwd. `pathAccess: 'host'` permits any path
available to the current user. Use `exec(command, args)` for literal argument
boundaries and `shell(command)` only when shell parsing is intentional. File
reads and writes use `Uint8Array` so binary content is preserved. Reads accept a
`maxBytes` bound, and writes support exclusive creation for race-safe new files.
`listFiles` supports recursive, glob-filtered traversal with ignored-directory,
depth, and result-count bounds; host implementations enumerate one directory at
a time rather than materializing an unbounded recursive scan. `exec` and `shell`
accept an optional `maxOutputBytes` cap; capped results set `truncated` without
turning normal command completion into cancellation.

Shell calls use the host's default shell unless they request the explicit
`shellFlavor: 'posix'` option. POSIX hosts use `/bin/sh`; native Windows hosts
validate and use a same-host Git Bash installation discovered through
`FELAN_POSIX_SHELL`, `PATH`, or standard Git-for-Windows locations. The
`HostAgentRuntimeOptions.posixShell` override is available to embedding hosts.
The default Windows `cmd.exe` behavior is unchanged, and WSL is not selected
automatically because its process and path namespace is separate from the host.

Every `AgentRuntime` exposes scoped storage through `storage(scope)`. The
default `storage()` handle is identical to `storage('session')` and belongs to
one root session plus all of its subagents. Session storage is readable through
ordinary runtime reads and shares a filesystem namespace with `shell`, allowing
tools to return absolute output paths that regular agents can inspect.

`storage('agent')` holds longer-retention extension state owned by the runtime
host. Host consumers provide exact `sessionStorageRoot` and `agentStorageRoot`
paths; each storage handle preserves binary content, rejects lexical and
symlink escapes, and cannot remove its root. Workspace path access excludes
agent storage, while host path access lets ordinary operations inspect both
storage scopes.

Host runtimes expose optional persistent process operations for extensions that
need incremental output and stdin. `startShell()` keeps process ownership in
the runtime adapter and returns a bounded polling handle with write, terminate,
interrupt, and dispose operations. The separate optional `terminals` capability
allocates a real operating-system PTY with terminal input; adapters without PTY
support omit that capability. The optional `readAgentFile()`
boundary reads only inside the configured `agentDir`; ordinary runtime file
operations follow the configured path access mode.

Host mode runs with the current user's filesystem and process permissions. It
does not provide OS isolation or a sandbox boundary. Run untrusted workloads in
an isolated runtime instead.

The package also composes Pi 0.84.4 sessions with inline-only Felan extensions
and runtime-backed coding tools. `createAgentCoreSession` returns a headless,
inactive session, while `createAgentCoreSessionRuntimeFactory` provides the
typed seam used with Pi's `createAgentSessionRuntime`. Applications retain
ownership of model credentials, settings, session storage, stream wrappers,
feature extensions, and presentation listeners. `FelanExtensionAPI` adds the
selected `AgentRuntime`, application agent directory, and session-aware model
selection options to Pi's extension API; feature-specific contracts remain in
their owning extension packages. Feature automation can pass
`{ updateDefault: false }` to `setModel` or `setThinkingLevel` to update the
active session without changing the user's default model or thinking
preference. Ordinary selections retain Pi's default-updating behavior.
Applications may also pass adapter-neutral `inlineExtensions` directly into
session composition for host-owned integration such as presentation controls;
these remain opt-in and are not discovered from ambient configuration.
Runtime-backed coding tools are installed during composition as hidden fallback
extension tools, so feature extensions can override standard tool names while
explicit application `customTools` retain final precedence.

Agent Core owns the exact Pi dependency versions used by its consumers. Its
public entry point exposes the Pi model, credential, streaming, session,
resource, skill, tool, and context-inspection symbols needed to compose Felan applications, so
consumers import those symbols from `@felan-ai/agent-core` without declaring
Pi packages directly.

Agent Core also exposes shared `high`, `medium`, and `low` model tiers for
extensions that need model-strength selection:

```ts
import { selectModelForTier } from '@felan-ai/agent-core';

const models = ctx.scopedModels.length > 0
  ? ctx.scopedModels.map(({ model }) => model)
  : ctx.modelRegistry.getAvailable();
const selection = selectModelForTier('low', models, {
  preferredModel: ctx.model,
});
```

Callers provide the models already allowed and authenticated by their host.
Selection prefers candidates from the current provider and model family, then
falls back across the supplied model scope. `getModelFamily` and
`getModelStrength` classify the host's live model list with version-independent
family and role names, so new Opus, Sonnet, Haiku, Sol, Terra, Luna, Pro, Flash,
Max, and similar releases do not require an exact-ID catalog update. Aggregate
providers including OpenCode, OpenCode Go, OpenRouter, and GitHub Copilot are
classified from each model's identity rather than treated as one family.
Unknown naming schemes default to `medium`, and hosts can pass a custom
`classifyModel` function to `selectModelForTier`. Model tiers do not imply a
thinking level. `FELAN_THINKING_LEVELS` separately defines `off`, `low`,
`medium`, `high`, `xhigh`, and `max`; `minimal` is outside the Felan-facing
scale. Agent Core also re-exports Pi's `clampThinkingLevel` so extensions can
resolve a requested effort against a host-provided model without duplicating
provider capability rules. Agent Core does not load model-tier configuration or
resolve credentials.

Agent Core owns the runtime-neutral Felan base system prompt. Every composed
session uses this prompt; consumers extend it with `appendSystemPrompt` and
cannot replace it. During composition, Agent Core also reads at most one
instruction file from the session cwd through `AgentRuntime`, with `AGENTS.md`
taking precedence over `CLAUDE.md`. Missing, unreadable, and blank instruction
files are nonfatal. The selected file is supplied through Pi's context-file
interface, which renders it as path-labeled project instructions rather than a
consumer prompt append. Inline extensions can contribute model-facing behavior
during initialization:

```ts
const extension: FelanExtension = (pi) => {
  pi.registerCapability({
    id: 'review',
    instructions: 'Review changed code and report concrete findings.',
  });
};
```

Capability IDs and instructions are validated, duplicate IDs report both
extension sources, and contributions retain extension load and registration
order across resource reloads. Agent Core renders enabled capabilities as one
section after the base prompt. Consumer appends follow that section, then Pi
adds cwd project instructions, explicit skills, and the current working
directory.

Tool definitions sent with the model request remain the authoritative tool
inventory. The Felan-owned prompt intentionally does not render Pi's default
`promptSnippet` or `promptGuidelines` sections; extensions use named
capabilities for multi-tool workflow guidance.

Applications may pass explicit `skills` or `skillPaths` into session
composition. Agent Core exposes only those resources while ambient project,
user, and package skill discovery remains disabled. Ambient system prompt,
append prompt, and context discovery are also disabled; the selected cwd
instruction file is the only built-in project-context input.

## Package boundary

Agent Core owns `AgentRuntime`, `HostAgentRuntime`, the Felan base prompt, cwd
project instructions, provider-aware model tiers, runtime-backed coding tools,
capabilities, session/resource composition, and the public Pi composition
exports. Hosts own credentials, settings, storage roots, model scope,
presentation, and feature extension selection. Feature-specific behavior such
as tasks, memory scheduling, progressive context, and Prewalk belongs in its
own extension or application.

Host mode is deliberately not a sandbox. Use a runtime with an external
isolation boundary for untrusted workloads. Runtime callers should use literal
argv with `exec`, bounded byte-based I/O, and the scoped storage APIs rather
than reaching around the adapter.

## Development

Source: `packages/agent-core` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/agent-core build
pnpm --filter @felan-ai/agent-core type-check
pnpm --filter @felan-ai/agent-core test
```

## Attribution

Agent Core composes the pinned MIT-licensed Pi packages listed in the package
manifest. See [NOTICE](NOTICE) and [LICENSE](LICENSE) for the complete
third-party attribution boundary.

## Related documentation

- [Felan architecture](../../docs/concepts/architecture.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)
- [Maintainer architecture map](../../docs/maintainers/architecture-map.md)
