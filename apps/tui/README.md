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

Local memory is enabled by default and works without a Felan account or cloud
connection. It consolidates settled root-session evidence into an inspectable
Markdown wiki. The canonical project store is outside the customer repository:

```text
$FELAN_AGENT_DIR/memory/v1/projects/<project-hash>/
  state.json
  current/summary.md
  current/index.md
  current/pages/...
```

The project hash is derived from the canonical Git root, or the canonical cwd
when no repository exists. Root-session storage receives a non-authoritative
copy at `storage/sessions/<root-id>/.memory`; child sessions can read that copy
but ordinary edits never publish it. Felan does not create `<repository>/.memory`
and does not synchronize local memory with cloud team memory.
Each session receives one hidden persisted memory-context entry at startup;
provider calls reuse it, and compaction or tree navigation restores it only if
it is no longer on the active branch. That entry is excluded from memory
evidence processing. Once it loads successfully, the welcome screen's
`[Context]` section lists the projected `.memory/summary.md` path alongside
project instructions so the loaded summary can be opened directly. The summary
is orientation only: substantive memory-backed answers should follow the
projected absolute `index.md` links to relevant pages and cite page paths and
their `Sources` session IDs.

Use `/memory status`, `/memory run`, `/memory enable`, `/memory disable`, or
`/memory open` to inspect and control local processing. A missing local model
credential never prevents startup or recall of existing memory; processing
remains pending until a configured model is available. Processing is idle
batched while Felan runs and catches up on the next launch after shutdown. The
enable/disable commands persist `felanTui.memoryProcessing` and do not remove
the memory recall extension.

After checkpoints are recorded, the TUI coordinator owns idle batching,
startup recovery, retries, and shutdown cancellation. Each batch runs one
disposable headless Pi memory-dreamer session against staging. It reads the
immutable `.dreaming/input` manifest and transcripts, edits staged `.memory`
files in place, and returns only a concise completion summary. The worker has
no normal Felan extensions, skills, repository context, credentials, or
process execution; its active tools are limited to `read`, `ls`, `edit`, and
`write`. The worker has no separate turn, tool-call, or per-file I/O budgets;
the only execution failsafe is a one-hour wall-clock timeout. The coordinator
validates and publishes the staged filesystem output, so model, validation,
cancellation, timeout, or publication failures leave evidence pending for
retry. The worker uses the active root-session model when it is authenticated;
if that model is unavailable, it falls back to another authenticated available
model. With no authenticated model, evidence remains pending. The portable
`@felan-ai/ext-memory` extension only recalls memory and records root
checkpoints; it does not schedule dreaming.

