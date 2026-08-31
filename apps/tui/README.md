# @felan-ai/felan

Local, account-free, model-portable coding agent built for cost-efficient,
verifiable software work on `@felan-ai/agent-core` and Pi's interactive TUI
and print modes.

```sh
npx @felan-ai/felan
```

The package exposes the `felan` binary. It owns local credentials, settings,
session and agent storage paths, built-in extension selection, dependency
onboarding, lifecycle, and TUI presentation. Portable feature behavior remains
in the `@felan-ai/ext-*` packages.

> [!IMPORTANT]
> The local host uses the current user's filesystem and process permissions. It
> is not a sandbox.

## Requirements and quick start

Felan supports Node.js 22.19.0 or newer. Repository development and CI use
Node.js 22.20.0 with pnpm 9.15.5.

```sh
felan
/login
```

Run an initial prompt or continue the most recent session for the current
directory:

```sh
felan "inspect this project"
felan --continue
felan --mode text "summarize the current work"
felan --mode json --provider openai --model gpt-5.5 --thinking high "run the tests"
```

## CLI

```text
felan [options] [message]

--mode <text|json>  Run one headless session; JSON emits machine-readable JSONL
--provider <name>   Select a headless model provider
--model <name>      Select a headless model or provider/model reference
--thinking <level>  Select headless thinking: off|minimal|low|medium|high|xhigh|max
-c, --continue     Continue the most recent session for this directory
-r, --resume       Pick a session to resume
--session <id>     Resume a specific session
--session-dir <dir> Session directory for --session
--diagnostics      Print runtime versions and configuration mode
update             Update a global npm installation of Felan
savings            Show persisted estimated API-equivalent savings
-h, --help         Show help
-v, --version      Print the Felan version
--verbose          Show verbose startup details
```

Run `felan update` to check the stable npm release. It updates only a verified
global npm installation, reports when the installation is current, and tells
you to restart after a successful update. `npx`, local/source, and other
package-manager installations are not changed; update those with the command
that installed them.

Interactive startup also checks npm once, asynchronously, for a newer stable
release. If one is available, Felan tells you to exit all Felan sessions and
run `felan update` for a global npm installation, or use the package manager
that launched Felan. Offline, failed, and malformed responses stay silent, and
Felan never installs an update automatically. Set
`FELAN_SKIP_VERSION_CHECK=1` to disable this startup request.

Invocations without `--mode` start the interactive TUI. `--mode text` runs one
headless session and prints the final response; `--mode json` emits Pi-compatible
JSONL session events. JSONL stdout is machine-readable, while diagnostics and
failures go to stderr with a non-zero exit status. Both modes require a prompt,
support `--continue` and `--session`, and accept `--provider`, `--model`, and
`--thinking` for reproducible model selection. `--resume` remains interactive-only.
Headless startup never runs dependency onboarding or the interactive update check.

`felan --resume` opens a selection-only session picker. Press Tab to switch
between the current folder and all local sessions, Ctrl+S to change sorting,
Ctrl+N to filter to named sessions, and Ctrl+P to toggle session paths. Escape
cancels without creating a session. `felan --continue` remains the quick path
for the most recent session in the current directory.

`felan --diagnostics` reports Felan, Agent Core, Pi, and Node.js versions plus
runtime and credential modes.

## Local state and policy

The default agent directory is `~/.felan`; set `FELAN_AGENT_DIR` to change it.
It contains local credentials, settings, sessions, agents, extension storage,
and project memory. Root-session storage is scoped under
`$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>` and longer-lived
extension state under `$FELAN_AGENT_DIR/storage/agent`.

The local host loads only source-controlled Felan built-ins, Felan-owned
settings and prompt appends, explicit Felan agents and Agent Skills, and the
Agent Core-selected cwd instruction file. Ambient Pi extensions, packages,
prompts, themes, project settings, and package resources are filtered.

All built-ins are enabled by default, including the Powerline footer in TUI
sessions. Binary-backed features can remain inactive until their dependency is
installed or the feature is disabled through `/dependencies`.

Codebase Memory is a default built-in. It provides structural code
search, symbol reads, and bounded grep augmentation, backed by the
`codebase-memory-mcp` binary.

The binary is a separate download and is not installed automatically.
Run `/codebase-memory install` to fetch the reviewed managed binary.
Once it is available, Felan indexes the active repository at session
start and re-uses the index across sessions.

Run `/codebase-memory refresh` to rebuild the index after significant
edits.

The local TUI provides `felan-light` and `felan-dark` as host-owned Pi themes.
The startup view uses a compact Felan welcome; press `Ctrl+O` when you need
the full startup help and loaded-resource listing. When no theme is saved,
Felan follows the terminal appearance automatically. The `felan-*` names are
intentional: Pi 0.84.4 reserves `dark` and `light` for its built-in export
themes, so colliding IDs would make exported sessions use different colors.
Powerline consumes that same active theme instead of defining its own colors.
New installs use Pi's fullscreen TUI mode by default. A saved `tuiMode` setting
continues to take precedence; use `/settings` to switch between `fullscreen`
and `regular`. The prompt uses Pi's native editor rendering with one column of
horizontal padding by default; saved `editorPaddingX` values take precedence.

Model responses use the built-in `concise` output style by default. Set the
global `outputStyle` setting to `explanatory` for more reasoning and context.
The concise style prefers minimal prose, clear fragments, and compact bullets
while preserving exact technical content, conditions, caveats, verification,
and blockers; it expands when compression could create ambiguity or safety
risk. Use `extensionConfig.outputStyle.style: custom` with explicit
`instructions` to test alternative prompt wording;
the [configuration guide](../../docs/user-guide/configuration.md#output-style)
documents validation and session-lifecycle behavior.

## Canonical user documentation

The package README intentionally stays short. Use these guides for operational
details:

- [Getting started](../../docs/getting-started.md)
- [Local CLI and storage](../../docs/user-guide/local-cli.md)
- [Configuration](../../docs/user-guide/configuration.md)
- [Commands and shortcuts](../../docs/user-guide/commands-and-shortcuts.md)
- [Agents, tasks, and Prewalk](../../docs/user-guide/agents-tasks-and-prewalk.md)
- [Context and memory](../../docs/user-guide/context-and-memory.md)
- [Web, MCP, browser, and documents](../../docs/user-guide/web-mcp-and-browser.md)
- [Efficient execution and savings](../../docs/concepts/efficient-execution.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)

## Development

Source: `apps/tui` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/felan build
pnpm --filter @felan-ai/felan type-check
pnpm --filter @felan-ai/felan test
```

The development-only root preview (`pnpm theme:preview`) shows the two
host-owned themes across representative Pi, editor, and Powerline states. It
is intentionally a browser approximation rather than a second renderer.

Run `pnpm verify` from the repository root for cross-package and packed-binary
coverage.
