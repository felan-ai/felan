# @felan-ai/felan

Local, account-free Felan terminal agent built on `@felan-ai/agent-core` and
Pi's interactive TUI.

```sh
npx @felan-ai/felan
```

The package exposes the `felan` binary. It stores model credentials, settings,
and sessions under `~/.felan/agent` by default; set `FELAN_AGENT_DIR` to select
another local directory. Use `/login` inside the TUI to configure provider-owned
model credentials without a Felan account.

Each session uses a cwd-bound `HostAgentRuntime`. Pi's session runtime recreates
the host runtime, filtered settings, resources, and session composition for
new, resume, fork, clone, and import flows, then rebinds the active interactive
UI. Host mode uses the current user's filesystem and process permissions and is
not an isolation boundary.

Only the source-controlled Felan extension package list is imported. Ambient Pi
packages, extensions, skills, prompts, themes, and context files remain filtered;
inline Felan extensions can still provide shared tools, prompts, interaction,
and subagent behavior. The application explicitly configures
`@felan-ai/ext-subagents` with its session-bound local host; the extension provides `Agent`, `list_subagents`,
`get_subagent_result`, `steer_subagent`, and `cancel_subagent`. A root-scoped
local host tracks foreground and background runs, persists the latest child session
metadata, delivers completion notices, supports bounded nesting, and uses the
application's current workspace. The TUI status line shows active/recent child
state, and runtime shutdown awaits active-child cancellation before Pi teardown.
Completed-child continuation uses the same child ID and Pi session file while
replacing the latest result. The default list also
includes `@felan-ai/ext-powerline` for an ANSI-aware footer; it is a direct TUI
dependency and is not part of cloud composition.

Local agent definitions are loaded only from bundled Felan definitions,
`$FELAN_AGENT_DIR/agents/*.md`, and `<workspace>/.felan/agents/*.md`, with
project definitions taking precedence. Pi ambient agent discovery remains
disabled. Local subagent concurrency defaults to four and depth defaults to
three; set `felanSubagents.concurrency` and `felanSubagents.maxDepth` in the
Felan settings file to configure those bounded values.

Local model selectors are deterministic and support explicit inheritance or an
exact authenticated `provider/model`; exact selectors never fall back. Requested
thinking levels are checked against that resolved model and unsupported levels
return `unsupported_thinking` instead of being silently clamped.

```sh
felan --diagnostics
```

Diagnostics include the Felan, Agent Core, Pi, and Node.js versions.

## Development

Source: `apps/tui` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/felan build
pnpm --filter @felan-ai/felan test
```
