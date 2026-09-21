# Configuration

Felan Code keeps local configuration under one agent directory. Unless noted
otherwise, paths below are relative to `$FELAN_AGENT_DIR`, which defaults to
`~/.felan`.

## Configuration files

| Path | Purpose |
| --- | --- |
| `settings.json` | Built-in enablement, extension configuration, local TUI behavior, model scope, and subagent limits |
| `trust.json` | Remembered folder trust for optional project Pi extensions |
| `models.json` | Pi provider credentials, custom models, and model metadata overrides |
| `APPEND_SYSTEM.md` | Optional local application prompt append |
| `mcp.json` | Felan-owned remote OAuth MCP servers |
| `<workspace>/.mcp.json` | Project MCP entries; higher precedence by server name |
| `agents/*.md` | Felan-specific user agent definitions |
| `themes/*.json` | User Pi themes; same JSON `name` as `felan-light` or `felan-dark` shadows the packaged theme |

The local host does not read Pi project settings. Configuration for ambient Pi
extensions, prompts, packages, themes, or skills is filtered by default. Load a
local Pi extension explicitly for the interactive root TUI with repeatable
`--extension`/`-e` flags, or opt in to Pi's standard directories with
`piExtensions` as described below. Neither path installs network or package
sources.

## Settings

All built-ins are enabled unless their key is explicitly `false`. The example
below shows available Felan-specific settings and intentionally disables the
browser and Powerline extensions:

```json
{
  "builtinExtensions": {
    "subagents": true,
    "askUser": true,
    "tasks": true,
    "prewalk": true,
    "mcp": true,
    "felanApi": true,
    "webAccess": true,
    "browser": false,
    "backgroundBash": true,
    "codex": true,
    "rtkOptimizer": true,
    "codebaseMemory": true,
    "markitdown": true,
    "context": true,
    "contextView": true,
    "insights": true,
    "promptHistory": true,
    "memory": true,
    "sessionCompaction": true,
    "outputStyle": true,
    "powerline": false,
    "sessionTitle": true
  },
  "extensionConfig": {
    "prewalk": { "entryApproval": "allow", "planReview": "skip" },
    "outputStyle": { "style": "concise" },
    "tasks": { "displayMode": "inline" },
    "contextView": { "displayMode": "inline" },
    "codebaseMemory": { "maxCacheBytes": 0 },
    "promptHistory": { "displayMode": "inline" },
    "codex": { "fast": false, "verbosity": "low", "forceCachedWebSockets": true, "postAgentRunCompaction": true },
    "sessionCompaction": { "method": "classifier", "model": "inherit" }
  },
  "felanSubagents": {
    "concurrency": 4,
    "maxDepth": 3
  },
  "felanTui": {
    "toolDisplay": "grouped"
  },
  "piExtensions": {
    "user": false,
    "project": false
  },
  "editorPaddingX": 1,
  "tuiMode": "fullscreen"
}
```

Defaults:

- every built-in is enabled;
- memory processing follows `builtinExtensions.memory` and changes apply when
  Felan Code next constructs a root session;
- response output style is `concise`;
- subagent concurrency is `4` and maximum nesting depth is `3`;
- editor horizontal padding is `1`;
- tool display is `grouped`;
- local memory processing is enabled; and
- `piExtensions.user` and `piExtensions.project` are `false`.

When `piExtensions.user` is `true`, interactive root TUI sessions load
`~/.pi/agent/extensions`. When `piExtensions.project` is `true`, they load
`<cwd>/.pi/extensions` only after a Felan folder-trust decision stored in
`$FELAN_AGENT_DIR/trust.json`. A new folder with project extensions asks once;
parent-folder decisions apply. Trusting a folder authorizes those extension
files only. It does not load Pi project settings, packages, skills, prompts, or
themes. These directories are not loaded in headless, ACP, or subagent sessions.
`--extension`/`-e` remains additive.

`builtinExtensions.sessionTitle` controls automatic names for interactive root
sessions. Disable it to keep the first prompt as the session-picker fallback.

