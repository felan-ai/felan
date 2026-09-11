# Commands and shortcuts

Type `/` in the TUI to discover commands registered for the current session.
Some commands are provided by Pi; the table below focuses on Felan Code's local host
and first-party extensions.

## Local host commands

| Command | Purpose |
| --- | --- |
| `/cwd [directory]` | Start a fresh session in another directory |
| `/restart` | Restart Felan Code and resume the current session |
| `/dependencies` | Inspect, install, enable, or disable external runtime dependencies |
| `/memory` | Show project-memory status and inspect retained runs |
| `/memory run` | Process pending memory evidence now, recovering backoff when needed |
| `/memory open` | Open canonical project memory in the local TUI |
| `/agents` | Open the subagent navigator |
| `/tools` | Open the inline inspector for complete root-session tool arguments and results |
| `/savings` | Show estimated API-equivalent savings for the current root session (`project`, `all`, or `details` also supported) |

`/dependencies`, `/memory`, and `/memory open` require the interactive TUI.

`/cwd` accepts a path relative to the current agent directory, an absolute
path, or a `~/...` path. Press Tab after `/cwd ` to complete directories. The
command disposes the current root runtime and starts a fresh session in the
target directory, rebuilding cwd-bound settings, instructions, skills, tools,
memory, and subagents. The parent shell's directory is unchanged; use `/cwd .`
to start a new session for the current directory.

Use `/restart` after rebuilding Felan Code from source to load fresh Felan Code, Agent
Core, and extension modules without losing the active session history. Unlike
Pi's `/reload`, this replaces the Node process; it is available only in the
interactive TUI and requires the agent to be idle.

## Extension commands

| Command | Purpose |
| --- | --- |
| `/tasks` | Open task list, detail, and dependency-graph views |
| `/prewalk [task]` | Arm Prewalk, optionally starting the task immediately |
| `/prewalk status` | Show phase, target model, and restoration setting |
| `/prewalk exit` | Exit Prewalk; `off` and `cancel` are aliases |
| `/processes` | Inspect processes and logs |
| `/mcp [status\|tools\|reconnect\|auth\|logout] [server]` | Inspect and manage configured remote MCP servers |
| `/markitdown` | Show document-converter status |
| `/markitdown install` | Explicitly install the managed converter |
| `/progressive-context` | Show progressively loaded nested instructions |
| `/context` | Show estimated current context-window usage inline (or in the configured overlay) |
| `/insights` | Generate a local Felan Code session analytics snapshot with date/session filters, charts, calendar, and optional Savings breakdowns |
| `/rtk` | Open interactive RTK settings |
| `/rtk show` | Show RTK configuration and runtime status |
| `/rtk verify` | Recheck the active runtime for RTK |
| `/rtk install` | Explicitly install the pinned reviewed RTK release |

The Browser extension is model-facing and does not add a user slash command.
Use `/dependencies` to manage its external CLI.

Every `/insights` run rescans visible root and retained subagent transcripts,
reparses new or changed files, and replaces the self-contained static HTML
report. Opening that file later does not read live data; run `/insights` again
to regenerate it. `--refresh` only forces unchanged files to be reparsed. Date
ranges use event timestamps, including the start and excluding the end, and
group retained subagent activity under its root session.

## Common Pi commands

The local application retains selected Pi interaction commands such as
`/login`, `/logout`, `/model`, and `/reload`, while filtering ambient Pi
resources and project settings. Use the live `/` menu for the authoritative
list provided by the pinned Pi version.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+A` | Open the subagent navigator |
| `Alt+T` | Open the complete tool-call inspector |
| `Ctrl+Shift+T` | Open task views |
| `Ctrl+Shift+J` | Open process/log views |
| `Ctrl+O` | Toggle bounded tool and completion previews |
| `Ctrl+R` / `Cmd+R` | Open prompt history; cycle scope while the picker is open |

Prompt history starts with the current session. Press `Ctrl+R`, `Cmd+R`, or
`Ctrl+S` inside the picker to cycle through the current project and all
projects. Search is fuzzy, incremental, and bounded to the newest 50 unique
prompts. `Enter` replaces the editor text; `Esc` cancels. This is interactive
TUI functionality and is unavailable in headless modes. While the built-in is
enabled, Felan Code unbinds Pi's `app.session.rename` default from `Ctrl+R`; an
explicit alternative rename binding in `$FELAN_AGENT_DIR/keybindings.json` is
preserved.

At the newest prompt, press Down to move from the editor into the live
subagent rail. Use Up/Down to select an agent and Enter to open it; Up from the
first row returns to the editor.

The startup header also advertises `/` command discovery and `!` shell mode.
Shell commands still run with the local user's permissions.

## CLI flags

These are the flags accepted directly by the `felan` binary:

```text
-c, --continue
--diagnostics
-h, --help
-v, --version
--verbose
```

Enabled configurable extensions add generated options to this list. For
example, `--prewalk-entry-approval allow` and `--powerline-style capsule` are
also accepted. The same values can be persisted in `settings.json` or edited
through `/settings`.
