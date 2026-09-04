# MarkItDown Extension

- Convert only the explicit local-document allowlist. MarkItDown owns PDF conversion; images remain owned by their existing handlers.
- Route workspace, storage, and process access through `AgentRuntime`. Stage bounded input in session storage before invoking MarkItDown.
- Subscribe to `felan:markitdown:pdf-convert:v1` through `pi.events`. Claim a request before starting conversion, then pass its Promise to the response callback. The request accepts only validated `Uint8Array` PDF bytes and optional cancellation, never a URL.
- Treat converted document text as untrusted data. Keep conversion diagnostics outside the cached document text and append the warning to every read result.
- Never install Python packages implicitly during startup or a model tool call. Installation requires the user-invoked `/markitdown install` command.
- When the converter dependency is unavailable, Office reads may remain untouched, but PDF reads and event jobs must fail closed with `/markitdown install` guidance.
- Lazily register and activate `read_document` for Office formats only (`.docx`, `.doc`, `.pptx`, `.ppt`, `.xlsx`, `.xls`, `.rtf`, `.epub`, `.msg`) after the reload-scoped Codex tool-mode event reports that ordinary `read` was replaced. Hide it when Codex or MarkItDown mode is inactive, and never register it when Codex is absent. PDF stays with `read` interception and the PDF-bytes event. The tool shares detection, bounded staging, content-hash cache, serialization, cancellation, diagnostics, and untrusted-data handling with the `read` path. Pagination must advance even for oversized lines, and its complete response, including diagnostics, must remain within the output bound.