Evidence ingestion is separate from the worker's file-tool policy. The host
opens each checkpoint's append-only JSONL session with a bounded snapshot and
streams only the visible active-branch delta; abandoned branches, hidden
memory-context entries, and unrelated large tool output are not staged. Source
files may be much larger than the evidence sent to the model. After redaction,
each staged transcript is capped at 256 KiB. A changed, missing, or malformed
checkpoint source remains pending without blocking valid checkpoints in the
same batch; it is retried by `/memory run`, a newer cursor, or a later launch.
The dreamer updates affected pages and cross-links, preserves valid historical
source entries, marks superseded or conflicting claims, and performs a bounded
semantic maintenance pass before publication. Root-index links in each session
projection are rebased to that projection's absolute `.memory` path; canonical
memory remains unchanged.

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
files remain filtered. Agent Core separately loads one instruction file from
the session cwd, preferring `AGENTS.md` over `CLAUDE.md`. Agent Skills are
loaded from `~/.agents/skills` and `<workspace>/.agents/skills` and are shared
with local subagents.
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
    "markitdown": true,
    "mcp": true,
    "webAccess": true,
    "backgroundBash": true,
    "codex": true,
    "rtkOptimizer": true,
    "memory": true,
    "powerline": false
  }
}
```

On the first interactive startup with a missing external runtime dependency,
Felan opens a dependency wizard before the first prompt. MarkItDown can be
installed into Felan's managed Python environment or disabled. RTK can be
installed with its pinned official installer or skipped while its
binary-independent output compaction remains active. Background Bash is
disabled when required POSIX process utilities are unavailable. Choices are
stored in global settings, never prompt in non-interactive sessions, and can be
revisited with `/dependencies`. Install actions always require explicit
confirmation.

The local transcript groups adjacent tool calls by default, with one concise
action row per call beneath each group title. Press `Ctrl+O` to show bounded
result previews. Use `/tools` or `Alt+T` to inspect the complete arguments and
result for one root-session call. Selected subagent transcripts use the same
grouped or full tool rendering and `Ctrl+O` previews. Subagent completion
notices stay on one summary line by default; `Ctrl+O` shows a bounded preview
and `Alt+A` opens full agent details. Grouped reads from projected or canonical
local memory appear as `Memory Recall`; conservative read-only Codex commands
receive the same label without hiding mutating or arbitrary shell commands.
To restore Pi's original ungrouped rendering, set:

```json
{
  "felanTui": {
    "toolDisplay": "full"
  }
}
```

Supported values are `grouped` and `full`; `grouped` is the default.

`askUser` provides the sequential `ask_user` tool. The local host presents
single questions or 1-4 question wizards as searchable overlays or inline
dialogs, with multi-select, freeform answers, and optional comments.

`mcp` provides one OAuth-only remote MCP gateway. It merges
`$FELAN_AGENT_DIR/mcp.json` with `<cwd>/.mcp.json`; the project file has higher
precedence for same-name servers. It does not discover `.pi/mcp.json`, Cursor,
Claude, Codex, or other ambient host configuration. A minimal Felan-owned
config is:

```json
{
  "mcpServers": {
    "notion": {
      "url": "https://mcp.notion.com/mcp",
      "auth": "oauth"
    }
  }
}
```

Servers in the Felan-owned file must explicitly use `auth: "oauth"`. Standard
project entries with `type: "http"` and a URL may omit `auth`; Felan treats
those entries as OAuth. The initial port supports remote HTTP MCP servers
through Streamable HTTP with classified SSE fallback. Unsupported project
entries such as stdio, sockets, bearer tokens, and custom headers are skipped
with a warning rather than executed. Direct tools and MCP Apps are not loaded.
Optional per-server `oauth` fields are `clientId`, `clientSecret`,
`clientSecretEnv`, `scope`, `redirectUri`, `clientName`, `clientUri`, and
`authorizationParams`. Dynamic client registration is used when no client ID
is configured. A client secret or `clientSecretEnv` requires `clientId`;
prefer the environment reference over storing a client secret in the file.
The default callback is `http://127.0.0.1:3118/callback`; set `redirectUri` to
the exact pre-registered loopback callback when using a configured client.

Run `/mcp` to inspect configured servers, list tools, reconnect, authenticate,
or log out. `/mcp auth [server]` opens a server picker when its argument is
omitted. Configuration is loaded at startup;
run `/reload` after editing either file. The model uses the `mcp` gateway tool
for status, explicit reconnects, search, describe, and remote tool calls. A
`disconnected` status only means that the current session has no live transport;
model discovery and call actions reconnect lazily with stored credentials. The
local host follows the upstream adapter's browser + PKCE loopback flow and
stores tokens and dynamic-client
credentials in the OS credential store, bound to the Felan agent directory,
server name, server URL, OAuth client/redirect/scope profile, and
authorization-server issuer. It fails closed when that store is unavailable.
Print-mode subagents never open a browser or callback listener; they can reuse
credentials established by a root TUI session. MCP metadata and results are
bounded and explicitly marked as untrusted remote content.

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

`markitdown` extends ordinary `read` calls for DOC/DOCX, PPT/PPTX, XLS/XLSX,
RTF, EPUB, and Outlook MSG files. It intentionally leaves PDFs, images, audio,
and generic archives to their existing or explicit workflows. Input,
conversion time, and output are
bounded; a content-hash Markdown cache preserves normal offset/limit reads, and
every result marks extracted document text as untrusted. The extension never
downloads Python packages automatically. Run `/markitdown` for status or
`/markitdown install` to explicitly install the managed converter. If the
converter is absent, conversion interception remains disabled.

`backgroundBash` augments `bash` with detached processes for models outside the
`openai` and `openai-codex` providers. Logs and process metadata live under
`$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>/background-bash/<workspace-key>/jobs`.
Use `/background-bash` or `Ctrl+Shift+J` to inspect them. Required POSIX process
utilities are probed through the active runtime; the tools remain inactive on
incompatible runtimes.

`codex` activates `exec_command`, `write_stdin`, `apply_patch`, and
`view_image` for GPT models on the exact `openai` and `openai-codex` providers.
`view_image` is included only for models with image input. It restores the
ordinary coding tools when another model is selected. Root and nested sessions
load the same optional request controls from `$FELAN_AGENT_DIR/codex.json`; see
the extension package README for the three supported fields.