When no saved or resumed model is usable, Felan Code selects from its own
curated provider defaults instead of Pi's defaults. Both `openai` and
`openai-codex` currently use `gpt-5.6-sol`. A successful first login selects
and saves that provider's Felan default only when the session does not already
have an active model. In `/model`, Enter saves the highlighted model as the
default for future sessions; Ctrl+S changes only the current session.

`builtinExtensions.sessionCompaction` controls verified session compaction and
active-lineage `session_recall`. It is enabled by default. Disable it to use
Pi's native compactor and remove the recall tool. `extensionConfig.sessionCompaction.method`
defaults to `classifier` and retains a selective transcript when
`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` makes a runtime classifier available.
Without that capability it uses the verified summary method automatically. Set
the method to `summary` to disable classifier compaction even when a classifier
is available. Classifier mode sends bounded compaction evidence to the selected
TypeSafe or OpenRouter endpoint and does not make a summary-model request.
`FELAN_LOG_LEVEL` controls the host logger (default `debug`); session-compaction
and subagent-routing classifier traces go to
`storage('agent')/logs/felan.jsonl`. Subagent routing records the generated
guidance and scored/selected agent IDs, but not the request or conversation
state. Summary mode makes one additional active-model
request when compaction runs. `extensionConfig.sessionCompaction.model` defaults
to `inherit`, which uses the active session model. It also accepts `xhigh`,
`high`, `medium`, and `low`; each selects an exact tier from the allowed session
catalog, preferring the active provider/family before crossing providers. If no
model exists in the requested tier, compaction falls back to `inherit`. The
setting is also available in `/settings` and as
`--session-compaction-model <inherit|xhigh|high|medium|low>`, and applies to a
newly constructed runtime. Generation or validation failures before Pi
accepts a replacement fall through to native compaction; a failure after Pi
accepts a replacement cannot automatically rerun native compaction. Every
recoverable fallback warns that Pi native compaction will take over and writes
one bounded metadata-only diagnostic custom entry. The diagnostic is not shown,
sent to the model, or returned by `session_recall`; it records delegation rather
than native success. User cancellation is not reported as fallback.

New installations use Pi's `fullscreen` TUI mode and editor padding `1`.
Existing `tuiMode` and `editorPaddingX` values in `settings.json` remain
authoritative, so `regular` mode and zero padding continue to work. Change
either value from `/settings`; the choice is saved for future sessions. Felan Code
uses Pi's native prompt editor frame rather than adding a second box around it.
On Windows, fullscreen mode also normalizes terminal mouse modes so supported
terminals send wheel events to the transcript instead of treating them as
prompt-editor arrow keys. If a terminal or PTY does not pass mouse reports
through, use `PageUp`/`PageDown` or switch to `regular` mode.

The dependency manager stores its revisioned onboarding manifest under
`felanTui.onboarding`. It is internal state; prefer `/dependencies` over editing
it directly. During interactive startup, missing managed installers appear in
one initially unchecked checklist; checking an item authorizes installation and
unchecked items use their safe fallback. Escape leaves the current pass pending.
Available and non-installable dependencies resolve without another prompt. A
complete manifest prevents the onboarding manager from probing external
dependencies during normal startup. The full resource view reports extensions as
enabled, disabled, or setup required without probing them.

## Application prompt append

`APPEND_SYSTEM.md` extends the Felan base prompt for every local session. It is
read when a session is constructed. A missing or blank file adds nothing; an
unexpected read error stops session construction.

Project `APPEND_SYSTEM.md`, Pi `SYSTEM.md`, and other ambient prompt files are
not loaded. Use project instructions for repository-specific guidance instead.

### Classifier-guided subagents

