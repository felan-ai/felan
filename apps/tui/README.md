# Felan Code

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

Felan Code supports Node.js 22.19.0 or newer. Repository development and CI use
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
update             Update a global npm installation of Felan Code
savings            Show persisted estimated API-equivalent savings
acp                 Serve Agent Client Protocol v1 over stdio
acp login           Configure model-provider credentials in a finite terminal flow
-h, --help         Show help
-v, --version      Print the Felan Code version
--verbose          Show verbose startup details
```

After rebuilding Felan Code from this repository, use `/restart` in the interactive
TUI to reload Felan Code, Agent Core, and extension modules while preserving the
current session. It replaces the Node process and resumes the same session;
unlike Pi's `/reload`, it is not an in-process resource reload.

Run `felan update` to check the stable npm release. It updates only a verified
global npm installation, reports when the installation is current, and tells
you to restart after a successful update. `npx`, local/source, and other
package-manager installations are not changed; update those with the command
that installed them.

Interactive startup also checks npm once, asynchronously, for a newer stable
release. If one is available, Felan Code tells you to exit all Felan Code sessions and
run `felan update` for a global npm installation, or use the package manager
that launched Felan Code. Offline, failed, and malformed responses stay silent, and
Felan Code never installs an update automatically. Set
`FELAN_SKIP_VERSION_CHECK=1` to disable this startup request.

Invocations without `--mode` start the interactive TUI. `--mode text` runs one
headless session and prints the final response; `--mode json` emits Pi-compatible
JSONL session events. JSONL stdout is machine-readable, while diagnostics and
failures go to stderr with a non-zero exit status. Both modes require a prompt,
support `--continue` and `--session`, and accept `--provider`, `--model`, and
`--thinking` for reproducible model selection. `--resume` remains interactive-only.
Headless startup never runs dependency onboarding or the interactive update check.

## Native ACP v1

Run Felan Code as a local Agent Client Protocol server:

```sh
felan acp
```

Or run the published package without a global install:

```sh
npx --yes @felan-ai/felan acp
```

`felan acp` serves stable ACP v1 over newline-delimited JSON on stdio. Stdout
is reserved for protocol frames; diagnostics go to stderr. ACP clients receive
the machine name `felan` and display title `Felan Code`. Each ACP session gets
an isolated local runtime and can create, load, prompt, cancel, and close Felan Code
sessions. Felan Code accepts baseline text and resource-link prompt blocks, replays
the current persisted branch on load, and streams user, assistant, thought,
and bounded tool-call updates.

When the client advertises terminal authentication, Felan Code offers a terminal
method that appends `login` to the configured `felan acp` invocation. Run the
same flow manually with:

```sh
felan acp login
```

When the client launches Felan Code through `npx`, the equivalent command is:

```sh
npx --yes @felan-ai/felan acp login
```

The finite login process supports configurable API-key and OAuth provider
methods, hides secret and manual-code input, and saves credentials only through
the local `ModelRuntime` credential store at `$FELAN_AGENT_DIR/auth.json`
(`~/.felan/auth.json` by default). Do not commit or share that file. An ACP
client should reconnect after successful terminal authentication. Form-capable
clients also receive `ask_user` and Prewalk review as ACP elicitations.

### Zed custom agent

Install `felan` on Zed's `PATH`, then add this custom agent in Zed's
`settings.json`:

```json
{
  "agent_servers": {
    "Felan Code": {
      "type": "custom",
      "command": "felan",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

For an on-demand package launch, use `"command": "npx"` and
`"args": ["--yes", "@felan-ai/felan", "acp"]`. The advertised terminal
auth arguments are appended, producing the separate
`npx --yes @felan-ai/felan acp login` flow.

Zed and Felan Code do not share provider credentials automatically. If Felan Code needs
authentication, select its terminal login method or run `felan acp login`, then
start a new external-agent connection.

ACP action safety is host-owned. Known mutation, process, network, and unknown
tools request `allow once` or `reject once`; known read-only/internal tools can
proceed. This is not a durable permission policy or sandbox. MCP definitions
supplied in ACP `session/new` or `session/load` are accepted for client
compatibility and ignored. Configure Felan Code's separate OAuth-only remote HTTP
MCP gateway through `mcp.json` instead.

Current non-goals include remote ACP transports, additional workspace roots,
image/audio/embedded-resource prompt blocks, session modes and config options,
and all session-provided MCP servers. ACP does not launch client-provided MCP
processes or expose client-provided MCP tools, resources, prompts, sampling,
Apps, or scripting.

`felan --resume` opens a selection-only session picker. Press Tab to switch
between the current folder and all local sessions, Ctrl+S to change sorting,
Ctrl+N to filter to named sessions, and Ctrl+P to toggle session paths. Escape
cancels without creating a session. `felan --continue` remains the quick path
for the most recent session in the current directory.

New interactive root sessions receive an asynchronous, concise name derived
from the first prompt. Names are persisted in the session file and existing
names are never replaced. Disable this with `builtinExtensions.sessionTitle`.

`felan --diagnostics` reports Felan Code, Agent Core, Pi, and Node.js versions plus
runtime and credential modes.

## Local state and policy

The default agent directory is `~/.felan`; set `FELAN_AGENT_DIR` to change it.
It contains local credentials, settings, sessions, agents, extension storage,
and project memory. Root-session storage is scoped under
`$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>` and longer-lived
extension state under `$FELAN_AGENT_DIR/storage/agent`.

The local host loads only source-controlled Felan Code built-ins, Felan-owned
settings and prompt appends, explicit Felan Code agents and Agent Skills, and the
Agent Core-selected cwd instruction file. Ambient Pi extensions, packages,
prompts, themes, project settings, and package resources are filtered.

When launched inside Herdr, the TUI reports its Felan Code lifecycle and session
identity through Herdr's inherited local socket environment. This is TUI-only
and does not enable ambient extensions or ACP. User-attention waits from Pi
extensions, including `ask_user`, Prewalk approval/review, and local MCP OAuth,
are reported as blocked; delegated subagent completions remain part of the
root workflow.

All built-ins are enabled by default, including the Powerline footer in TUI
sessions. Binary-backed features can remain inactive until their dependency is
installed or the feature is disabled through `/dependencies`.

Codebase Memory is a default built-in. It provides structural code
search, symbol reads, and bounded grep augmentation, backed by the
`codebase-memory-mcp` binary.

The binary is a separate download and is not installed automatically.
Run `/codebase-memory install` to fetch the reviewed managed binary.
Once it is available, Felan Code indexes the active repository at session
start and re-uses the index across sessions.

Run `/codebase-memory refresh` to rebuild the index after significant
edits.

The local TUI provides `felan-light` and `felan-dark` as host-owned Pi themes.
The startup view uses a compact Felan Code welcome; press `Ctrl+O` when you need
the full startup help and loaded-resource listing. When no theme is saved,
Felan Code follows the terminal appearance automatically. The `felan-*` names are
intentional: Pi 0.85.1 reserves `dark` and `light` for its built-in export
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
