# Codex Extension

- Activate structured Codex tools only for GPT model IDs on the exact `openai` and `openai-codex` providers.
- Route process and filesystem access through `AgentRuntime`; keep provider transport on Pi's public native APIs.
- Keep Codex request controls in the normal declarative extension settings.
- Preserve the upstream attribution in LICENSE and NOTICE when adapting implementation details.
- Publish the reload-scoped `felan:codex:tool-mode:v1` event after session/model tool synchronization so optional extensions can expose fallbacks only while ordinary tools are replaced. Keep the event payload versioned and limited to the active boolean.
