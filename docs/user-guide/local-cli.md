# Local CLI

`@felan-ai/felan` is the account-free local daemon client for Felan Agent Core.
It owns CLI, TUI, ACP, headless presentation, and local themes. The daemon owns
credentials, settings, storage, session/process execution, and lifecycle.

## Programmatic migration

The prepared, unpublished `@felan-ai/felan` 0.29.0 release removes legacy
in-process host exports. Consumers use
`runCli`, `runDaemonFelan`, `runLocalFelanHeadless`, `SessionClient`,
`newRequestId`, daemon target/client-configuration helpers, version, and
entrypoint resolution. Runtime/store/model/settings/classifier/subagent-host
constructors, `CliDependencies.openSession`, and headless host-runtime options
are removed. Use the daemon service; there is no in-process fallback.

Sessions saved by Felan Code 0.28.3 and earlier stay available after upgrading on
the same agent directory. They appear in the `/resume` and `--resume` picker,
`--continue` picks them up in their recorded working folder, and
`--session <id>`, headless runs and ACP `session/load` open them by ID. Opening
one adopts it in place: the daemon registers the existing file under its
existing session ID, and new turns are appended to that same file, so 0.28.3 can
still read it. Felan finds these files in the per-folder directories
under `~/.felan/sessions/` and directly in a custom `--session-dir`.

Exit 0.28.3 before resuming one of its sessions. After adoption the daemon is
the only writer; running 0.28.3 on the same session at the same time is
unsupported and can interleave or lose history. Malformed files are not listed. Until a session is opened, the picker shows its saved name or
first prompt, or its ID. `/import <path>` explicitly copies JSONL history into a new
daemon session without changing the original; `/export` exports a daemon
session.

## Invocation

```text
felan [options] [message]

--mode <text|json>  Run one headless session; JSON emits machine-readable JSONL
--provider <name>   Select a headless model provider
--model <name>      Select a headless model or provider/model reference
--thinking <level>  Select headless thinking: off|minimal|low|medium|high|xhigh|max
-e, --extension <path>  Load a local Pi extension (repeatable; interactive TUI only)
-c, --continue     Continue the most recent session for this directory
-r, --resume       Pick a session to resume
--session <id>     Resume a specific session
--session-dir <dir> Session directory for --session
--diagnostics      Print runtime versions and configuration mode
update             Update a global npm installation of Felan Code
savings            Show persisted estimated API-equivalent savings without starting a model session
acp                 Serve Agent Client Protocol v1 over stdio
acp login           Configure model-provider credentials in a finite terminal flow
daemon <action>     Manage the persistent local daemon
-h, --help         Show help
-v, --version      Print the Felan Code version
--verbose          Show verbose startup details
```

Use `--` before an initial message that begins with a dash. `--extension`/`-e`
accepts local extension files or directories and can be repeated. Paths are
resolved against the launch directory and remain active through root session
replacement, `/cwd`, `/reload`, and `/restart`. Network and package sources are
rejected. Selected extensions run only in the interactive root TUI, with the
current user's filesystem and process permissions; they are not passed to
headless, ACP, or subagent sessions. Optional `piExtensions` settings load Pi's
standard user and trusted project directories the same way. Unknown options are
rejected before the TUI starts.

### Native ACP v1

Start Felan Code's stable Agent Client Protocol v1 server with:

```sh
felan acp
```

Or run the published package without a global install:

```sh
npx --yes @felan-ai/felan acp
```

The server uses newline-delimited JSON over stdin/stdout. Stdout is guarded and
contains ACP frames only; diagnostics and startup failures use stderr. Do not
wrap the command with anything that prints banners or logs to stdout.
ACP clients receive the machine name `felan` and display title `Felan Code`.

The implemented agent surface is:

- `initialize`;
- `session/new` and `session/load`;
- `session/prompt`, with `session/cancel` notifications;
- `session/close`; and
- client-bound `session/update`, `session/request_permission`, and
  `elicitation/create` calls when needed.

ACP sessions attach to daemon-owned sessions. Loading replays the complete
current branch before the load request succeeds. Prompt turns accept ACP's
baseline `text` and `resource_link` blocks. Felan Code streams ordered user,
assistant, thought, and tool lifecycle updates. Unsupported prompt block types fail before the model runs.

ACP attaches with the daemon's strict policy. It applies to the session tree
immediately; running tool calls keep the approvals they already had, and the
tree returns to host defaults when the last ACP client detaches. EOF detaches
only the ACP attachment. It does not answer pending
interactions, stop session work, or replay interrupted work.

If the client advertises form elicitation, Pi extension `select`, `confirm`,
`input`, and `editor` requests are mapped to ACP forms. This enables
`ask_user` and Prewalk plan review. Without that capability, dialog UI is
reported as unavailable rather than silently accepted.

