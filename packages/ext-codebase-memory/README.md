# @felan-ai/ext-codebase-memory

Portable Codebase Memory integration for Felan. It begins indexing the current
Git repository in the background at session startup and exposes four compact
tools without blocking normal startup:

- `codebase_memory` calls upstream graph, architecture, trace, status, and
  refresh commands. Use `{ "command": "index_repository" }` after significant
  edits or when results look stale.
- `read_symbol` resolves and reads one unambiguous symbol.
- `search_and_read_symbols` discovers likely symbols and reads their source.
- `search_code` searches exact text or regular expressions in indexed source.

Search results from `grep`, `find`, `bash`, and Codex `exec_command` receive a
small amount of related symbol context by default. This is bounded to 1.5s and
never replaces the original result.

## Binary discovery and installation

The extension checks, in order:

1. the managed binary in Felan agent storage;
2. `codebase-memory-mcp` on `PATH`;
3. `~/.local/bin/codebase-memory-mcp`.

If none exists, local sessions show one non-blocking hint and cloud sessions log
an error without failing startup. No tools or prompt content are added while the
runtime is unavailable.

Run `/codebase-memory install` to explicitly download the reviewed upstream
installer, verify its SHA-256 digest, and install Codebase Memory 0.10.8 into
Felan agent storage. The release URL is pinned so installation cannot drift to
the latest release. Installation is never automatic. Run
`/codebase-memory refresh` for a user-initiated reindex.

## Configuration

Configure the `codebaseMemory` extension through Felan extension settings:

```json
{
  "codebaseMemory": {
    "disabled": false,
    "maxCacheBytes": 0,
    "queryTimeoutMs": 60000,
    "indexTimeoutMs": 1200000,
    "augmentation": true,
    "augmentTimeoutMs": 1500,
    "maxSymbolLines": 220
  }
}
```

`maxCacheBytes: 0` selects 2 GB on local host runtimes and 500 MB in Docker or
Daytona. Older projects are evicted through Codebase Memory when the cap is
exceeded. Set `disabled: true` for the complete kill switch: it performs no
probe, tool registration, hooks, prompt injection, or startup indexing.

Queries time out after 60 seconds, indexing after 20 minutes, output capture at
5 MB, and symbol source at 220 lines by default. The cache and temporary
installer files remain under scoped Felan agent storage.

## Troubleshooting

- `cbm: off`: verify the binary with `/codebase-memory install`, or install
  `codebase-memory-mcp` on `PATH`, then reload the session.
- Stale results: use `/codebase-memory refresh` or
  `codebase_memory({command: "index_repository"})`.
- Ambiguous `read_symbol`: add `qualified_name` or `file_path`, or use
  `search_and_read_symbols` first.
- Startup failures disable Codebase Memory for that session rather than
  interrupting Felan. Inspect host/cloud logs for the bounded diagnostic.

## Testing with the real binary

The integration suite runs when `codebase-memory-mcp` is available at the
default development path or when `CODEBASE_MEMORY_MCP_TEST_BINARY` points to a
reviewed executable. Without a binary, the real-provider cases skip while the
portable unit suite still runs.
