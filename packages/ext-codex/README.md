# @felan-ai/ext-codex

First-party Felan support for the compact structured tool surface used by GPT
coding models. It activates only when the selected model ID is GPT-family and
the provider is exactly `openai` or `openai-codex`.

Active mode keeps ordinary `read`, `bash`, and all unrelated tools, replacing only
`edit` and `write` with `apply_patch`. Switching to another model restores the
ordinary editing tools. File operations use the current `AgentRuntime`.
The local TUI presents patch calls with friendly action labels while headless
modes continue to expose the stable tool name and raw results.

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

Pi 0.85.1 includes GPT-6 Astra in its built-in OpenAI and OpenAI Codex catalogs.
The existing GPT policy enables this extension's structured tools and native
Responses controls without a custom `models.json` entry.

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
