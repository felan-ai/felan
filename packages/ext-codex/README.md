# @felan-ai/ext-codex

First-party Felan support for the compact structured tool surface used by GPT
coding models. It activates only when the selected model ID is GPT-family and
the provider is exactly `openai` or `openai-codex`.

Active mode replaces `read`, `bash`, `edit`, and `write` with
`exec_command`, `write_stdin`, and `apply_patch`; image-capable models also get
`view_image`. Other Felan tools remain active. Switching to another model
restores the ordinary tools. All shell and filesystem operations use the
current `AgentRuntime`.
Runtimes without persistent-process support keep Felan's ordinary coding tools.
Because Pi normally exposes skill metadata only while `read` is active, Codex
mode restores that metadata from Pi's structured prompt options. Matching
skills remain progressively disclosed: the model opens the selected `SKILL.md`
through `exec_command` and loads referenced files only as needed.
The local TUI presents Codex tool calls with friendly action labels while
headless modes continue to expose the stable tool names and raw results.

Optional settings live under `extensionConfig.codex` in
`$FELAN_AGENT_DIR/settings.json`:

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

`tty: true` allocates a real operating-system PTY through the runtime terminal
capability. `write_stdin` sends terminal input; for non-TTY sessions, the exact
Ctrl-C byte interrupts the process group and other input is rejected. Process
output is decoded incrementally and terminal control sequences are removed
before tool text is returned to the model.

Initial commands wait 250-30000 ms and default to 10000 ms; Windows uses a
10000 ms minimum. Non-empty `write_stdin` calls wait 250-30000 ms and default
to 250 ms; empty polls wait 5000-300000 ms and default to 5000 ms.
Interactions targeting one session are serialized. Cancelling a tool wait
leaves its process available for a later `write_stdin` call, while session
shutdown terminates all remaining processes. Sessions are in-memory and do
not survive application restart.

The extension excludes restart-durable jobs, web access, image generation,
Code Mode/Responses Lite, prompt replacement, compaction, voice, and UI
widgets.

## Development

```sh
pnpm --filter @felan-ai/ext-codex build
pnpm --filter @felan-ai/ext-codex type-check
pnpm --filter @felan-ai/ext-codex test
```

See [NOTICE](NOTICE) for upstream attribution.

## Package boundary and requirements

Agent Core owns the runtime contract and Pi owns provider transport. This
package owns provider/model eligibility, structured tool replacement, request
controls, PTY/session handling, and bounded image delivery; it does not register
or replace a provider. Filesystem, process, PTY, and image reads go through the
active `AgentRuntime`.

The package requires a compatible `@felan-ai/agent-core` peer, TypeBox, and
Pi-TUI. Runtime adapters without persistent-process support retain Felan's
ordinary coding tools rather than registering unusable Codex controls. Host
mode remains current-user access and is not a sandbox.

## Related documentation

- [Codex tools configuration](../../docs/user-guide/configuration.md#codex-tools)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)

## Attribution

Selected implementation behavior is adapted from the reviewed
`@howaboua/pi-codex-conversion` sources. See [NOTICE](NOTICE) and
[LICENSE](LICENSE) for source commits and attribution.
