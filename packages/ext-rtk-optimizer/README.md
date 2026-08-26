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
results can be grouped by file. A final head-and-tail character limit protects
the context from unusually large command results and stores a recoverable copy
in session storage. Failed results retain their original evidence, and complete
JSON is never cut. Lossy source filtering and smart truncation for `read` are
disabled by default; explicit read ranges and reads of at most 80 lines stay
exact even when read compaction is enabled.

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

The extension receives portable configuration from:

`extensionConfig.rtkOptimizer` in `$FELAN_AGENT_DIR/settings.json`.

Root sessions and nested subagents receive the resolved snapshot. Invalid
fields, invalid types, and values outside the documented ranges stop activation
with a settings error; changes take effect in a new session. The invalid value is
not overwritten.

```json
{
  "enabled": true,
  "mode": "rewrite",
  "guardWhenRtkMissing": true,
  "showRewriteNotifications": true,
  "compactionEnabled": true,
  "stripAnsi": true,
  "readCompaction": false,
  "truncate": true,
  "truncateMaxChars": 12000,
  "sourceCodeFilteringEnabled": false,
  "preserveExactSkillReads": false,
  "sourceFiltering": "none",
  "smartTruncate": false,
  "smartTruncateMaxLines": 220,
  "aggregateTestOutput": true,
  "filterBuildOutput": true,
  "compactGitOutput": true,
  "aggregateLinterOutput": true,
  "groupSearchOutput": true,
  "trackSavings": true
}
```

`mode` is `rewrite` or `suggest`. `sourceCodeFiltering` is `none`, `minimal`,
or `aggressive`. `truncate.maxChars` accepts 1,000–200,000 and
`smartTruncate.maxLines` accepts 40–4,000.

## Command

Run `/settings` to edit RTK settings interactively. `/rtk` provides operational
commands. Subcommands are:

- `/rtk show`
- `/rtk verify`
- `/rtk install`
- `/rtk help`

RTK and post-tool savings are reported to Felan's persistent savings service when the
host provides it. They report two distinct sequential stages: RTK command-output
optimization from an isolated session/model tracker, and Felan post-tool
compaction for every supported result. Both use bounded token estimates and are
reported as separate Felan-owned savings measurements; they are not added twice.
The session tracker is queried once per model shard during session shutdown and
then deleted. A crashed session can recover its unfinished tracker on resume;
rare duplicate or skipped indicative measurements are acceptable. The global RTK
history is never imported. RTK command-output captures use the
`rtk-tracking-byte4-v1` estimator and are available on POSIX runtimes; on
Windows, rewriting remains available but the isolated RTK gain capture is
skipped because the POSIX environment wrapper is not used.

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
See [NOTICE](NOTICE) and [LICENSE](LICENSE) for source provenance.

## Package boundary and requirements

The extension owns rewrite decisions at the tool boundary, command/result
association, output compaction, configuration validation, and savings metrics.
The host supplies `AgentRuntime`, the agent-scoped storage root, interactive
settings presentation, and explicit installation policy. Output compaction can
operate without the executable; command rewriting requires a compatible `rtk`
on the active runtime.

It requires a compatible `@felan-ai/agent-core` peer. Managed installation is
explicit, digest-verified, and never runs during startup or a model tool call.
Lossy read compaction remains opt-in and explicit ranges remain exact.

## Related documentation

- [Configuration](../../docs/user-guide/configuration.md#rtk)
- [Commands and shortcuts](../../docs/user-guide/commands-and-shortcuts.md)
- [Runtime dependencies](../../docs/reference/runtime-dependencies.md)
