# @felan-ai/ext-claude-code

Use Claude models in Felan through Claude Code and your Claude plan login.
Felan keeps the agent loop, conversation, tools, approvals, and user interface.
Claude Code runs as the model transport through Anthropic's Agent SDK; an
in-process MCP server exposes Felan's tools to Claude. The bridge mirrors Felan
history into Claude Code sessions so resumed requests see the same conversation.
No Claude Code companion modification is required.

## Requirements and setup

- A macOS or Linux Felan host. Non-host runtimes and Windows are not supported.
- `npm` on the host's `PATH` for the managed installation.
- Claude Code installed and signed in on that machine with a compatible Claude
  plan. Run `claude`, then `/login`, before using this provider.

In Felan:

1. Run `/claude-code install` and approve the host's installation request. This
   downloads Claude Agent SDK **0.3.293** and its approximately **225 MB
   per-platform binary**. Linux downloads both glibc and musl variants, roughly
   **450 MB** in total. [Anthropic's Agent SDK license and
   terms](https://github.com/anthropics/claude-agent-sdk-typescript) apply; the SDK
   and Claude Code are not bundled with this MIT-licensed package.
2. Start a new session or reload to load the provider.
3. Use `/model claude-code/<model-id>`, for example
   `/model claude-code/claude-opus-4-6`, or select a `claude-code` model in `/model`.
4. Run `/claude-code status` to inspect the SDK version, whether the provider is
   registered in this session, and the resolved plan and long-context settings.

`/claude-code` without arguments also shows status. Unknown arguments show usage.
Installation delegates `{ id: 'claude-code' }` to the optional
`RUNTIME_DEPENDENCIES_SERVICE`; authorization belongs to the trusted local Felan
host. Without that service, status remains available but installation is disabled.
Activation only inspects and loads an existing installation: it never installs
anything, executes `npm`, or downloads files. A missing or unloadable SDK is logged
through the runtime logger and leaves the provider unregistered.

The managed SDK and its pinned dependencies live under
`<agent-storage>/claude-code/agent-sdk-0.3.293`. The generated ESM entry loads both
the Agent SDK and the MCP implementation from that installation. Host providers
can import `inspectClaudeCodeRuntime`, `installManagedClaudeAgentSdk`,
`managedClaudeAgentSdkDirectory`, and `MANAGED_CLAUDE_AGENT_SDK_VERSION` from this
package. The installer helper does not perform authorization itself.

Installation uses a committed, reviewed lockfile with integrity hashes and
`npm ci --ignore-scripts`. Completed installs are verified in staging, including
the host's platform and libc-matched binary, before being moved into place.
A valid installation is never removed or replaced; reinstalling it is a no-op.
npm registry and proxy configuration still applies, but integrity is enforced.
See [Runtime dependencies](../../docs/reference/runtime-dependencies.md#claude-code-managed-runtime).

## Models

Models come from Agent Core's Anthropic catalog. Dated snapshot aliases are
omitted. Model availability still depends on your Claude plan and Claude Code;
a catalog entry is not an entitlement guarantee.

The bridge registers zero API-token prices because it does not use Felan's
Anthropic API credentials. This is not a promise of free usage: Claude plan
limits, Extra Usage, and Anthropic's billing classification still apply. Plan
usage events are forwarded as `anthropic-ratelimit-unified-*` response headers
for compatible footer extensions.

## Settings

Use `/settings`, or edit `extensionConfig["claude-code"]` in
`$FELAN_AGENT_DIR/settings.json`:

```json
{
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

| Setting | Default | Purpose |
| --- | --- | --- |
| `plan` | `"pro"` | `"pro"` or `"max"`; controls plan-gated long-context availability, not authentication. |
| `longContextExtraUsage` | `false` | Enable long-context models that may consume paid Extra Usage. |
| `forceTwoHundredK` | `[]` | Array of model IDs to pin to 200K context; omit `claude-code/` and `[1m]`. |
| `strictMcpConfig` | `true` | Exclude local Claude Code MCP configurations; use Felan's tools. Claude.ai-connected MCP servers are always disabled. |
| `autoMemoryEnabled` | `false` | Enable Claude Code's own auto-memory in addition to Felan's memory. |
| `pathToClaudeCodeExecutable` | unset | Optional absolute path to `claude`, instead of the SDK's bundled binary. |
| `inheritAnthropicEnvironment` | `false` | Preserve exported `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_BASE_URL` in the Claude Code child. By default only these three variables are removed. |

Other Claude Code variables still pass through, including
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
`ANTHROPIC_MODEL`, and `ANTHROPIC_CUSTOM_HEADERS`. They can change authentication,
model selection, or request destination even when `inheritAnthropicEnvironment`
is `false`.

Invalid types, unknown fields, invalid plan values, non-string array entries, and
relative executable paths are rejected. Changes take effect on activation in a
new session or reload. Bridge settings are process-wide: in a shared daemon, the
latest activation supplies settings for subsequent calls.

Long-context support is model-specific. Opus 4.6 uses 1M context on Max or with
Extra Usage; Sonnet 4.6 requires Extra Usage. Other supported 1M models use the
bridge's measured compatibility table. Unknown models default to 200K; use
`forceTwoHundredK` if the requested larger window is unavailable on your account.

## Compatibility and limitations

- Felan tools, tool approvals, and `ask_user` remain in Felan. Claude Code's native
  tools are disabled; Felan tools are exposed through the in-process MCP server.
- Project context, skills, custom and appended instructions, and structured
  `systemPromptOptions.sections` are forwarded. Extensions should use these
  structured sections rather than replace the complete system prompt.
- Felan's harness prompt is not forwarded. The bridge rejects prompts containing
  known Pi harness text rather than silently sending them. Anthropic determines
  whether a request is eligible for plan quota or Extra Usage.
- Compaction, branch summaries, and titles use isolated Claude Code queries.
  Prompt-only, tool-free calls with a single user message and no captured session
  prompt also use isolated queries, including Fusion through Felan's Models
  service. Subagents receive their own Claude Code conversations. The deprecated
  upstream AskClaude tool is not included; use Felan subagents.
- Each Felan session keeps its Claude Code process between prompts and writes
  the next prompt to it. A change of model, thinking level, tools, working
  directory, projected instructions, or bridge settings, or a history rewrite,
  starts a new process that resumes the conversation. The process stops when the
  session shuts down (including daemon idle eviction) or switches to another
  model; an idle process uses roughly 200–260 MB of memory.
- Compaction, tree navigation, aborts, and model switches can require rewriting
  the mirrored history. A rebuild resends history and can miss the prompt cache.
- Mid-session prompt changes may not reach Claude Code until a rebuild. Start a
  new session when updated instructions must take effect immediately.
- Claude Code settings and hooks can affect its subprocess. Review machine-local
  hooks if they duplicate Felan instructions. Enabling inherited Anthropic
  environment variables can redirect requests or change authentication/billing.
- Every Felan session using `claude-code` creates a Claude Code session JSONL
  copy under `~/.claude/projects/<cwd>/` (or
  `$CLAUDE_CONFIG_DIR/projects/<cwd>/`). These copies remain after Felan sessions
  close or are deleted and appear in Claude Code's own `/resume` list. The SDK
  spawns a local process; this host-only bridge is not a sandbox and requires
  access to those files for history mirroring.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` before starting Felan to enable bridge debug output and
per-query Claude Code CLI logs:

- `claude-bridge.log` under the extension's activation `agentDir` records calls,
  history synchronization, tool results, and subprocess stderr.
- `CLAUDE_BRIDGE_DEBUG_PATH` overrides the bridge log path. CLI logs go into
  `cc-cli-logs/` beside that path.
- `claude-bridge-diag.log` under `agentDir` records exceptional invariant failures.

For session-resume errors, inspect the `syncResult:` lines and matching CLI log.
Logs can contain prompts, tool output, and other sensitive data; redact them
before sharing. For authentication errors, run `claude` and `/login` on the host.

## Development

```sh
pnpm --filter @felan-ai/ext-claude-code build
pnpm --filter @felan-ai/ext-claude-code type-check
pnpm --filter @felan-ai/ext-claude-code test
```

Tests use fake SDK entries and isolated storage; they do not require a Claude
login, download the SDK, or spawn Claude Code.

## Attribution

Adapted from MIT-licensed
[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) **0.9.3** by
Eli Dickinson, commit `874fa7c2678456336f23b64e784e2057e608d83e`, originally based
on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by
Prateek Sunal. See [NOTICE](NOTICE) and [LICENSE](LICENSE). Anthropic's Agent SDK
and Claude Code are separately licensed and installed only on explicit request.