Known mutating, process, network, and other external-action tools request ACP
permission before execution. Unknown tool names are gated conservatively; known
read-only and internal tools can proceed. Felan Code offers only `allow once`
and `reject once`. The daemon durably owns approvals; rejection, malformed
responses, cancellation, or client failure blocks the call. The same
owning-session channel gates local subagent actions.

#### Authentication

When a client advertises ACP terminal-auth support, initialization includes a
terminal method that appends `login` to the configured `felan acp` command.
The client launches that separate interactive process and reconnects after it
exits successfully. The same flow can be started manually:

```sh
felan acp login
```

When the client launches Felan Code through `npx`, the equivalent command is:

```sh
npx --yes @felan-ai/felan acp login
```

Choose one of the configurable provider/authentication methods. The command
supports API-key prompts, OAuth URLs, device codes, provider choices, and
manual authorization codes. Secret and manual-code input is not echoed or
included in diagnostics. Exit status `0` means `ModelRuntime.login` persisted
the credential in `$FELAN_AGENT_DIR/auth.json` (`~/.felan/auth.json` by
default) and synchronized local model state. Treat that file as sensitive; do
not commit or share it. Cancellation, signals, storage/synchronization
failures, and provider failures are non-zero.
Unauthenticated session creation returns ACP's typed `Authentication required`
error (`-32000`). Zed or another ACP client should reconnect and retry after a
successful terminal login.

#### Zed custom-agent configuration

Install `felan` on the environment `PATH` visible to Zed, then add a custom
external agent to Zed's `settings.json`:

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

For an on-demand package launch, configure `"command": "npx"` with
`"args": ["--yes", "@felan-ai/felan", "acp"]`. ACP clients append the
advertised `["login"]` arguments for the separate terminal-auth process, so
the resulting command is `npx --yes @felan-ai/felan acp login`.

You can use an absolute `command` path instead when Zed does not inherit the
same `PATH`. Zed's own model credentials are not Felan Code credentials. Complete
Felan Code's terminal login when prompted, then open a new external-agent
connection.

#### MCP behavior

Felan Code accepts and ignores MCP definitions in ACP `session/new` and
`session/load`. This keeps clients such as Zed compatible when they attach
project MCP configuration, without launching client-provided executables or
using client-provided URLs, headers, or credentials.

Felan Code's configured MCP extension remains separate. Configure it through
`$FELAN_AGENT_DIR/mcp.json`; it supports explicit OAuth-only Streamable HTTP
with SSE fallback and its own credential store.

#### Security boundary and non-goals

ACP runs in the local host with the current user's filesystem, process, and
network permissions. It is not an OS sandbox.

The native server intentionally does not provide:

- a remote HTTP/WebSocket ACP listener;
- `authenticate` for the advertised terminal method, logout, session
  list/delete/fork/resume, session modes, or config-option methods;
- additional workspace roots;
- image, audio, or embedded-resource prompt blocks;
- session-provided MCP servers or tools;
- direct injection of remote MCP tools, resources, prompts, sampling, Apps, or
  scripting; or
- an OS sandbox.

### Daemon lifecycle

The daemon persists after a TUI, ACP, or headless client disconnects:

```sh
felan daemon status
felan daemon start
felan daemon foreground
felan daemon logs
felan daemon stop
felan daemon restart
```

`status` and `logs` never start it. `start` attaches to a compatible instance or
launches the exact installed daemon; `foreground` remains attached to the service.
`stop` and `restart` wait for active work to finish. If it does not finish
before the drain deadline, the command fails and the daemon keeps running; add
`--force` to interrupt the work instead. Restart launches the replacement with the requesting shell
environment; no per-session environment is transported or persisted.

Use `--daemon-runtime <dir>` only for a private test/CI namespace. Headless
completion detaches from that daemon; it does not stop it. CI must explicitly
stop the isolated daemon it started.

In the TUI, `/daemon status`, `/daemon logs`, `/daemon stop`, and `/daemon
restart` provide the same lifecycle controls. When active work (runs, subagents, interactive PTY or foreground processes, and pending questions) would be
interrupted, they ask once with the count and then stop or restart immediately.
A daemon from another Felan version is replaced automatically only when it has
no active work; otherwise the TUI shows how many active tasks a restart would
interrupt and asks first. Ctrl+D on an empty editor
and `/exit` detach the client. Escape interrupts the current run. `/close`
disposes of the session. These are distinct actions.

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

### Resume a session

