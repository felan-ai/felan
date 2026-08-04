# @felan-ai/agent-core

Portable Felan agent contracts and the Node.js host runtime.

```ts
import { HostAgentRuntime } from '@felan-ai/agent-core';

const runtime = new HostAgentRuntime(process.cwd());
const result = await runtime.exec('node', ['--version']);
```

`HostAgentRuntime` roots file and process operations at its immutable `cwd`.
Use `exec(command, args)` for literal argument boundaries and `shell(command)`
only when shell parsing is intentional. File reads and writes use
`Uint8Array` so binary content is preserved.

Host mode runs with the current user's filesystem and process permissions. It
provides workspace path containment, but no OS isolation or sandbox boundary.
Run untrusted workloads in an isolated runtime instead.

The package also composes Pi 0.83.0 sessions with inline-only Felan extensions
and runtime-backed coding tools. `createAgentCoreSession` returns a headless,
inactive session, while `createAgentCoreSessionRuntimeFactory` provides the
typed seam used with Pi's `createAgentSessionRuntime`. Applications retain
ownership of model credentials, settings, session storage, stream wrappers,
feature extensions, and presentation listeners. `FelanExtensionAPI` adds only
the selected `AgentRuntime` to Pi's extension API; feature-specific contracts
remain in their owning extension packages.

Applications may pass an explicit `skills` list into session composition.
Agent Core exposes only that list while project, user, and package skill
discovery remain disabled.

## Development

Source: `packages/agent-core` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/agent-core build
pnpm --filter @felan-ai/agent-core test
```
