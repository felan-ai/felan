# Configuration

Felan keeps local configuration under one agent directory. Unless noted
otherwise, paths below are relative to `$FELAN_AGENT_DIR`, which defaults to
`~/.felan`.

## Configuration files

| Path | Purpose |
| --- | --- |
| `settings.json` | Built-in enablement, extension configuration, local TUI behavior, model scope, and subagent limits |
| `APPEND_SYSTEM.md` | Optional local application prompt append |
| `mcp.json` | Felan-owned remote OAuth MCP servers |
| `<workspace>/.mcp.json` | Project MCP entries; higher precedence by server name |
| `agents/*.md` | Felan-specific user agent definitions |

The local host does not read Pi project settings. Configuration for ambient Pi
extensions, prompts, packages, themes, or skills is filtered.

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
    "markitdown": true,
    "context": true,
    "memory": true,
    "outputStyle": true,
    "powerline": false
  },
  "extensionConfig": {
    "prewalk": { "entryApproval": "allow", "planReview": "skip" },
    "outputStyle": { "style": "concise" },
    "codex": { "fast": false, "verbosity": "low", "forceCachedWebSockets": true }
  },
  "felanSubagents": {
    "concurrency": 4,
    "maxDepth": 3
  },
  "felanTui": {
    "toolDisplay": "grouped",
    "memoryProcessing": true
  }
}
```

Defaults:

- every built-in is enabled;
- response output style is `concise`;
- subagent concurrency is `4` and maximum nesting depth is `3`;
- tool display is `grouped`; and
- local memory processing is enabled.

The dependency manager also stores onboarding decisions under `felanTui`.
Prefer `/dependencies` over editing that internal state directly.

## Application prompt append

`APPEND_SYSTEM.md` extends the Felan base prompt for every local session. It is
read when a session is constructed. A missing or blank file adds nothing; an
unexpected read error stops session construction.

Project `APPEND_SYSTEM.md`, Pi `SYSTEM.md`, and other ambient prompt files are
not loaded. Use project instructions for repository-specific guidance instead.

## Project instructions and skills

At startup Agent Core reads at most one instruction file in the session cwd:

1. `AGENTS.md`
2. `CLAUDE.md`

The progressive-context extension discovers the same filenames below the cwd
when Felan reads files in nested directories. See [Context and memory](context-and-memory.md).

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

Invalid persisted extension fields do not block local startup. Felan reports a
warning, ignores each invalid field, and uses that field's declared default;
other valid fields in the same extension remain active. Invalid CLI and
programmatic overrides remain errors. Felan does not rewrite invalid persisted
values automatically.

### Output style

The `extensionConfig.outputStyle.style` setting accepts `concise`,
`explanatory`, `caveman`, or `custom`. `concise` is the default. `caveman` uses fragments,
compact bullets, and minimal prose, but expands automatically for errors,
security warnings, destructive actions, blockers, and complex plans. Code,
commands, paths, identifiers, numbers, and error messages remain exact, and
required caveats and verification results are not omitted. The output-style
extension appends the selected instructions as a bounded `## Output Style`
section for root and child sessions.

Use `custom` to test arbitrary system-prompt instructions without changing the
extension source:

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

`instructions` must be a non-empty string when `style` is `custom`. Felan does
not load instruction files or ambient prompt resources; callers must pass the
text explicitly.

The same value can be selected from the CLI with `--output-style caveman` or
from the interactive `/settings` screen. Custom text is available through
`--output-style-instructions` or the corresponding `/settings` field.

The local host captures the selection when it creates a session runtime, so
restart Felan after changing it. Set `builtinExtensions.outputStyle` to `false`
to disable the extension.

### Codex tools

`extensionConfig.codex` accepts exactly three fields:

```json
{
  "fast": false,
  "verbosity": "low",
  "forceCachedWebSockets": true
}
```

`verbosity` may be `low`, `medium`, or `high`. These controls apply only to
eligible GPT models on the exact `openai` or `openai-codex` provider.

### Web access

`extensionConfig.webAccess` configures OpenAI, Exa, Brave, and self-hosted
SearXNG search, plus PDF, repository clone, domain, and SSRF policy. Credential
fields preserve literal values, `$NAME`/`${NAME}` environment references, and
trusted `!command` sources; sensitive values are redacted in `/settings` and
are not exposed as CLI options. See [Web, MCP, browser, and documents](web-mcp-and-browser.md).

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
  "theme": "custom",
  "style": "powerline",
  "charset": "text",
  "colorCompatibility": "truecolor",
  "autoWrap": true,
  "padding": 1,
  "colors": {
    "directory": { "fg": "#ffffff", "bg": "#1d4ed8" }
  },
  "lines": [
    { "segments": { "directory": { "enabled": true, "style": "fish" } } }
  ]
}
```

`lines` contains ordered display lines. Each line contains supported
`directory`, `git`, `model`, `session`, `subscription`, `savings`, `context`, and
`status` segments with their documented segment fields. The default layout adds
`{ "savings": { "enabled": true, "align": "right", "periodDays": 7 } }` after
Git on the first line. It shows all retained local savings for seven inclusive
UTC calendar days as `Est. Savings(7d): $33.00`; set `periodDays` to a positive
integer from 1 to 3650 for a different period. A `~` before the amount indicates
incomplete pricing coverage.
`colors` accepts custom named
`#RRGGBB` foreground/background pairs. `felan` is the default built-in theme;
select `custom` to apply the `colors` palette. Changes take effect in a newly
constructed process/session. The built-in is enabled by default; set
`builtinExtensions.powerline` to `false` to remove it.

### Extension configuration

Every enabled configurable extension declares typed settings. Felan exposes the
same declarations through `settings.json`, generated CLI options, `/settings`,
and the Agent Core programmatic API. Values are validated before activation;
unknown extension or field names are errors. `/settings` first lists Pi settings
and configurable extensions; select an extension to view its fields. Type to
fuzzy-search either list; activating a field with declared options cycles them.

### RTK

Use `/settings` to edit `extensionConfig.rtkOptimizer`. `/rtk` shows operational
status, verifies availability, and installs the reviewed executable. `/savings`
reports Felan's savings. Command rewriting needs the reviewed `rtk` executable;
binary-independent output compaction does not. Felan's post-tool metrics include
command, read, grep, and Codex result compaction (including non-RTK compaction),
and RTK command-output savings are reported separately from Felan's post-tool
compaction. Felan uses one isolated temporary RTK tracker per root session and
model, queries each tracker during session shutdown, and never imports RTK's
global history or exposes `rtk gain`. Active-session `/savings` may not yet include
unflushed RTK command-output savings.
Large lossy results use a recoverable head-and-tail preview; failed results and
complete JSON payloads are protected from false-success or mid-document cuts.

## Secrets

Use `/login` to add model credentials and `/logout` to remove them. Use `/mcp`
for remote MCP OAuth credentials.
The local MCP host stores OAuth tokens in the OS credential store and fails
closed when secure storage is unavailable. Prefer environment references over
literal client secrets when an MCP server requires a registered client.

Never commit `$FELAN_AGENT_DIR`, credential files, or private provider keys.
