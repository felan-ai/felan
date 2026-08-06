# @felan-ai/ext-codex

First-party Felan support for the compact structured tool surface used by GPT
coding models. It activates only when the selected model ID is GPT-family and
the provider is exactly `openai` or `openai-codex`.

Active mode replaces `read`, `bash`, `edit`, and `write` with
`exec_command`, `write_stdin`, `apply_patch`, and `view_image`. Other Felan
tools remain active. Switching to another model restores the ordinary tools.
All shell and filesystem operations use the current `AgentRuntime`.

Optional settings live at `$FELAN_AGENT_DIR/codex.json`:

```json
{
  "fast": false,
  "verbosity": "low",
  "forceCachedWebSockets": true
}
```

`fast` and `verbosity` modify eligible OpenAI Responses requests through a
session-scoped stream wrapper and the provider-request event. For the OpenAI
Codex provider, `forceCachedWebSockets` upgrades an explicit `websocket`
preference to Pi's native `websocket-cached` transport. Explicit `sse` and
`auto` remain unchanged. Pi owns connection reuse, SSE fallback, cached
continuation, and session cleanup. The extension does not register or replace
providers.

`view_image` is active only when the selected model declares image input. Raw
image reads are limited to 20 MiB, then Pi decodes and resizes supported images
to at most 2000×2000 with a base64 payload below 4 MiB. Malformed,
unsupported, and unresizable images are rejected.

`tty: true` keeps a stdin pipe open for `write_stdin`; it does not allocate an
operating-system PTY or emulate terminal behavior. Process output is decoded
incrementally and terminal control sequences are removed before tool text is
returned to the model.

The extension excludes web access, image generation, Code Mode/Responses
Lite, prompt replacement, compaction, voice, and UI widgets.

## Development

```sh
pnpm --filter @felan-ai/ext-codex build
pnpm --filter @felan-ai/ext-codex type-check
pnpm --filter @felan-ai/ext-codex test
```

See [NOTICE](NOTICE) for upstream attribution.
