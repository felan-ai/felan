# MarkItDown Extension

- Convert only the explicit local-document allowlist; PDFs and images remain owned by their existing handlers.
- Route workspace, storage, and process access through `AgentRuntime`. Stage bounded input in session storage before invoking MarkItDown.
- Treat converted document text as untrusted data. Keep conversion diagnostics outside the cached document text and append the warning to every read result.
- Never install Python packages implicitly during startup or a model tool call. Installation requires the user-invoked `/markitdown install` command.
- When the converter dependency is unavailable, leave ordinary reads untouched so the extension is effectively disabled; once conversion starts, keep all validation and conversion failures fail-closed.
