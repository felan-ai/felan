# Felan Code

Local, account-free, model-portable coding agent built for cost-efficient,
verifiable software work on `@felan-ai/agent-core`, a Felan-owned TUI built
with public Pi TUI primitives, and Pi's session runtime.

```sh
npx @felan-ai/felan
```

The package exposes the `felan` binary and owns CLI/TUI, ACP, headless clients,
local service providers and the default `host.json`. It installs an exact
`@felan-ai/daemon` dependency. The daemon owns admission, canonical storage and
execution lifetime; local providers supply settings, credentials and runtimes.
Portable feature behavior remains in the `@felan-ai/ext-*` packages.

All session execution goes through the exact installed daemon package;
`resolveInstalledDaemonEntrypoint()` does not assume the launch cwd. The former
profile exports are removed. Providers use `@felan-ai/daemon/provider` and
`@felan-ai/daemon/session-runtime`. The coordinated breaking releases are
Felan 0.30.0, daemon 0.1.0 and Agent Core 0.13.0.

### Configured services

Pass `--host-config /absolute/path/host.json` to select explicit trusted
configuration. Otherwise the launcher uses `host.json` in the agent directory,
then its packaged default. Providers resolve from the installed managing
package, never from the project or configuration directory. Provider changes
require a daemon restart. Restored sessions resume with the current
configuration, as in 0.28.3.

Programmatic consumers use the client API: `runCli`, `runDaemonFelan`,
`runLocalFelanHeadless`, `SessionClient`, `newRequestId`, daemon target and
client-configuration path helpers, version, and entrypoint resolution. Runtime,
store, model, settings, classifier, and subagent-host constructors are no longer
exported. `CliDependencies.openSession` and headless host-runtime options were
removed; run work through the daemon service instead. There is no in-process
fallback.

> [!IMPORTANT]
> The local host uses the current user's filesystem and process permissions. It
> is not a sandbox.