`rtkOptimizer` delegates command rewrites to a managed or `PATH` `rtk`
executable available in the active runtime and compacts noisy command, read,
and grep results. It
supports both ordinary `bash` calls and Codex `exec_command` / `write_stdin`
calls; Codex result envelopes remain intact while only their `Output:` payloads
are compacted. Configuration is shared by root and nested sessions at
`$FELAN_AGENT_DIR/storage/agent/rtk-optimizer/config.json`. Use `/rtk` for
interactive settings, runtime verification, explicit installation, and session
savings metrics. Missing RTK bypasses rewriting without disabling output
compaction.

## System prompt append

The TUI reads one optional `$FELAN_AGENT_DIR/APPEND_SYSTEM.md` file when each
session is constructed (`~/.felan/APPEND_SYSTEM.md` by default). Missing and
blank files add nothing; other read failures stop session construction with the
filesystem error. The file extends Agent Core's Felan prompt after enabled
extension capabilities.

Agent Core also reads at most one instruction file from each session's cwd
through the active `AgentRuntime`, with `AGENTS.md` taking precedence over
`CLAUDE.md`. Missing, unreadable, and blank instruction files are nonfatal.
Child persona instructions follow the application append, root project
instructions follow those consumer appends using Pi's path-labeled context-file
format, and explicit Agent Skills and the current working directory are added
last. The progressive-context extension remains responsible only for instruction
files below the session cwd.

System prompt inputs are limited to Agent Core, enabled capabilities, the
single application append above, the selected cwd instruction file, explicit
Agent Skills, and the current working directory. Pi `SYSTEM.md`, project
`APPEND_SYSTEM.md`, and other Pi-discovered prompt/context files stay outside
local composition.

When enabled, `@felan-ai/ext-subagents` uses the session-bound local host and
provides `Agent`, `list_subagents`,
`get_subagent_result`, `steer_subagent`, and `cancel_subagent`. A root-scoped
local host queues every run asynchronously, persists the latest child session
metadata, delivers completion notices, supports bounded nesting, and uses the
application's current workspace. The TUI shows each queued or running direct
child in a full-width interactive rail beneath the powerline status rows, or
beneath the editor when powerline is disabled. Press Down at the editor's newest
prompt to enter the rail, use Up/Down to select a child, press Up on the first
child to return to the editor, and press Enter to open that child in the agent
navigator. Each child row and the selected-child header show the resolved
provider/model when available. Use `/agents` or `Alt+A` to open the navigator
directly, follow live transcripts with the same tool presentation as the main
agent, send steering messages, or stop active work.
Runtime shutdown awaits active-child cancellation before Pi teardown.
Completed-child continuation uses the same child ID and Pi session file while
replacing the latest result. The default list also
includes `@felan-ai/ext-powerline` for an ANSI-aware footer with subscription
usage; it is a direct TUI dependency and is not part of cloud composition.

Local agent definitions are loaded only from bundled Felan definitions,
`~/.agents/agents/*.md`, `~/.felan/agents/*.md` (or
`$FELAN_AGENT_DIR/agents/*.md`), `<workspace>/.agents/agents/*.md`, and
`<workspace>/.felan/agents/*.md`. Project definitions override user and
bundled definitions; within one scope the Felan-specific directory overrides
the shared `.agents` directory. Pi ambient agent discovery remains disabled.

The bundled definitions have role-specific model settings: `general` inherits the
parent model and thinking for implementation or investigation, `explore` uses the
`low` model tier with thinking `off` for cheap read-only exploration, and `reviewer`
inherits the parent model and thinking for quality-sensitive review. A definition's
`model` and `thinking` settings take precedence over `Agent` arguments. When a
definition omits either setting, the corresponding argument is used; if both omit
it, the parent setting is inherited. A custom definition with id `explore` replaces
the bundled definition and can choose its own settings.

Each definition is a Markdown file with flat `key: value` frontmatter and a
required prompt body. `description` is required; `id` defaults to the filename.
Optional fields are `model`, `thinking`, `max_turns`, `timeout_seconds`, and
`allow_nesting`. Definitions do not change tool access: custom children receive
the normal enabled Felan tools.

```md
---
description: Review changes for correctness and regressions
model: high
thinking: high
max_turns: 20
timeout_seconds: 600
allow_nesting: false
---

Review the requested changes and report findings with file and line references.
```

Local subagent concurrency defaults to four and depth defaults to three; set
`felanSubagents.concurrency` and `felanSubagents.maxDepth` in the Felan settings
file to configure those bounded values.

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
