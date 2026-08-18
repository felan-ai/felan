# @felan-ai/ext-rtk-optimizer

RTK command rewriting and tool-output compaction for Felan.

The extension delegates rewrite decisions to the `rtk rewrite` command, so the
`rtk` executable installed in the active runtime remains the source of truth
for supported commands and rewrite policy. When `rtk` is unavailable, the
default guard leaves commands unchanged while output compaction continues to
work.

## Tool support

- Ordinary tools: rewrites `bash.command` and compacts `bash`, `read`, and
  `grep` results.
- Codex tools: rewrites `exec_command.cmd`, compacts only the `Output:` payload
  inside the structured Codex result envelope, and associates running session
  IDs with later `write_stdin` output.
- Streaming command output has ANSI control sequences removed before display
  when ANSI stripping is enabled.

Build, test, Git, and linter commands receive command-aware compaction. Search
results can be grouped by file. A final character limit protects the context
from unusually large command results. Lossy source filtering and smart
truncation for `read` are disabled by default; explicit read ranges and reads
of at most 80 lines stay exact even when read compaction is enabled.

## Requirements

Install [RTK](https://github.com/rtk-ai/rtk) in the execution runtime and make
the `rtk` executable available on its `PATH`, or run `/rtk install`. The
explicit install command downloads a commit-pinned copy of RTK's official
installer, verifies its reviewed SHA-256 digest, and asks that installer for
the pinned RTK 0.45.0 release. The upstream installer verifies the release
archive checksum before placing the executable in Felan agent storage. It
requires `curl` plus standard Linux/macOS shell utilities; Windows users must
place `rtk.exe` on `PATH` manually.

Managed RTK is preferred over `PATH`. Rewritten shell commands receive its bin
directory through a command-scoped `PATH`, so no shell-profile change is
required and compound rewrites can resolve every `rtk` invocation. Use
`/rtk verify` to check the same `AgentRuntime` used by coding tools. Installation
never runs during extension startup or from a model-initiated tool call.

## Configuration

The extension stores portable agent-scoped configuration at:

```text
$FELAN_AGENT_DIR/storage/agent/rtk-optimizer/config.json
```

The file is created with safe defaults on first load. Root sessions and nested
subagents share it. Invalid JSON, unknown fields, invalid types, and values
outside the documented ranges fall back to defaults for that load and notify
the extension host when it exposes a notification channel; the invalid file is
not overwritten.

```json
{
  "enabled": true,
  "mode": "rewrite",
  "guardWhenRtkMissing": true,
  "showRewriteNotifications": true,
  "outputCompaction": {
    "enabled": true,
    "stripAnsi": true,
    "readCompaction": {
      "enabled": false
    },
    "truncate": {
      "enabled": true,
      "maxChars": 12000
    },
    "sourceCodeFilteringEnabled": false,
    "preserveExactSkillReads": false,
    "sourceCodeFiltering": "none",
    "smartTruncate": {
      "enabled": false,
      "maxLines": 220
    },
    "aggregateTestOutput": true,
    "filterBuildOutput": true,
    "compactGitOutput": true,
    "aggregateLinterOutput": true,
    "groupSearchOutput": true,
    "trackSavings": true
  }
}
```

`mode` is `rewrite` or `suggest`. `sourceCodeFiltering` is `none`, `minimal`,
or `aggressive`. `truncate.maxChars` accepts 1,000–200,000 and
`smartTruncate.maxLines` accepts 40–4,000.

## Command

Run `/rtk` to edit settings interactively. Subcommands are:

- `/rtk show`
- `/rtk path`
- `/rtk verify`
- `/rtk install`
- `/rtk stats`
- `/rtk clear-stats`
- `/rtk reset`
- `/rtk help`

Metrics are scoped to the current Felan extension session and reset at session
start.

## Development

Source: `packages/ext-rtk-optimizer` in
<https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-rtk-optimizer build
pnpm --filter @felan-ai/ext-rtk-optimizer type-check
pnpm --filter @felan-ai/ext-rtk-optimizer test
```

## Attribution

This package adapts the MIT-licensed `pi-rtk-optimizer` 0.9.0 implementation.
See [NOTICE](NOTICE) for source provenance.