Felan Code uses Pi 1.4.0 for its agent, provider, and TUI runtime. Pi's model
catalog and terminal color detection are available through that runtime.
Pi-native MCP, codemode, and tool search are not automatically loaded in Felan:
MCP remains the explicit OAuth-only HTTP gateway described in
[Remote MCP](../../docs/user-guide/web-mcp-and-browser.md#remote-mcp).
Pi's native stdio servers, bearer tokens, custom headers, and direct MCP tools
are not supported by Felan's built-in gateway.

## Requirements and quick start

### Azure provider migration

Pi 1.0.3 renamed the Azure provider from `azure-openai-responses` to `azure`.
Update the provider key in `auth.json` and `models.json`, and change any
`defaultProvider`, `enabledModels` patterns, and `modelThinkingLevels` keys in
`settings.json` to `azure`. Pi does not reuse the old provider ID when resuming
sessions, so an older Azure session may fall back to another model and will not
reuse its prompt cache. Azure environment variables such as `AZURE_OPENAI_API_KEY`
are unchanged; the model API identifier `azure-openai-responses` is also still
used by Azure model definitions.

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
felan --mode json --provider openai --model gpt-5.6-sol --thinking high "run the tests"
```

## CLI

```text
felan [options] [message]

--mode <text|json>  Run one headless session; JSON emits machine-readable JSONL
--provider <name>   Select a headless model provider
--model <name>      Select a headless model or provider/model reference
--thinking <level>  Select headless thinking: off|minimal|low|medium|high|xhigh|max
-e, --extension <path>  Load an external extension (repeatable; interactive TUI only)
-c, --continue     Continue the most recent session for this directory
-r, --resume       Pick a session to resume
--session <id>     Resume a specific session
--session-dir <dir> Session directory for --session
--diagnostics      Print runtime versions and configuration mode
--host-config <path> Select an absolute trusted host.json path
update             Update a global npm installation of Felan Code
savings            Show persisted estimated API-equivalent savings
daemon <action>     Manage the persistent local daemon
acp                 Serve Agent Client Protocol v1 over stdio
acp login           Configure model-provider credentials in a finite terminal flow
-h, --help         Show help
-v, --version      Print the Felan Code version
--verbose          Show verbose startup details
```

Likely command typos such as `felan deamon stop` produce a suggestion and exit
with status 1; they never run the suggested command or start a model session.
Suggestions require one unambiguous single-character edit (including adjacent
transpositions). At the top level, only command-shaped input is checked: a daemon
action or command-specific options, or a single word with transposed letters.
Other words and sentences remain prompts, including `saving` and `updates`.
Use `felan -- deamon stop` to explicitly send command-shaped text as a prompt.
Invalid actions after `felan daemon` always fail with usage information and, when
unambiguous, a suggestion.

`/restart` restarts the daemon and then Felan Code, resuming the current
session, so rebuilt daemon and client code both take effect. `/daemon restart`
restarts only the daemon and reattaches the current session in place.

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

Invocations without `--mode` attach the interactive TUI to the daemon. `--mode
text` runs one headless daemon session and prints the final response; `--mode json`
emits Pi-compatible JSONL session events. JSONL stdout is machine-readable, while
diagnostics and failures go to stderr with a non-zero exit status. Both modes
require a prompt, support `--continue` and `--session`, and accept `--provider`,
`--model`, and `--thinking` for reproducible model selection. `--resume` remains
interactive-only. Headless startup never runs dependency onboarding or the
interactive update check. It detaches on completion; CI must use an explicit
isolated `--daemon-runtime` and stop that daemon explicitly.

## Daemon lifecycle

The daemon persists after a client exits. Use these management commands:

```sh
felan daemon status
felan daemon start
felan daemon foreground
felan daemon logs
felan daemon stop
felan daemon restart
```

`status` and `logs` never start it. `start` attaches to a compatible instance or
launches the exact installed daemon. `foreground` remains attached to the service.
`stop` and `restart` wait for active work to finish. If it does not finish
before the drain deadline, the command fails and the daemon keeps running; add
`--force` to interrupt the work instead. A replacement inherits the requesting shell environment. No
per-session environment is sent or persisted. The TUI offers `/daemon status`,
`/daemon logs`, `/daemon stop`, and `/daemon restart`. When active work (runs, subagents, interactive PTY or foreground processes, and pending questions)
would be interrupted, they ask once with the count and then stop or restart
immediately. A daemon from another Felan version is replaced automatically only
when it has no active work; otherwise the TUI shows how many active tasks a
restart would interrupt and asks first.

`/exit` (or Ctrl+D on an empty editor) detaches. Escape interrupts the current
run. `/close` disposes of the selected session. These actions do not
mean the same thing.

If the daemon connection drops, for example because the daemon restarts, the
TUI keeps the input usable and shows `Daemon disconnected · reconnecting in Ns
· /reconnect to retry now`. It retries automatically with backoff (250 ms,
doubling to 10 s, with no attempt limit) and, once the daemon is back,
reattaches the current session and briefly shows `Reconnected`. Automatic
retries only connect to a running daemon; they never start one, so an explicit
`felan daemon stop` stays stopped. `/reconnect` retries immediately and starts
the daemon when none is running. Input submitted while disconnected stays in
the editor; requests in flight when the connection dropped report that their
outcome is unknown, because the daemon may still be running them. ACP clients
reconnect the same way while the editor connection is open. Headless text runs
fail if the daemon does not return within 30 seconds; JSON runs fail on any
interruption because their event stream cannot be replayed.

`/reload` keeps all background processes. A daemon restart keeps detached
background processes, which the restored session rediscovers, and ends
interactive (PTY) ones, as quitting Felan Code did before the daemon.

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
the machine name `felan` and display title `Felan Code`. Each ACP attachment is a daemon client and can create, load, prompt, cancel, and
detach from Felan Code sessions. Felan Code accepts baseline text and resource-link
prompt blocks, replays the current persisted branch on load, and streams user,
assistant, thought, and tool-call updates. ACP uses strict daemon policy: it
applies to the session tree immediately (running tool calls keep the approvals
they already had) and returns to host defaults when the last ACP client detaches.
EOF detaches without answering pending interactions or stopping session work.

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
methods, hides secret and manual-code input, and saves credentials through the
daemon-owned credential store at `$FELAN_AGENT_DIR/auth.json` (`~/.felan/auth.json`
by default). Do not commit or share that file. Secrets use the ephemeral setup
answer path, never durable interaction answers or session transcripts. An ACP
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

ACP action safety is daemon-owned. Known mutation, process, network, and unknown
tools request `allow once` or `reject once`; known read-only/internal tools can
proceed. Approvals are durable daemon state, not a sandbox. MCP definitions
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

The local host loads source-controlled Felan Code built-ins, Felan-owned
settings and prompt appends, explicit Felan Code agents and Agent Skills, the
Agent Core-selected cwd instruction file, and external extensions explicitly
provided by local clients with repeatable, additive `--extension`/`-e` flags.
Remote creates cannot supply explicit paths. The host's `piExtensions.user`
and `piExtensions.project` settings, both off by default, load
`~/.pi/agent/extensions` and trusted `<cwd>/.pi/extensions` for every new root:
TUI, ACP, headless/print mode, web-created and imported sessions. Ambient Pi
packages, prompts, themes, project settings, and package resources remain
filtered.

Set `piExtensions.llamaCpp: true` in Felan's global settings to opt into Pi's
bundled llama.cpp integration for root sessions of any client, not children.
It is independent of the external `pi-llama` package, does not install or start
a router, and does not enable other Pi built-ins. After restarting, connect to an existing
llama.cpp router with `/login llama.cpp`, manage models with `/llama`, and
select one with `/model`.

External extension paths are fixed at creation. Resume and clone/fork retain
saved paths; adopting an unindexed transcript on attach loads no external
extensions. Children, including subagents and workers, load their root's
external extension paths; worker tool allowlists still limit active tools.

Only the creating TUI prompts for project folder trust. ACP, headless and web
creates skip undecided folders without saving a decision and load folders
already trusted directly or through a parent. External extensions execute with
the current user's permissions in all these sessions; they are not installed
from network/package sources.

When launched inside Herdr, the TUI reports its Felan Code lifecycle and session
identity through Herdr's inherited local socket environment. This is TUI-only
and does not enable ambient extensions or ACP. User-attention waits from Pi
extensions, including `ask_user`, Prewalk approval/review, and local MCP OAuth,
are reported as blocked; delegated subagent completions remain part of the
root workflow.

All built-ins are enabled by default, including the Powerline footer in TUI
sessions. Binary-backed features can remain inactive until their dependency is
installed or the feature is disabled through `/dependencies`.

Session compaction is also enabled by default and uses the verified summary
method. Set `extensionConfig.sessionCompaction.method` to `classifier` to drop
or shorten eligible bulky successful tool results instead when Pi's catalog has
an authenticated classifier model available; without one, or when the
classifier fails, it uses the verified summary. When idle with a large context,
the extension also compacts shortly before a known prompt-cache lifetime
expires (`compactBeforeCacheExpiry`). Summary mode uses the active model by default or the
configured `inherit`, `xhigh`, `high`, `medium`, or `low` policy. Tier selection
prefers the active provider/family and falls back to inherit when unavailable.
Both methods preserve structured continuity and expose `session_recall` for the
current active lineage. The extension is safe to disable with
`builtinExtensions.sessionCompaction: false`; Pi's native compactor then remains
in control and `session_recall` is removed.

After compaction, the transcript shows the completed method as `Context
compacted · Classifier`, `Context compacted · Summary`, or `Context compacted ·
Native`. Expand the row for the token count and checkpoint. If Felan cannot
complete its method, the warning is concise and native Pi compaction takes over.

Agent Core batches the complete classifier question set as needed; the local
host exposes the Agent Core classifier through the runtime. Bounded compaction
evidence is sent to the selected classifier provider's endpoint. Debug logs
default to
`storage('agent')/logs/felan.jsonl`.
Set `FELAN_LOG_LEVEL=off` to disable them, or `debug`/`info`/`warn`/`error` to
change the level.

Select **Classifier model** in `/settings` or set `felanClassifier.model` to
`auto` (the default) or an exact reference such as
`openrouter/typesafe/jev-1.13`. Auto prefers direct TypeSafe Jev, then the existing
OpenRouter Jev, then other Jev routes, then the first remaining authenticated
classifier in catalog order. An unavailable explicit choice warns and uses
Auto without overwriting the setting; no available classifier retains normal
fallbacks. Changes apply to the next new root session/restart. Pi owns the
auth store/catalog/transport; Agent Core keeps one `classify` operation and the
shared 2-second root preflight. Native token usage is reported, but missing
catalog pricing is not verified free inference.

When an authenticated classifier is available, the local host
also enables classifier guidance. For subagents, root sessions get a discovery
routing section when a request needs broad discovery, except in one-shot
print/JSON modes that cannot await child completion notices or small repositories.
`Agent` calls without a pinned model get a classifier-selected tier. For Prewalk, the classifier
recommends entry, sets planning exploration depth, may raise the implementation
tier or thinking level, and checks completion at the agent-run boundary.
Without a classifier, or when a call fails, the model follows the persistent delegation
and Prewalk guidance, and the configured defaults apply.

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
JSON files in `$FELAN_AGENT_DIR/themes` (default `~/.felan/themes`) load as user
themes and shadow those IDs when the JSON `name` matches, so a custom dark
palette survives `felan update`. The startup view uses a compact Felan Code
welcome; press `Ctrl+O` when you need the full startup help and loaded-resource
listing. When no theme is saved, Felan Code follows the terminal background
(OSC 11) automatically rather than the OS color-scheme (CSI 997). The `felan-*`
names are intentional: Pi reserves `dark` and `light` for its built-in
export themes, so colliding IDs would make exported sessions use different
colors. Powerline consumes that same active theme instead of defining its own
colors.
New installs use Pi's fullscreen TUI mode by default. A saved `tuiMode` setting
continues to take precedence; use `/settings` to switch between `fullscreen`
and `regular`. The prompt uses Pi's native editor rendering with one column of
horizontal padding by default; saved `editorPaddingX` values take precedence.

Model responses use the built-in `concise` output style by default. Set the
global `outputStyle` setting to `explanatory` for more reasoning and context.
The concise style prefers minimal prose, clear fragments, and compact bullets
while preserving exact technical content, conditions, caveats, verification,
and blockers; it expands when compression could create ambiguity or safety
risk. Use `extensionConfig.outputStyle.style: custom` with explicit `instructions` or
`instructionsFile` to test alternative prompt wording;
the [configuration guide](../../docs/user-guide/configuration.md#output-style)
documents validation, path resolution, and session-lifecycle behavior.

## Canonical user documentation

The package README intentionally stays short. Use these guides for operational
details:

- [Getting started](../../docs/getting-started.md)
- [Local CLI and storage](../../docs/user-guide/local-cli.md)
- [Configuration](../../docs/user-guide/configuration.md)
- [Commands and shortcuts](../../docs/user-guide/commands-and-shortcuts.md)
- [Model Fusion](../../docs/user-guide/fusion.md)
- [Claude Code plan models](../../docs/user-guide/claude-code.md)
- [Agents, tasks, and Prewalk](../../docs/user-guide/agents-tasks-and-prewalk.md)
- [Context and memory](../../docs/user-guide/context-and-memory.md)
- [Web, MCP, browser, and documents](../../docs/user-guide/web-mcp-and-browser.md)
- [Efficient execution and savings](../../docs/concepts/efficient-execution.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)

## Development

Source: `apps/felan` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/felan build
pnpm --filter @felan-ai/felan type-check
scripts/test-isolated.sh pnpm --filter @felan-ai/felan test
```

The development-only root preview (`pnpm theme:preview`) shows the two
host-owned themes across representative Pi, editor, and Powerline states. It
is intentionally a browser approximation rather than a second renderer.

Run `scripts/test-isolated.sh pnpm verify` from the repository root for cross-package and packed-binary
coverage.
