# @felan-ai/felan

Local, account-free Felan terminal agent built on `@felan-ai/agent-core` and
Pi's interactive TUI.

```sh
npx @felan-ai/felan
```

The package exposes the `felan` binary. It stores model credentials, settings,
sessions, agents, and runtime state under `~/.felan` by default; set
`FELAN_AGENT_DIR` to select another directory. Use `/login` inside the TUI to
configure provider-owned model credentials without a Felan account. Felan reads
global settings from `~/.felan/settings.json` and does not load Pi project
settings. Pi project trust does not apply to Felan's fixed resource policy, so
Felan starts without a project trust prompt.

Felan suppresses Pi's version notification, bundled changelog, package update
notifications, and install/update telemetry. Update behavior is owned by the
Felan application.

Each session uses a `HostAgentRuntime` with host path access. Its cwd resolves
relative paths, while file operations and process working directories can use
any path available to the current user. Pi's session runtime recreates the host
runtime, filtered settings, resources, and session composition for new, resume,
fork, clone, and import flows, then rebinds the active interactive UI. Host mode
is not an isolation boundary.

Root sessions store extension state under
`$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>`. Every nested
subagent shares its root session's storage path. Longer-retention agent state
uses `$FELAN_AGENT_DIR/storage/agent`. Storage handles remain scoped to their
declared roots, while ordinary runtime file operations can access these and
other host paths directly.

Only source-controlled built-in Felan extensions can be imported. External
packages, extensions, configured skill paths, prompts, themes, and Pi context
files remain filtered. Agent Skills are loaded from `~/.agents/skills` and
`<workspace>/.agents/skills` and are shared with local subagents.
The built-in powerline reads `~/.felan/powerline.json` (or
`$FELAN_AGENT_DIR/powerline.json`) once when it initializes. Its subscription
segment obtains the active Codex or Claude OAuth token through Felan's
`ModelRuntime` and requests usage from that provider's fixed endpoint.

All built-in extensions are enabled by default. Toggle them in
`~/.felan/settings.json`:

```json
{
  "builtinExtensions": {
    "subagents": true,
    "askUser": true,
    "tasks": true,
    "prewalk": true,
    "context": true,
    "webAccess": true,
    "backgroundBash": true,
    "codex": true,
    "powerline": false
  }
}
```

`askUser` provides the sequential `ask_user` tool. The local host presents
single questions or 1-4 question wizards as searchable overlays or inline
dialogs, with multi-select, freeform answers, and optional comments.

`tasks` provides `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` over one
dependency-aware graph shared by the root session and every nested subagent.
Task state lives under
`$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>/tasks`. Use `/tasks`
or `Ctrl+Shift+T` to inspect list, detail, and graph views.

`webAccess` provides bounded web search, source verification, readable URL
fetching, and stored-content retrieval. Search supports OpenAI/Codex, Exa,
Brave, and self-hosted SearXNG. Configure providers in
`$FELAN_AGENT_DIR/web-search.json`. Model-facing web content is explicitly
encoded as untrusted external data; private and reserved network targets are
blocked by default.

`backgroundBash` augments `bash` with detached processes for models outside the
`openai` and `openai-codex` providers. Logs and process metadata live under
`$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>/background-bash/<workspace-key>/jobs`.
Use `/background-bash` or `Ctrl+Shift+J` to inspect them.

`codex` activates `exec_command`, `write_stdin`, `apply_patch`, and
`view_image` for GPT models on the exact `openai` and `openai-codex` providers.
`view_image` is included only for models with image input. It restores the
ordinary coding tools when another model is selected. Root and nested sessions
load the same optional request controls from `$FELAN_AGENT_DIR/codex.json`; see
the extension package README for the three supported fields.

## System prompt append

The TUI reads one optional `$FELAN_AGENT_DIR/APPEND_SYSTEM.md` file when each
session is constructed (`~/.felan/APPEND_SYSTEM.md` by default). Missing and
blank files add nothing; other read failures stop session construction with the
filesystem error. The file extends Agent Core's Felan prompt after enabled
extension capabilities. Child persona instructions follow this application
append. Explicit Agent Skills and the current working directory are added last.

System prompt inputs are limited to Agent Core, enabled capabilities, the
single application append above, explicit Agent Skills, and the current working
directory. Pi `SYSTEM.md`, project `APPEND_SYSTEM.md`, and project
prompt/context files stay outside local composition.

When enabled, `@felan-ai/ext-subagents` uses the session-bound local host and
provides `Agent`, `list_subagents`,
`get_subagent_result`, `steer_subagent`, and `cancel_subagent`. A root-scoped
local host queues every run asynchronously, persists the latest child session
metadata, delivers completion notices, supports bounded nesting, and uses the
application's current workspace. The TUI status line shows active/recent child
state, and runtime shutdown awaits active-child cancellation before Pi teardown.
Completed-child continuation uses the same child ID and Pi session file while
replacing the latest result. The default list also
includes `@felan-ai/ext-powerline` for an ANSI-aware footer with subscription
usage; it is a direct TUI dependency and is not part of cloud composition.

Local agent definitions are loaded only from bundled Felan definitions,
`~/.felan/agents/*.md` (or `$FELAN_AGENT_DIR/agents/*.md`), and
`<workspace>/.felan/agents/*.md`, with
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
