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

`fast` and `verbosity` modify eligible OpenAI Responses payloads. For the
OpenAI Codex provider, `forceCachedWebSockets` upgrades an explicit
`websocket` preference to Pi's native `websocket-cached` transport. Explicit
`sse` and `auto` remain unchanged. Pi owns connection reuse, SSE fallback,
cached continuation, and session cleanup. Cached transports are prewarmed once
per session and model with a native `generate: false` request before the first
real stream.

The extension excludes web access, image generation, Code Mode/Responses
Lite, prompt replacement, compaction, voice, custom tools, and UI controls.

## Development

```sh
pnpm --filter @felan-ai/ext-codex build
pnpm --filter @felan-ai/ext-codex type-check
pnpm --filter @felan-ai/ext-codex test
```

See [NOTICE](NOTICE) for upstream attribution.