`felan --resume` opens a selection-only picker. It opens on the newest sessions
of the current directory while older sessions and other folders load in the
background. Use Tab to switch between the current folder and all local sessions,
Ctrl+S to change sorting, Ctrl+N to show only named sessions, and Ctrl+P to
toggle session-file paths. Escape cancels without creating or launching a
session. `felan --continue` remains the quick path for the most recent session in
the current directory.

A new session appears in the picker once it has a message. A session that is
never used is discarded after it has been idle for about a minute.

For a new interactive root session, Felan Code asynchronously creates a concise
session name from the first prompt. The name is persisted in the local session
file and appears in the resume picker. Existing names, resumed sessions,
subagents, and headless runs are not renamed. If generation fails, the picker
continues to use the first prompt as its fallback.

### Update Felan Code

Update a globally installed Felan Code CLI with:

```sh
felan update
```

The command checks npm's stable `latest` release without starting the TUI. If
the global installation is current, it reports that no update is needed. If a
newer release is available, it installs that exact `@felan-ai/felan` version
and tells you to restart Felan Code. Registry, installation, and verification
failures return a non-zero exit status and do not claim success.

Interactive Felan Code checks npm once per launch, asynchronously, with a ten-second
timeout and no retries. A newer stable release produces a notification to exit
all Felan Code sessions and run `felan update` for global npm, or use the package
manager that launched Felan Code. Offline, failed, and malformed responses stay
silent. Startup checks never install updates. Set
`FELAN_SKIP_VERSION_CHECK=1` to disable the request.

Self-update is limited to the verified global npm installation that provides
the running `felan` command. `npx`, local/source, pnpm, yarn, and bun
installations are not changed; update those with their normal package-manager
command instead. To send `update` as an initial prompt, use `felan -- update`.

### Savings

Read the same persisted estimates used by `/savings` without starting a model
session:

```sh
felan savings
felan savings --project
felan savings --session <id>
felan savings --daily
felan savings --monthly
felan savings --format json
```

These values are estimated API-equivalent cost avoided by supported
optimizations, not provider billing or guaranteed subscription savings. See
[Efficient execution and savings](../concepts/efficient-execution.md) for the
measurement basis and claim boundaries.

On Windows, exit every running Felan Code process before updating. npm replaces the
installed package directory, and another Felan Code process, antivirus scanner, or
file indexer holding a file or the directory can cause an `EBUSY` rename error.
The updater runs npm from outside that directory; if the error persists, retry
manually from another directory:

```bat
cd /d %TEMP%
npm install --global @felan-ai/felan
```

Without `--mode`, invocations that start or continue an agent session launch the
interactive TUI. `felan update` and informational flags exit without starting a
session. `--mode text` and `--mode json` are one-shot headless modes and require
an initial prompt:

```sh
felan --mode text "inspect this project and summarize the risks"
felan --mode json --provider openai --model gpt-5.6-sol --thinking high "run the tests"
felan --mode text --continue "continue the previous task"
```

Text mode prints the final assistant response. JSON mode emits the Pi-compatible
session header and JSONL events, including assistant, tool, and usage events.
Stdout contains only the requested response/event stream; diagnostics and
failures go to stderr. Missing prompts, unavailable models, model errors, and
extension failures return a non-zero status. `--resume` and UI-only commands are
interactive-only. Headless startup does not open the TUI, run the update check,
or wait for dependency onboarding.

### Restart the daemon

`/restart` restarts the daemon and then Felan Code, resuming the current
session, so rebuilt daemon and client code both take effect. `/daemon restart`
restarts only the daemon in place: the TUI shows `Daemon restarting…`, starts
the replacement, reattaches the current session, and keeps your editor input.

### Herdr integration

When Felan Code runs inside Herdr, the local TUI automatically reports its Felan Code
session and lifecycle state to Herdr. The integration is active only when Herdr
provides `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`; it reports
`working`, `idle`, and `blocked` over Herdr's local socket. Each terminal reports
only for its own pane and the session it is attached to; the shared daemon does
not report. A session prompt waiting for your answer, such as `ask_user` or
Prewalk approval and plan review, is reported as `blocked` with the prompt's
title. Delegated subagent work keeps the session `working` until the session
has consumed every subagent result, so the overall workflow produces one
completion notification rather than one per child.
Headless text and JSON sessions do not report terminal-agent state.

This is a local terminal integration and is separate from ACP support. Felan Code
reports the `felan` agent identity and its session ID. Herdr versions without a
native Felan Code agent kind still accept its lifecycle reports as a custom agent;
native managed launch and session restoration require Felan Code support in Herdr.
Restoration resolves the ID from Felan Code's configured or default session
directory, so a one-off `--session-dir` outside that directory cannot be
restored automatically.

## Diagnostics

```sh
felan --diagnostics
```

