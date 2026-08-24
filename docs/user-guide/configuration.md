# Configuration

Felan keeps local configuration under one agent directory. Unless noted
otherwise, paths below are relative to `$FELAN_AGENT_DIR`, which defaults to
`~/.felan`.

## Configuration files

| Path | Purpose |
| --- | --- |
| `settings.json` | Built-in enablement, output style, local TUI behavior, model scope, and subagent limits |
| `APPEND_SYSTEM.md` | Optional local application prompt append |
| `mcp.json` | Felan-owned remote OAuth MCP servers |
| `<workspace>/.mcp.json` | Project MCP entries; higher precedence by server name |
| `web-search.json` | Web provider credentials, selection, fetch policy, and limits |
| `codex.json` | GPT/OpenAI request controls |
| `powerline.json` | Footer layout, segments, themes, and colors |
| `agents/*.md` | Felan-specific user agent definitions |
| `storage/agent/rtk-optimizer/config.json` | RTK rewrite and compaction settings |

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
  "outputStyle": "concise",
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

### Output style

The top-level `outputStyle` setting accepts `concise` or `explanatory`.
`concise` is the default. The output-style extension appends the selected,
built-in instructions as a bounded `## Output Style` section for root and child
sessions; it does not load arbitrary prompt text or ambient files.

Invalid values stop session construction with a settings error. The local host
captures the selection when it creates a session runtime, so restart Felan
after changing it. Set `builtinExtensions.outputStyle` to `false` to disable
the extension.

### Codex tools

`codex.json` accepts exactly three fields:

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

`web-search.json` configures OpenAI, Exa, Brave, and self-hosted SearXNG search,
plus PDF, repository clone, domain, and SSRF policy. Keep API keys outside
project files. See [Web, MCP, browser, and documents](web-mcp-and-browser.md).

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

`powerline.json` is read when the extension initializes. Changes take effect in
a newly constructed process/session. The built-in is enabled by default; set
`builtinExtensions.powerline` to `false` to remove it.

### RTK

Use `/rtk` for interactive settings or `/rtk path` to print its agent-scoped
configuration location. Command rewriting needs the reviewed `rtk` executable;
binary-independent output compaction does not.

## Secrets

Use `/login` to add model credentials and `/logout` to remove them. Use `/mcp`
for remote MCP OAuth credentials.
The local MCP host stores OAuth tokens in the OS credential store and fails
closed when secure storage is unavailable. Prefer environment references over
literal client secrets when an MCP server requires a registered client.

Never commit `$FELAN_AGENT_DIR`, credential files, or private provider keys.
