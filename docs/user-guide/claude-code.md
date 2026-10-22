# Claude Code provider

Use Claude models in Felan through Claude Code and your Claude plan login.
Felan keeps the agent loop, tools, approvals, conversation history, and user
interface. Claude Code is the model transport, launched through Anthropic's
Agent SDK. No Claude Code companion mod is needed.

This is separate from the API-key `anthropic` provider. Select
`claude-code/<model-id>` to use the bridge; selecting `anthropic/<model-id>`
continues to use the ordinary Anthropic provider.

## Requirements and setup

- A macOS or Linux Felan host. Windows and non-host runtimes are unsupported.
- `npm` on that host's `PATH` and network access for the managed installation.
- Claude Code installed and signed in on the same machine with a compatible
  Claude plan. In a terminal, run `claude`, then run `/login` inside Claude Code.
  Felan's `/login` does not sign in this provider.

In Felan:

1. Run `/claude-code install` and approve the installation. The managed Agent
   SDK download includes an approximately **225 MB per-platform binary** and is
   subject to [Anthropic's SDK license and terms][sdk]. Linux downloads both
   glibc and musl variants, roughly **450 MB** in total. It is not bundled with
   Felan or installed automatically at startup.
2. Start a new session or use `/reload` to load the provider.
3. Run `/model claude-code/claude-opus-4-6`, or choose an available `claude-code`
   model in `/model`.
4. Run `/claude-code status` to inspect the SDK version, provider registration,
   and plan/long-context settings. `/claude-code` alone also shows status.

Models come from Agent Core's Anthropic catalog, excluding dated snapshot
aliases. A catalog entry does not guarantee access on your account. Models keep
the catalog's API prices, so the session cost in the footer is an
**API-equivalent estimate at list prices, not your bill**. Anthropic's [October 7, 2026 support update][plan-usage] says Agent SDK,
`claude -p`, and third-party apps can still use subscription limits. Plan limits,
Extra Usage, and billing classification remain Anthropic's responsibility;
Felan does not guarantee quota eligibility or savings.

The managed runtime lives at
`<agent-storage>/claude-code/agent-sdk-0.3.293`. See
[Runtime dependencies](../reference/runtime-dependencies.md#claude-code-managed-runtime)
for its pinned packages and installation behavior. Installation requires the
local host's runtime-dependency service; status remains available without it.

## How it works

1. The bridge projects project context, skills, custom/appended instructions,
   and structured prompt sections onto Claude Code's own prompt. It does not
   forward Felan/Pi's coding harness prompt.
2. Claude Code runs with its native tools disabled (`tools: []`). An in-process
   MCP server exposes the active Felan tools. A tool request waits while Felan
   performs its normal validation, approval, execution, and result handling.
3. Felan history remains canonical. The bridge mirrors it into Claude Code
   session JSONL files and resumes that conversation while the histories agree.
   Each Felan session, including a subagent, has its own conversation mirror.
4. Each Felan session keeps its Claude Code process running between prompts,
   so a later prompt skips process startup and session reload. Changing the
   model, thinking level, tools, working directory, projected instructions, or
   bridge settings, or rewriting history (compaction, tree navigation, or an
   abort), starts a new process that resumes the conversation. The process
   stops when the session closes, switches to a non-Claude Code model, or is
   evicted by the daemon after it has been idle with no attached client. An
   idle process uses roughly 200–260 MB of memory.
5. Claude Code auto-compaction is disabled. Felan owns compaction; summary and
   other tool-free one-shot requests use isolated, non-persistent SDK queries.
   Prompt-only, tool-free calls with a single user message and no captured
   session prompt also take this path, including Fusion through Felan's Models
   service.

## Settings

Use `/settings`, or edit `extensionConfig["claude-code"]` in
`$FELAN_AGENT_DIR/settings.json`:

```json
{
  "builtinExtensions": { "claudeCode": true },
  "extensionConfig": {
    "claude-code": {
      "plan": "pro",
      "longContextExtraUsage": false,
      "forceTwoHundredK": [],
      "strictMcpConfig": true,
      "autoMemoryEnabled": false,
      "inheritAnthropicEnvironment": false
    }
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `plan` | `"pro"` | `"pro"` or `"max"`; controls plan-gated context windows, not authentication or your subscription. |
| `longContextExtraUsage` | `false` | Allow long-context model variants that may consume paid Extra Usage. |
| `forceTwoHundredK` | `[]` | Model IDs to limit to 200K context, without `claude-code/` or `[1m]`. |
| `strictMcpConfig` | `true` | Ignore local Claude Code MCP configurations; use Felan's tools. Claude.ai-connected MCP servers are always disabled. |
| `autoMemoryEnabled` | `false` | Enable Claude Code's own auto-memory in addition to Felan memory. |
| `pathToClaudeCodeExecutable` | unset | Optional absolute path to `claude` instead of the SDK-bundled binary. |
| `inheritAnthropicEnvironment` | `false` | Preserve exported `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_BASE_URL` in Claude Code's child environment. Otherwise only those three variables are removed. |

Other Claude Code variables still pass through, including
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
`ANTHROPIC_MODEL`, and `ANTHROPIC_CUSTOM_HEADERS`. They can change authentication,
model selection, or request destination even when `inheritAnthropicEnvironment`
is `false`.

Unknown fields, invalid types, invalid plans, non-string array entries, and
relative executable paths are rejected. Changes apply on a new session or
reload. Bridge settings are process-wide: in a shared daemon, the latest
activation governs subsequent queries. Set `builtinExtensions.claudeCode` to
`false` to disable the built-in.

Long-context availability is model-specific. Opus 4.6 requests 1M context on
Max or with Extra Usage; Sonnet 4.6 requires Extra Usage. Other known models
follow the bridge's compatibility table; unknown models default to 200K. Use
`forceTwoHundredK` when a larger window is unavailable on your account.

## Compatibility and limitations

| Felan feature | Bridge behavior |
| --- | --- |
| Tools, approvals, `ask_user`, MCP, and browser | Remain in Felan's tool pipeline; native Claude Code tools are disabled. |
| Project instructions, skills, output style, tasks, and child instructions | Forwarded through captured prompt components and `systemPromptOptions.sections`; skills respect the active tool set. |
| Compaction, branch summaries, and automatic titles | Tool-free requests run as isolated queries without modifying the main Claude Code conversation. |
| Model Fusion | Prompt-only, tool-free single-user-message participant, comparison, and synthesis calls through Felan's Models service use isolated queries when there is no captured session prompt, not the active conversation. |
| Subagents and Prewalk | Keep Felan's lifecycle and model selection; each child has its own Claude Code conversation. |
| Images and reasoning | Image inputs are preserved; Felan thinking levels map to model-supported Claude effort levels. |
| Powerline | Shows Claude Plan usage from SDK rate-limit events when available; no separate credential fetch. It shows no usage error before the first headers arrive. |

Compaction, tree navigation, aborts, and model switches can force a history
rebuild. Rebuilding resends history and can miss the prompt cache. Frequent
provider handoffs, including Prewalk handoffs, can therefore add latency and
usage. Mid-session instruction changes may not reach an existing Claude Code
conversation until a rebuild; start a new session when they must apply
immediately.

Extensions should add structured prompt sections rather than replace the full
system prompt. Unsupported session prompts or known Pi harness text fail closed
instead of silently losing instructions or forwarding the harness. The
upstream AskClaude tool is not included; use Felan subagents.

## Troubleshooting

- **No `claude-code` models:** check `/claude-code status`, install if missing,
  then start a new session or reload. A missing, incomplete, or unloadable SDK
  leaves the provider unregistered; other providers remain usable.
- **Authentication failure:** on the host running the daemon, run `claude` and
  `/login`, then retry. Keep `inheritAnthropicEnvironment: false` for plan login.
  Restart the daemon if you changed exported environment variables after it
  started. Claude Code settings and credential helpers can also affect auth.
- **Rate limit or Extra Usage rejection:** inspect the reported reset time and
  Claude Plan usage when available. Wait for the window to reset or review your
  plan/Extra Usage settings. Choosing `plan: "max"` does not upgrade an account.
  For an unavailable 1M variant, add the bare model ID to `forceTwoHundredK`.
- **Install failure:** ensure `npm` is available to the host and agent storage
  is writable, then retry `/claude-code install`. Installation uses a reviewed
  lockfile with integrity hashes and `npm ci --ignore-scripts`. Completed installs
  are verified in staging, including pinned versions and the host's platform and
  libc-matched binary, before being moved into place. A valid installation is
  never removed or replaced; reinstalling it is a no-op. npm registry and proxy
  configuration still applies, but integrity is enforced.
- **Resume or prompt-capture failure:** start a fresh session. For diagnosis,
  enable the logs below and inspect `syncResult:` entries with the matching CLI
  log. Do not work around the error by disabling prompt safeguards.

Set debug variables **before starting the daemon**:

| Variable or file | Behavior |
| --- | --- |
| `CLAUDE_BRIDGE_DEBUG=1` | Enables bridge logs and per-query Claude Code CLI logs. |
| `CLAUDE_BRIDGE_DEBUG_PATH` | Overrides the bridge log path; otherwise `claude-bridge.log` is under the extension's activation `agentDir`. CLI logs go in `cc-cli-logs/` beside the bridge log. |
| `CLAUDE_BRIDGE_RECORD_STREAM=<path>` | Appends raw SDK messages as JSONL for main conversation queries; use only for deliberate debugging. |
| `claude-bridge-diag.log` | Records exceptional invariant failures under `agentDir`, even without debug logging enabled. |

## Privacy and host access

Conversation text, projected instructions, images, and tool results go through
Claude Code to the configured service. The SDK spawns local processes;
`cc-session-io` reads and writes a Claude Code session JSONL copy for every Felan
session using `claude-code`, including subagents. Copies live under
`~/.claude/projects/<cwd>/` (or `$CLAUDE_CONFIG_DIR/projects/<cwd>/`), separate
from Felan's canonical history. They are not deleted when Felan sessions close
or are deleted and appear in Claude Code's own `/resume` list. This host-only
integration is not a sandbox.

The bridge suppresses Claude Code's nonessential traffic in its child
environment, but that does not make model requests local or replace Anthropic's
privacy terms. The environment variables described above can change
authentication, destination, and billing even with
`inheritAnthropicEnvironment: false`. Review machine-local Claude Code settings
and hooks; they can still affect the subprocess. Turning off `strictMcpConfig`
admits additional local MCP configuration outside the default Felan-only tool
setup.

Debug logs, diagnostics, raw stream recordings, and Claude Code session files
can contain prompts, tool output, and sensitive project data. Protect them and
redact before sharing. Enabling Claude Code auto-memory creates an additional
memory surface beyond Felan memory.

See the [package README](../../packages/ext-claude-code/README.md) for public
APIs and [upstream tracking](../maintainers/upstream-extensions.md#claude-code-bridge)
for provenance and maintenance.

[sdk]: https://github.com/anthropics/claude-agent-sdk-typescript
[plan-usage]: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
