# @felan-ai/ext-codebase-memory

Portable structural code exploration for Felan, backed by the reviewed
`codebase-memory-mcp` 0.10.8 native executable.

## Behavior

When the exact reviewed binary is available, the extension registers exactly
four model tools:

- `codebase_memory` proxies the bounded structural query surface and performs
  an explicit `index_repository` refresh for the active git repository.
- `read_symbol` resolves and reads one named symbol.
- `search_and_read_symbols` searches symbols and reads a bounded set of likely
  matches, returning compact match-count metadata and selected snippets rather
  than repeating candidate metadata.
- `search_code` searches indexed source text.

The extension starts one background index at session startup without delaying
session readiness. The first root or subagent index or query lazily starts one
stdio MCP frontend for the root session. The root and all descendants reuse and
multiplex that frontend, which closes after its last session consumer shuts
down. Shared daemon coordination and the runtime directory remain owned by
Codebase Memory. Runtimes without the optional stdio capability use the bounded
one-shot CLI fallback. It shows `cbm: idx`
only while indexing and `cbm: install` only while installing, then clears the
status. Cache-size accounting is deferred after indexing and never extends
that status. It has no file watcher or periodic refresh. After edits, the model can call
`codebase_memory({ command: "index_repository" })`, and local users can run
`/codebase-memory refresh`. Direct file reads, grep, compiler output, and tests
remain authoritative because an index can be stale.

When a known Codebase Memory coordination failure makes an index worker fail,
current Felan sessions coordinate a bounded recovery wave through agent
storage. They close only their own frontends, ask the reviewed binary to stop
its daemon gracefully, and retry the index once after successful recovery.
Older Felan processes cannot participate until restarted. Felan never deletes
Codebase Memory runtime locks or cache data and never signals foreign PIDs; if
another session does not cooperate, the attempt ends with an actionable
warning rather than retrying indefinitely.

Grep and ripgrep calls made through `bash` or Codex `exec_command` receive a
best-effort Codebase Memory appendix when the original result is empty or
likely truncated and a simple search pattern can be identified. Focused
non-empty results and commands with uncertain shell syntax are left unchanged.
Augmentation has its own 1.5-second deadline, never replaces the original
command result, and emits hit/error/skip telemetry only through a host-supplied
callback.

## Availability and installation

The package never bundles or installs a binary automatically. If the binary is
missing, it registers no tools, capability instructions, or model prompt. A
local interactive session shows one installation hint; a cloud host receives a
hard error log while session startup continues without Codebase Memory.

Local installation is always explicit through `/dependencies` or
`/codebase-memory install`. Felan downloads a commit-pinned upstream installer,
verifies its SHA-256 digest, requests the pinned 0.10.8 release, passes
`--skip-config`, and installs only into `AgentRuntime.storage('agent')`. It
never edits agent or repository configuration. Cloud hosts must place the exact
reviewed binary on `PATH` in the execution image.

## Cache and limits

Codebase Memory data is rooted at
`AgentRuntime.storage('agent')/codebase-memory/cache` on host runtimes and
`AgentRuntime.storage('session')/codebase-memory/cache` on Docker and Daytona.
The session-scoped cloud location is visible to the workspace process while
remaining isolated between root sessions. Root sessions and subagents using
the same root-session storage coordinate through one frontend and index.

Daemon coordination remains keyed by that agent-storage root. POSIX runtimes
use an owner-private `/tmp/felan-cbm-<key>` rendezvous so CBM's Unix socket path
stays below platform limits. The host runtime creates or validates this
directory with mode `0700`, rejects symlinks and unsafe ownership, and checks
the canonical sticky `/tmp` parent. Windows keeps the rendezvous under
`AgentRuntime.storage('agent')/codebase-memory/runtime`.

- Query timeout: 60 seconds
- Index timeout: 20 minutes
- Maximum CBM response/output: 5 MiB
- Maximum symbol read: 220 lines
- Cache LRU: 2 GiB for host runtimes; 500 MiB for Docker and Daytona

Set `extensionConfig.codebaseMemory.maxCacheBytes` to a positive integer to
override the runtime cache limit. The persisted default `0` means “use the
runtime-specific limit”; it is not a zero-byte cache.

Set `extensionConfig.codebaseMemory.autoIndexPath` to an absolute directory to
index that directory at session startup instead of resolving the Git root or
runtime cwd. Cloud hosts can use the workspace's nested repository aggregate
directory, such as `/work/repos`; the reviewed binary's filesystem-root and
shallow-root protections remain in force.

## Public API

The default export is the portable extension. Hosts may also use:

- `createCodebaseMemoryExtension({ telemetry, log })`
- `CODEBASE_MEMORY_CONFIG`
- `inspectCodebaseMemoryRuntime(runtime)`
- `installManagedCodebaseMemory(runtime, onStatus)`
- `MANAGED_CODEBASE_MEMORY_VERSION`

The binary client, project coordination, and symbol services are internal
implementation details. The package intentionally provides no LSP integration.

## Development

```sh
pnpm --filter @felan-ai/ext-codebase-memory build
pnpm --filter @felan-ai/ext-codebase-memory type-check
pnpm --filter @felan-ai/ext-codebase-memory test
```

See [NOTICE](NOTICE) for the immutable upstream baselines and licensing.
