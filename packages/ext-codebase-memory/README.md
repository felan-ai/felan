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
  matches.
- `search_code` searches indexed source text.

The extension indexes once at session startup. It has no file watcher or
periodic refresh. After edits, the model can call
`codebase_memory({ command: "index_repository" })`, and local users can run
`/codebase-memory refresh`. Direct file reads, grep, compiler output, and tests
remain authoritative because an index can be stale.

Grep and ripgrep calls made through `bash` or Codex `exec_command` receive a
best-effort Codebase Memory appendix by default. Augmentation has its own
1.5-second deadline, never replaces the original command result, and emits
hit/error telemetry only through a host-supplied callback.

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
`AgentRuntime.storage('agent')/codebase-memory/cache`, so root sessions and
subagents using the same runtime coordinate through one index. No tenant key is
added inside that already scoped runtime storage.

- Query timeout: 60 seconds
- Index timeout: 20 minutes
- Combined process output: 5 MiB
- Maximum symbol read: 220 lines
- Cache LRU: 2 GiB for host runtimes; 500 MiB for Docker and Daytona

Set `extensionConfig.codebaseMemory.maxCacheBytes` to a positive integer to
override the runtime cache limit. The persisted default `0` means “use the
runtime-specific limit”; it is not a zero-byte cache.

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
