# @felan-ai/agent-core

Portable Felan agent contracts and the Node.js host runtime.

```ts
import { HostAgentRuntime } from '@felan-ai/agent-core';

const runtime = new HostAgentRuntime(process.cwd(), {
  sessionStorageRoot: '/var/lib/felan/sessions/current',
  agentStorageRoot: '/var/lib/felan/agent',
  agentDir: '/etc/felan',
});
const result = await runtime.exec('node', ['--version']);
```

`HostAgentRuntime` roots file and process operations at its immutable `cwd`.
Use `exec(command, args)` for literal argument boundaries and `shell(command)`
only when shell parsing is intentional. File reads and writes use
`Uint8Array` so binary content is preserved.

Every `AgentRuntime` exposes scoped storage through `storage(scope)`. The
default `storage()` handle is identical to `storage('session')` and belongs to
one root session plus all of its subagents. Session storage is readable through
ordinary runtime reads and shares a filesystem namespace with `shell`, allowing
tools to return absolute output paths that regular agents can inspect.

`storage('agent')` holds longer-retention extension state owned by the runtime
host. It is intentionally excluded from ordinary runtime reads and listings.
Host consumers provide exact `sessionStorageRoot` and `agentStorageRoot` paths;
each storage handle preserves binary content, rejects lexical and symlink
escapes, and cannot remove its root. Ordinary writes, mutations, and execution
working directories remain confined to `cwd`.

Host runtimes expose optional persistent process operations for extensions that
need incremental output and stdin. `startShell()` keeps process ownership in
the runtime adapter and returns a bounded polling handle with write, terminate,
and dispose operations. The optional `readAgentFile()` boundary reads only
inside the configured `agentDir`; ordinary runtime file operations retain their
workspace and session-storage boundaries.

Host mode runs with the current user's filesystem and process permissions. It
provides workspace path containment, but no OS isolation or sandbox boundary.
Run untrusted workloads in an isolated runtime instead.

The package also composes Pi 0.83.0 sessions with inline-only Felan extensions
and runtime-backed coding tools. `createAgentCoreSession` returns a headless,
inactive session, while `createAgentCoreSessionRuntimeFactory` provides the
typed seam used with Pi's `createAgentSessionRuntime`. Applications retain
ownership of model credentials, settings, session storage, stream wrappers,
feature extensions, and presentation listeners. `FelanExtensionAPI` adds only
the selected `AgentRuntime` and application agent directory to Pi's extension
API; feature-specific contracts remain in their owning extension packages.
Runtime-backed coding tools are installed during composition as hidden fallback
extension tools, so feature extensions can override standard tool names while
explicit application `customTools` retain final precedence.

Agent Core owns the exact Pi dependency versions used by its consumers. Its
public entry point exposes the Pi model, credential, streaming, session,
resource, skill, and tool symbols needed to compose Felan applications, so
consumers import those symbols from `@felan-ai/agent-core` without declaring
Pi packages directly.

Agent Core owns the runtime-neutral Felan base system prompt. Every composed
session uses this prompt; consumers extend it with `appendSystemPrompt` and
cannot replace it. Inline extensions can contribute model-facing behavior
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
adds explicit skills and the current working directory.

Tool definitions sent with the model request remain the authoritative tool
inventory. The Felan-owned prompt intentionally does not render Pi's default
`promptSnippet` or `promptGuidelines` sections; extensions use named
capabilities for multi-tool workflow guidance.

Applications may pass explicit `skills` or `skillPaths` into session
composition. Agent Core exposes only those resources while ambient project,
user, and package skill discovery remains disabled. Ambient system prompt,
append prompt, and context discovery are also disabled.

## Development

Source: `packages/agent-core` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/agent-core build
pnpm --filter @felan-ai/agent-core test
```
