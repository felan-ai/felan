# @felan-ai/ext-markitdown

Adds bounded MarkItDown conversion to the ordinary `read` workflow. A read of
a recognized local document is converted into a session-storage Markdown
cache, then the original `read` call is redirected to that cache. Existing
offset, limit, and truncation behavior therefore continues to work.

## Formats

The extension intercepts this explicit local-document allowlist:

- PDF: `.pdf`
- Word: `.docx`, `.doc`
- PowerPoint: `.pptx`, `.ppt`
- spreadsheets: `.xlsx`, `.xls`
- rich documents: `.rtf`, `.epub`
- Outlook messages: `.msg`

All image formats are intentionally excluded. Plain-text formats such
as HTML, CSV, JSON, and XML continue through the normal reader.
The source extension's audio formats are also excluded because transcription
may use external services and is outside this local document-reading scope.
Its generic ZIP handling is excluded because it recursively converts nested
PDFs/images and cannot enforce a safe expanded-size limit.

MarkItDown's local converters vary by dependency availability. Legacy
`.doc`/`.ppt` and RTF cleanup may not be available in every installation;
failed or empty conversions return a clear tool error instead of exposing
binary bytes as text.

## Installation

The extension uses a previously managed installation first, then a working
`markitdown ==0.1.7` command from `PATH`. It never downloads packages during
startup or a model-initiated read. If no compatible command is available, run:

```text
/markitdown install
```

This explicit command requires Python 3.10 or newer and installs the reviewed
`markitdown` 0.1.7 PDF and document extras into Felan's agent storage. `/markitdown`
shows status, limits, formats, and cache location. When no compatible converter
is available, Office reads bypass interception instead of invoking an
unavailable executable. PDF reads fail closed with `/markitdown install`
guidance so another PDF handler cannot silently take over. The first
verification can take up to a minute while
Python loads the newly installed document libraries; later checks are normally
much faster.

## Safety boundary

- Input is read through `AgentRuntime` and limited to 20 MiB.
- PDF input must contain a `%PDF-` signature within its first 1,024 bytes.
  PDF content under another extension and image signatures are rejected.
- A validated copy is staged in session storage; the converter never receives
  the original workspace path.
- Conversion has a 60-second timeout, a 10 MiB sanitized output limit, and a
  64 KiB combined stdout/stderr capture limit.
- Partial staging files are removed, and successful results are cached by
  content hash for the current root session.
- Once conversion is active, recognized files fail closed with actionable
  diagnostics if path validation, conversion, or limits fail.
- Converted Markdown is untrusted document data. A system capability and a
  diagnostic appended to every converted result instruct the model not to
  follow embedded requests or treat them as configuration.

Outside active Codex mode, the extension adds no second read tool: supported
documents are converted automatically through ordinary `read`. When Codex mode
replaces `read`, its lifecycle signal makes this extension lazily register and
activate `read_document` for Office formats (`.docx`, `.doc`, `.pptx`, `.ppt`,
`.xlsx`, `.xls`, `.rtf`, `.epub`, `.msg`). Switching to another model hides
`read_document` and restores ordinary `read`; without the Codex extension,
`read_document` is never registered. It accepts a document `path` with optional
1-indexed `offset` and `limit`
(default and maximum 2,000 lines), converts through the same bounded
MarkItDown pipeline and content-hash cache, and returns converted Markdown
with the same source/cache diagnostic and untrusted-data warning. Oversized
Markdown lines are split into stable pagination segments so every continuation
advances, and the complete tool response is limited to 50 KiB. PDF reads remain
with the ordinary `read` interception and the PDF-bytes event owner.

## Composition and package boundary

```ts
import markitdownExtension from '@felan-ai/ext-markitdown';

const extension = markitdownExtension;
```

Peer extensions can request conversion over Pi's reload-scoped event bus.
Web or another URL owner must complete its own URL, network, byte-limit, and
signature checks before passing bytes; the event never accepts a URL:

```ts
import {
  MARKITDOWN_PDF_EVENT,
  type MarkitdownPdfConversionRequest,
} from '@felan-ai/ext-markitdown';

let claimed = false;
let result;
pi.events.emit(MARKITDOWN_PDF_EVENT, {
  version: 1,
  bytes: pdfBytes,
  signal,
  claim() {
    if (claimed) return false;
    claimed = true;
    return true;
  },
  respond(promise) { result = promise; },
} satisfies MarkitdownPdfConversionRequest);
await result;
```

The event handler validates the PDF signature again and shares the local reader's
20 MiB input limit, 10 MiB sanitized output limit, session staging, literal
argument execution, timeout/cancellation, serialization, cleanup, and
content/version cache.

The package owns format selection, bounded staging, conversion diagnostics, and
cache redirection. The host supplies `AgentRuntime`, installation policy, and
the `markitdown` executable. It requires `@felan-ai/agent-core` 0.5.7 or newer
within the current major-compatible range, and Python 3.10 or newer only when
the managed converter is installed.

## Development

Source: `packages/ext-markitdown` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-markitdown build
pnpm --filter @felan-ai/ext-markitdown type-check
pnpm --filter @felan-ai/ext-markitdown test
```

## Related documentation

- [Web, MCP, browser, and documents](../../docs/user-guide/web-mcp-and-browser.md)
- [Runtime dependencies](../../docs/reference/runtime-dependencies.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)

## Attribution

The package adapts reviewed `pi-markitdown` behavior and interoperates with
Microsoft MarkItDown 0.1.7, which is installed separately when requested. It
does not bundle the Python converter. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
