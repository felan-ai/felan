# Local CLI

`@felan-ai/felan` is the account-free local terminal host for Felan Agent Core.
It owns credentials, settings, storage paths, built-in selection, lifecycle,
and TUI presentation.

## Invocation

```text
felan [options] [message]

-c, --continue     Continue the most recent session for this directory
--diagnostics      Print runtime versions and configuration mode
-h, --help         Show help
-v, --version      Print the Felan version
--verbose          Show verbose startup details
```

Use `--` before an initial message that begins with a dash. Unknown options are
rejected before the TUI starts.

The public CLI always launches the interactive terminal application. Internal
headless modes used by subagents and extension adapters are not public CLI
entry points.

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
  powerline.json
  mcp.json
  codex.json
  web-search.json
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

## Tool presentation

The local transcript groups adjacent tool activity by default. Press `Ctrl+O`
to reveal bounded previews, and use `/tools` or `Alt+T` to inspect complete
arguments and results for one root-session call.

Set `felanTui.toolDisplay` to `full` to use the ungrouped presentation. The
[configuration guide](configuration.md) contains the complete example.

The Powerline footer is enabled by default in TUI sessions. It shows selected
Git, model, session, subscription, context, and extension state. Disable the
`powerline` built-in explicitly if you prefer the agent rail beneath the editor.

## Permission model

The local runtime uses host path access and the current user's filesystem and
process permissions. Storage handles contain extension-owned state, but they
do not turn the overall host runtime into a sandbox.

See [Runtime and security](../concepts/runtime-and-security.md) for the full
boundary and [Configuration](configuration.md) for local policy files.
