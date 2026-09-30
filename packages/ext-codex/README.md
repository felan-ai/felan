# @felan-ai/ext-codex

First-party Felan support for the compact structured tool surface used by GPT
coding models. It activates only when the selected model ID is GPT-family and
the provider is exactly `openai` or `openai-codex`.

Active mode keeps ordinary `read`, `bash`, and all unrelated tools, replacing only
`edit` and `write` with `apply_patch`. Switching to another model restores the
ordinary editing tools. File operations use the current `AgentRuntime`.
The local TUI presents patch calls with friendly action labels while headless
modes continue to expose the stable tool name and raw results.

For eligible Responses requests, `extensionConfig.codex.priority` accepts
`normal`, `fast`, or `ultrafast`:

```json
{
  "extensionConfig": {
    "codex": { "priority": "ultrafast" }
  }
}
```

The `fast` boolean is deprecated and hidden from `/settings`; existing config
files and CLI options remain supported. Explicit priority overrides it. Omit `priority` to
retain `fast: true` (priority processing) or `fast: false` (no tier override).
With neither configured, no premium tier is requested. `normal` explicitly
requests the standard `default` tier, even when `fast` is true.

Ultrafast currently applies to the exact `gpt-6-astra` model ID on eligible
OpenAI and Codex Responses routes. Other eligible GPT models fall back to fast
(`priority`). Pi does not expose service-tier capability metadata, so this
model rule is maintained in the extension rather than fetched from a catalog.
Account, plan, workspace and endpoint eligibility still apply; rejected
requests are not automatically retried at another tier.

Fast and Ultrafast consume premium usage. The commonly cited 2x/8x figures
are not universal billing multipliers or guaranteed task-speed increases.
Consult [OpenAI's speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed)
and API pricing for your authentication method. Pi's native cost estimates
do not currently include Ultrafast-specific pricing. Priority selection does
not change the model's reasoning effort or transport.

`postAgentRunCompaction` is enabled by default. It makes eligible GPT runs defer
Pi's automatic threshold compaction until the current agent run settles, which
preserves the pre-0.84.4 timing while allowing the completed tool loop to
finish. Set it to `false` to use Pi's standard timing. Manual and
overflow-recovery compaction remain immediate. Pi still owns summary generation;
this setting does not enable upstream OpenAI native Responses compaction.

For eligible Responses requests, the extension converts Pi's nullable
function-tool `strict` value to `false` so optional arguments remain optional.
Explicit `true` or `false` values, absent values, and non-function tools are
left unchanged.

Pi includes GPT-6 Astra in its built-in OpenAI and OpenAI Codex catalogs.
The existing GPT policy enables this extension's structured tools and native
Responses controls without a custom `models.json` entry.

For GPT-6 Astra, Sol, Luna, and GPT-6.1 Sol using `openai-responses` on `openai`
or `openai-codex-responses` on either eligible provider, changing the thinking
level between turns keeps the initial request-level reasoning effort
and projects a native `configuration_update` before the next user message in
the provider request. Updates are retained across session resume and forks;
after Pi compaction,
the new context establishes its own effort baseline. A queued user follow-up
receives its change before its next response; a tool-only continuation does
not. Changes without another user turn are recorded when the run settles.
These updates require standard, single-agent Responses requests; pro mode,
server-side multi-agent mode, Chat Completions, other GPT models, and Anthropic
are not supported. Automatic server truncation
and compaction cannot be combined with native updates; Pi's existing local
compaction remains available. Actual cache hits also depend on provider cache
eligibility and can be checked using response usage cached-token counts.

Reasoning updates do not change provider transport. `forceCachedWebSockets`
still applies only to `openai-codex` / `openai-codex-responses`; the official
OpenAI API continues to use Pi's native transport.

The extension excludes restart-durable jobs, web access, image generation,
Code Mode/Responses Lite, prompt replacement, native Responses compaction,
voice, and UI widgets.

## Development

```sh
pnpm --filter @felan-ai/ext-codex build
pnpm --filter @felan-ai/ext-codex type-check
pnpm --filter @felan-ai/ext-codex test
```

See [NOTICE](NOTICE) for upstream attribution.

## Package boundary and requirements

Agent Core owns the runtime contract and Pi owns provider transport. This
package owns provider/model eligibility, structured patch replacement, and
request controls; it does not register or replace a provider. File operations
go through the active `AgentRuntime`.

The package requires a compatible `@felan-ai/agent-core` peer, TypeBox, and
Pi-TUI. Host mode remains current-user access and is not a sandbox.

## Related documentation

- [Codex tools configuration](../../docs/user-guide/configuration.md#codex-tools)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)

## Attribution

Selected implementation behavior is adapted from the reviewed
`@howaboua/pi-codex-conversion` sources. See [NOTICE](NOTICE) and
[LICENSE](LICENSE) for source commits and attribution.