Diagnostics report the Felan Code, Agent Core, Pi, and Node.js versions plus the
runtime and credential modes. The local application reports `host` runtime and
`local` credentials.

## Local state

The default root is `~/.felan`; override it with `FELAN_AGENT_DIR`.

```text
$FELAN_AGENT_DIR/
  settings.json
  APPEND_SYSTEM.md
  mcp.json
  agents/
  themes/
  sessions/
  storage/
    agent/
    sessions/<encoded-root-session-id>/
  memory/v1/projects/<project-hash>/
```

Provider credential and model state also live under the local agent directory
and are managed by the login/model flows. Do not commit this directory.

Root sessions and their nested subagents share the same root-session storage
directory. Longer-retention extension state uses `storage/agent`.

## Sessions

Felan Code recreates its runtime, filtered settings, resources, and presentation for
new, resumed, forked, cloned, and imported root sessions. Each runtime uses the
active session working directory and maps relative paths from there.

Nested subagents work in the same project and share the root session's
extension storage. They have separate Pi session histories and bounded
execution lifecycles.

### Change the active directory

Inside the interactive TUI, use `/cwd <directory>` to dispose the current root
session and start a fresh session in another directory:

```text
/cwd ../felan-platform
```

Paths are resolved relative to the active agent cwd; absolute and `~/...`
paths are also supported. Press Tab after `/cwd ` for directory completion.
The parent shell is not changed. Felan Code rebuilds all cwd-bound resources for the
new session, including settings, instructions, skills, tools, memory, and
subagents.

## Resource policy

The local host loads:

- Felan Code's source-controlled built-in extensions;
- `$FELAN_AGENT_DIR/APPEND_SYSTEM.md`;
- one cwd-level `AGENTS.md`, falling back to `CLAUDE.md`;
- nested `AGENTS.md` or `CLAUDE.md` discovered by progressive context;
- explicit user/workspace Felan Code agent definitions;
- Agent Skills from `~/.agents/skills` and `<workspace>/.agents/skills`; and
- user Pi theme JSON from `$FELAN_AGENT_DIR/themes`.

Interactive root TUI sessions can additionally load local Pi extension files or
directories explicitly supplied with repeatable `--extension`/`-e` flags, and
can opt in to `~/.pi/agent/extensions` and trusted `<cwd>/.pi/extensions` with
`piExtensions` in `$FELAN_AGENT_DIR/settings.json`. These paths are not loaded
in headless, ACP, or subagent sessions.

Ambient Pi packages, prompts, project settings, themes, skills, and package
resources stay filtered. Felan Code also does not import Claude, Cursor, Codex, or
other tools' ambient extension configuration.

Felan Code supplies two host-owned Pi themes, `felan-light` and `felan-dark`, and
uses `felan-light/felan-dark` by default when no saved theme setting exists.
JSON files in `$FELAN_AGENT_DIR/themes` (default `~/.felan/themes`) load as user
themes. A file whose JSON `name` is `felan-light` or `felan-dark` shadows the
packaged theme of that ID and survives `felan update`. Auto light/dark follows
the terminal background (OSC 11), not the OS color-scheme (CSI 997), so a dark
terminal on a light desktop stays on the dark theme ID. The active Pi theme is
shared by built-in UI, Felan Code overlays, and the Powerline footer. Felan Code
keeps these namespaced rather than replacing Pi's `dark` and `light` IDs:
Pi resolves those built-in names first when exporting HTML, which would
make runtime and exported sessions disagree.

Startup is intentionally compact: it shows a Felan Code welcome and key hints
instead of listing every Context, Skill, Extension, and Theme. Press `Ctrl+O`
for the full help and loaded-resource view; startup diagnostics remain visible.

## Tool presentation

The local transcript groups adjacent tool activity by default. Press `Ctrl+O`
to reveal bounded previews, and use `/tools` or `Alt+T` to inspect complete
arguments and results for one root-session call.

Set `felanTui.toolDisplay` to `full` to use the ungrouped presentation. The
[configuration guide](configuration.md) contains the complete example.

The Powerline footer is enabled by default in TUI sessions. It shows selected
Git, model, session, subscription, recent all-local savings, context, and
extension state. The session token and cost totals include the root session and
all local subagent sessions for that root, including retained subagent work.
Savings defaults to seven inclusive UTC calendar days and can be configured with
the Powerline `savings.periodDays` segment field. Disable the `powerline` built-in
explicitly if you prefer the agent rail beneath the editor.

## Permission model

The local runtime uses host path access and the current user's filesystem and
process permissions. Storage handles contain extension-owned state, but they
do not turn the overall host runtime into a sandbox.

See [Runtime and security](../concepts/runtime-and-security.md) for the full
boundary and [Configuration](configuration.md) for local policy files.
