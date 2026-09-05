# Local CLI

`@felan-ai/felan` is the account-free local terminal host for Felan Agent Core.
It owns credentials, settings, storage paths, built-in selection, lifecycle,
and TUI presentation.

## Invocation

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
savings            Show persisted estimated API-equivalent savings without starting a model session
-h, --help         Show help
-v, --version      Print the Felan version
--verbose          Show verbose startup details
```

Use `--` before an initial message that begins with a dash. Unknown options are
rejected before the TUI starts.

### Resume a session

`felan --resume` opens a selection-only picker. Use Tab to switch between the
current folder and all local sessions, Ctrl+S to change sorting, Ctrl+N to show
only named sessions, and Ctrl+P to toggle session-file paths. Escape cancels
without creating or launching a session. `felan --continue` remains the quick
path for the most recent session in the current directory.

For a new interactive root session, Felan asynchronously creates a concise
session name from the first prompt. The name is persisted in the local session
file and appears in the resume picker. Existing names, resumed sessions,
subagents, and headless runs are not renamed. If generation fails, the picker
continues to use the first prompt as its fallback.

### Update Felan

Update a globally installed Felan CLI with:

```sh
felan update
```

The command checks npm's stable `latest` release without starting the TUI. If
the global installation is current, it reports that no update is needed. If a
newer release is available, it installs that exact `@felan-ai/felan` version
and tells you to restart Felan. Registry, installation, and verification
failures return a non-zero exit status and do not claim success.

Interactive Felan checks npm once per launch, asynchronously, with a ten-second
timeout and no retries. A newer stable release produces a notification to exit
all Felan sessions and run `felan update` for global npm, or use the package
manager that launched Felan. Offline, failed, and malformed responses stay
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

On Windows, exit every running Felan process before updating. npm replaces the
installed package directory, and another Felan process, antivirus scanner, or
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
felan --mode json --provider openai --model gpt-5.5 --thinking high "run the tests"
felan --mode text --continue "continue the previous task"
```

Text mode prints the final assistant response. JSON mode emits the Pi-compatible
session header and JSONL events, including assistant, tool, and usage events.
Stdout contains only the requested response/event stream; diagnostics and
failures go to stderr. Missing prompts, unavailable models, model errors, and
extension failures return a non-zero status. `--resume` and UI-only commands are
interactive-only. Headless startup does not open the TUI, run the update check,
or wait for dependency onboarding.

## Diagnostics

```sh
felan --diagnostics
```

Diagnostics report the Felan, Agent Core, Pi, and Node.js versions plus the
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

Felan recreates its runtime, filtered settings, resources, and presentation for
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
The parent shell is not changed. Felan rebuilds all cwd-bound resources for the
new session, including settings, instructions, skills, tools, memory, and
subagents.

## Resource policy

The local host loads only:

- Felan's source-controlled built-in extensions;
- `$FELAN_AGENT_DIR/APPEND_SYSTEM.md`;
- one cwd-level `AGENTS.md`, falling back to `CLAUDE.md`;
- nested `AGENTS.md` or `CLAUDE.md` discovered by progressive context;
- explicit user/workspace Felan agent definitions; and
- Agent Skills from `~/.agents/skills` and `<workspace>/.agents/skills`.

Ambient Pi extensions, packages, prompts, project settings, themes, and package
resources are filtered. Felan also does not import Claude, Cursor, Codex, or
other tools' ambient extension configuration.

Felan supplies two host-owned Pi themes, `felan-light` and `felan-dark`, and
uses `felan-light/felan-dark` by default when no saved theme setting exists.
The active Pi theme is shared by built-in UI, Felan overlays, and the Powerline
footer. Felan keeps these namespaced rather than replacing Pi's `dark` and
`light` IDs: Pi 0.85.0 resolves those built-in names first when exporting HTML,
which would make runtime and exported sessions disagree.

Startup is intentionally compact: it shows a Felan welcome and key hints
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