When `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` is available, the local host
injects its optional provider-neutral classifier into root and child runtimes.
The subagent extension then evaluates the full current prompt, active
model-visible user/assistant conversation text, complete catalog definitions,
and direct-child statuses before each user turn. It scores every catalog
definition once for suitability, considering useful investigation/exploration,
parallelizable or specialist implementation, and independent review internally.
Before the model starts each user turn, it appends a request-specific routing
decision to that turn's system prompt. Entries scoring at or above 0.65 appear
with their full descriptions. The decision requires one concrete,
non-overlapping `Agent` task for every listed `subagent_type` when its work
becomes ready; an empty list keeps the request in the parent. No agent is
launched automatically. The decision is persisted as a structured system
message but not shown in the TUI. Direct system entries are excluded from later
classifier conversation extraction, and the structured routing log retains the
generated guidance.

The classifier state may leave the local process for the configured TypeSafe or
OpenRouter endpoint. It contains prompt/session text and agent metadata, but not
credentials. When classification succeeds, generic delegation and lifecycle
guidance remains persistently in the system prompt, while the full descriptive
catalog is omitted; valid type IDs remain in the `Agent` tool schema. If no
classifier is available, the persistent generic guidance includes the complete
catalog. If evaluation fails, a system-prompt fallback decision supplies that
catalog and applies the generic delegation policy without blocking the request.

## Project instructions and skills

At startup Agent Core reads at most one instruction file in the session cwd:

1. `AGENTS.md`
2. `CLAUDE.md`

The progressive-context extension discovers the same filenames below the cwd
when Felan Code reads files in nested directories. See [Context and memory](context-and-memory.md).

Agent Skills are loaded only from:

- `~/.agents/skills`
- `<workspace>/.agents/skills`

## Agent definitions

Definitions are loaded from these locations, with project definitions taking
precedence over user definitions and Felan-specific directories taking
precedence over shared `.agents` directories in the same scope:

```text
~/.agents/agents/*.md
$FELAN_AGENT_DIR/agents/*.md
<workspace>/.agents/agents/*.md
<workspace>/.felan/agents/*.md
```

See [Agents, tasks, and Prewalk](agents-tasks-and-prewalk.md) for the definition
format and model-selection behavior.

## Feature-specific configuration

### Browser authorization

`extensionConfig.browser.authorizationPolicy` controls Felan's local consent
prompt when reusing an existing authenticated Chrome session. It defaults to
`ask`, whose prompt offers Allow once, Always allow, or Deny. Set it to
`always-allow` to skip Felan's repeated prompt. Authorization grants the native
browser command surface, while Felan still owns routing, output bounds, lease
lifecycles, and host setup commands. Set it back to `ask` in `/settings` or with
`--browser-authorization-policy ask` to restore the default behavior. The
preference is global to `$FELAN_AGENT_DIR`; live grants and CDP connection
material are never persisted. Explicit CLI and programmatic overrides take
precedence for the runtime.

### Prewalk

Model-called `enter_prewalk` uses the resolved `extensionConfig.prewalk`
settings. A dialog-capable host asks when configured `ask`; JSON and print modes
deny the request instead of waiting for input. Explicit `/prewalk` is already
user intent and bypasses this gate. The local `/settings` screen edits these
values and persists them to `settings.json`.

`entryApproval` accepts `ask`, `allow`, or `deny`. `planReview` accepts
`inherit`, `ask`, or `skip`: `inherit` asks when `entryApproval` is `ask` and
skips otherwise. The example above uses the unattended policy explicitly, so
model entry is allowed and plan review is skipped.

CLI options are generated from enabled extension declarations. For example:

```ts
felan --prewalk-entry-approval allow --prewalk-plan-review skip
```

The precedence is defaults, then `settings.json`, then CLI invocation values.
Agent Core consumers can supply a final programmatic override with
`configureExtension()` and `extensionConfigOverrides`.

Invalid persisted extension fields do not block local startup. Felan Code reports a
warning, ignores each invalid field, and uses that field's declared default;
other valid fields in the same extension remain active. Invalid CLI and
programmatic overrides remain errors. Felan Code does not rewrite invalid persisted
values automatically.

### Tasks

