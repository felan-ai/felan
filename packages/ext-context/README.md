# @felan-ai/ext-context

Runtime-portable progressive loading of nested `AGENTS.md` and `CLAUDE.md`
instructions for Felan sessions.

Agent Core loads instructions at the session cwd during composition. This
extension discovers instructions below that cwd after the agent successfully
reads a file or the user submits a decoded CLI `@file` block. It walks from the
cwd toward the observed file, skips the cwd itself, and loads at most one
instruction file per nested directory with this precedence:

1. `AGENTS.md`
2. `CLAUDE.md`

Loaded files are normalized and deduplicated for the session. They are appended
to each subsequent model context as one hidden `pi-progressive-context` message,
so the instructions remain available after context compaction. A new session
clears all discovered and processed paths.

All file access goes through the cwd-contained `AgentRuntime`. Missing or
unreadable files are nonfatal, and directories already checked during the
session are not retried. Runtime containment rejects lexical traversal and
symlink escapes.

Use `/progressive-context` to show the nested instruction files loaded in the
current session.

The extension registers concise static `progressive-context` capability
guidance during initialization. Discovered nested instructions remain transient
session context and continue to update as relevant files are observed.

## Development

Source: `packages/ext-context` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-context build
pnpm --filter @felan-ai/ext-context test
```

## Trigger limitations

- Progressive context affects the model call after a file read or attachment.
- Images do not expose original filesystem paths through Pi input events.
- CLI `@file` blocks and successful structured `read` results are supported;
  shell commands that read files do not emit structured file-read events.

## Attribution

This package adapts the MIT-licensed `pi-progressive-context` implementation.
See [NOTICE](NOTICE) for source details.