The `extensionConfig.tasks.displayMode` setting controls `/tasks` and
`Ctrl+Shift+T`. It defaults to `inline`, which replaces the current content with
the task list until it is closed. Set it to `overlay` for a centered popup. The
view includes list, detail, and dependency-graph modes; details show both
prerequisites and dependents with their current availability and titles.

The setting is also available in `/settings` and as the generated
`--tasks-display-mode` CLI option. It takes effect in a newly constructed
runtime. Inline output uses two horizontal separators; overlay output uses a
complete four-edge frame.

### Context View

The `extensionConfig.contextView.displayMode` setting controls `/context` in
the interactive TUI. It defaults to `inline`, which replaces the current
content with the report until it is closed. Set it to `overlay` for a centered
popup. Headless modes always emit the compact report as text output.
Inline output uses two horizontal separators; overlay output uses a complete
four-edge frame.

The report attributes the initial memory `summary.md`, `index.md`, and schema
to Memory, along with identifiable reads from the session memory projection;
ordinary conversation messages remain under Messages.

### Prompt History

The `extensionConfig.promptHistory.displayMode` setting controls the prompt
history picker opened by `Ctrl+R` or `Cmd+R`. It defaults to `inline`; set it to
`overlay` for a centered popup. Prompt history is TUI-only. The local host reads
only bounded, read-only session files from its configured session store; older
prompts may be unavailable when a session file exceeds the scan limit.
Inline output uses two horizontal separators; overlay output uses a complete
four-edge frame.

### Ask User

The `extensionConfig.askUser` settings control the local question presentation:

```json
{
  "extensionConfig": {
    "askUser": {
      "displayMode": "inline",
      "singleSelectLayout": "auto",
      "overlayToggleKey": "alt+o",
      "commentToggleKey": "ctrl+g"
    }
  }
}
```

The defaults are `inline`, `auto`, `alt+o`, and `ctrl+g`. Set `displayMode` to
`overlay` for a centered popup, or set `singleSelectLayout` to `list` to hide
the wide-terminal details pane. Inline output uses two horizontal separators; overlay
output uses a complete four-edge frame. The shortcut fields accept a key or chord;
`off`, `none`, `disabled`, or an empty value disables a shortcut. Per-call
`ask_user` values override these defaults. The same fields are available in
`/settings` and as generated `--ask-user-*` CLI options.

### Output style

The `extensionConfig.outputStyle.style` setting accepts `concise`,
`explanatory`, or `custom`. `concise` is the default. It uses short sentences,
clear fragments, compact bullets, standard abbreviations, and minimal prose,
but expands when compression could cause ambiguity around errors, security,
destructive actions, blockers, limitations, recovery, tradeoffs, or complex
plans. Technical terms, code, commands, paths, identifiers, API names, numbers,
units, and exact error messages remain unchanged. Negation, conditions, scope,
exceptions, caveats, verification results, and blockers are not omitted. The
output-style extension appends the selected instructions as a bounded
`## Output Style` section for root and child sessions.

Use `custom` to supply arbitrary system-prompt instructions without changing the
extension source. Provide exactly one of inline `instructions` or
`instructionsFile`:

```json
{
  "extensionConfig": {
    "outputStyle": {
      "style": "custom",
      "instructions": "Respond tersely. Keep all technical details and blockers."
    }
  }
}
```

```json
{
  "extensionConfig": {
    "outputStyle": {
      "style": "custom",
      "instructionsFile": "output-style.md"
    }
  }
}
```

Relative `instructionsFile` paths resolve from `$FELAN_AGENT_DIR`. Absolute paths
are used as written. Paths starting with `~/` expand to the current home
directory. The local host reads the file when it binds the extension for root
and child sessions; empty, missing, or unreadable files are errors. Setting both
`instructions` and `instructionsFile` is an error.

The same value can be selected from the CLI with `--output-style concise` or
from the interactive `/settings` screen. Custom text is available through
`--output-style-instructions` or the corresponding `/settings` field. Custom
files are available through `--output-style-instructions-file` or the
`instructionsFile` `/settings` field.

The former `caveman` value has been replaced by `concise`. Existing
configurations should change either legacy `"outputStyle": "caveman"` or
`extensionConfig.outputStyle.style: caveman` to `concise`. Invalid persisted
namespaced values produce a warning and use the concise default; invalid CLI
or programmatic values are errors. Felan Code does not retain `caveman` as an alias.

The local host captures the selection and instruction-file contents when it
creates a session runtime, so restart Felan Code after changing the style or the
file. Set `builtinExtensions.outputStyle` to `false` to disable the extension.

### Codex tools

`extensionConfig.codex` accepts these fields:

```json
{
  "fast": false,
  "verbosity": "low",
  "forceCachedWebSockets": true,
  "postAgentRunCompaction": true
}
```

`verbosity` may be `low`, `medium`, or `high`. These controls apply only to
eligible GPT models on the exact `openai` or `openai-codex` provider.
`postAgentRunCompaction` defaults to `true`, making automatic threshold
compaction wait until the active GPT run settles and preserving the pre-0.84.4
timing. Set it to `false` to use Pi's standard timing. Manual and
overflow-recovery compaction are unchanged. Pi continues to generate the
compaction summary; this is not OpenAI native Responses compaction.

GPT models keep Felan Code's ordinary `read` and `bash` tools. Codex mode replaces
only `edit` and `write` with `apply_patch`; process sessions and image reading
are not provider-specific.

### Background processes

`extensionConfig.backgroundBash.foregroundTimeoutSeconds` controls how long a
foreground `bash` call waits before promoting the same process to a Background
process. It defaults to `120`; `0` promotes immediately. `tty: true` starts a PTY,
and `write_background_bash` sends exact input/control bytes. Detached jobs remain
restart-discoverable when session storage persists; live PTYs end with the root
session.

### Web access

`extensionConfig.webAccess` exposes provider selection, OpenAI/Exa/Brave
credential sources, the OpenAI search model, SearXNG endpoint and sensitive
headers, PDF size limit, `fetchContent.domainPolicy`, and
`ssrf.allowRanges`. Credential sources and SearXNG headers are redacted in
settings presentation. The removed `githubClone` field is not available.

Search provider requests can consume quotas or incur provider charges,
especially with `all` or an array. Use `web_search` for discovery, then pass
selected URLs to `fetch_content`. See
[Web, MCP, browser, and documents](web-mcp-and-browser.md) for the full schema,
limits, and migration guidance.

### MCP

`mcp.json` is global to the agent directory. `<workspace>/.mcp.json` overrides
same-name global servers. The local host accepts remote HTTP OAuth servers only;
unsupported stdio, socket, bearer-token, and custom-header entries are skipped.

### Felan API

The `felanApi` built-in registers the single `felan_api` gateway only when
`FELAN_API_KEY` is set. Set `builtinExtensions.felanApi` to `false` to disable
it. The gateway uses `FELAN_API_URL` when set, otherwise the production Felan
API, `FELAN_DOCS_URL` for the optional public documentation target, and
`FELAN_TEAM_SLUG` as guidance for team-scoped paths. It keeps responses bounded
and marked as untrusted. A managed host can compose
`@felan-ai/ext-felan-api` with explicit `apiKey` and `teamSlug` values instead
of using the environment.

### Powerline

All Powerline configuration lives under `extensionConfig.powerline` in
`settings.json`, through `/settings`, or through the generated scalar CLI
options. The complete shape is:

```json
{
  "style": "powerline",
  "charset": "text",
  "autoWrap": true,
  "padding": 1,
  "lines": [
    { "segments": { "directory": { "enabled": true, "style": "fish" } } }
  ]
}
```

`lines` contains ordered display lines. Each line contains supported
`directory`, `git`, `model`, `session`, `subscription`, `savings`, `context`, and
`status` segments with their documented segment fields. The default layout adds
`{ "savings": { "enabled": true, "align": "right", "periodDays": 7 } }` after
Git on the first line. It shows estimated API-equivalent savings across all
retained local measurements for seven inclusive UTC calendar days as
`Est. Savings(7d): $33.00`; set `periodDays` to a positive integer from 1 to
3650 for a different period. A `~` before the amount indicates incomplete
pricing coverage.
Powerline inherits the active Pi theme and maps its semantic segment roles to
Pi foreground/background tokens. There is no second Powerline palette or
color mode. Felan Code supplies `felan-light` and `felan-dark` and defaults to
`felan-light/felan-dark` when no Pi theme is saved. User JSON in `themes/` can
shadow those IDs by name. Auto light/dark follows the terminal background
(OSC 11), not the OS color-scheme (CSI 997). Changes take effect in a newly
constructed process/session. The built-in is enabled by default; set
`builtinExtensions.powerline` to `false` to remove it.

Felan Code keeps its theme IDs namespaced instead of replacing Pi's `dark` and
`light`: Pi 0.86.1 gives its built-in IDs precedence during HTML export. The
interactive startup view is compact by default; press `Ctrl+O` to show full
startup help and loaded resources.

### Extension configuration

Every enabled configurable extension declares typed settings. Felan Code exposes the
same declarations through `settings.json`, generated CLI options, `/settings`,
and the Agent Core programmatic API. Values are validated before activation;
unknown extension or field names are errors. `/settings` first lists Pi settings
and configurable extensions; select an extension to view its fields. Type to
fuzzy-search either list; activating a field with declared options cycles them.

### RTK

Use `/settings` to edit `extensionConfig.rtkOptimizer`. `/rtk` shows operational
status, verifies availability, and installs the reviewed executable. `/savings`
reports Felan Code's estimated API-equivalent savings. Command rewriting needs the
reviewed `rtk` executable;
binary-independent output compaction does not. Felan Code's post-tool metrics include
command, read, grep, and Codex result compaction (including non-RTK compaction),
and RTK command-output savings are reported separately from Felan Code's post-tool
compaction. Felan Code uses one isolated temporary RTK tracker per root session and
model, queries each tracker during session shutdown, and never imports RTK's
global history or exposes `rtk gain`. Active-session `/savings` may not yet include
unflushed RTK command-output savings. These are API-equivalent estimates, not
provider billing; see [Efficient execution and savings](../concepts/efficient-execution.md).
Large lossy results use a recoverable head-and-tail preview; failed results and
complete JSON payloads are protected from false-success or mid-document cuts.

### Codebase Memory

`extensionConfig.codebaseMemory.maxCacheBytes` is a non-negative integer. The
default `0` selects the runtime policy: 2 GiB for the local host and 500 MiB for
Docker or Daytona. A positive value overrides that limit. Codebase Memory uses
agent-scoped cache storage on the local host and session-scoped storage in
cloud workspaces, starts one background index without delaying session startup,
and refreshes only after `/codebase-memory refresh` or a model
`index_repository` request; it does not watch files. Set the optional
`extensionConfig.codebaseMemory.autoIndexPath` to an absolute directory when a
host should index an aggregate such as `/work/repos` instead of its Git root.
Daemon coordination is derived from the agent-storage root and uses a bounded
owner-private temporary path on POSIX so Unix socket paths remain portable. The
exact reviewed 0.10.8 executable is required. Use `/dependencies` or
`/codebase-memory install` for an explicit local install.
Known fatal daemon-coordination failures are recovered by participating current
sessions through a bounded graceful daemon stop and one index retry. Restart
Felan Code once after upgrading so existing sessions load this recovery behavior.

## Secrets

Use `/login` to add model credentials and `/logout` to remove them. Use `/mcp`
for remote MCP OAuth credentials.
The local MCP host stores OAuth tokens in the OS credential store and fails
closed when secure storage is unavailable. Prefer environment references over
literal client secrets when an MCP server requires a registered client.

Never commit `$FELAN_AGENT_DIR`, credential files, or private provider keys.
