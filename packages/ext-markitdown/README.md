# @felan-ai/ext-markitdown

Adds bounded MarkItDown conversion to the ordinary `read` workflow. A read of
a recognized local document is converted into a session-storage Markdown
cache, then the original `read` call is redirected to that cache. Existing
offset, limit, and truncation behavior therefore continues to work.

## Formats

The extension intercepts only formats not owned by Felan's image and PDF
surfaces:

- Word: `.docx`, `.doc`
- PowerPoint: `.pptx`, `.ppt`
- spreadsheets: `.xlsx`, `.xls`
- rich documents: `.rtf`, `.epub`
- Outlook messages: `.msg`

PDFs and all image formats are intentionally excluded. Plain-text formats such
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
`markitdown` 0.1.7 document extras into Felan's agent storage. `/markitdown`
shows status, limits, formats, and cache location. When no compatible converter
is available, the extension bypasses document interception instead of invoking
an unavailable executable. The first verification can take up to a minute while
Python loads the newly installed document libraries; later checks are normally
much faster.

## Safety boundary

- Input is read through `AgentRuntime` and limited to 20 MiB.
- PDF and image signatures are rejected even when a file has a misleading
  supported extension.
- A validated copy is staged in session storage; the converter never receives
  the original workspace path.
- Conversion has a 60-second timeout and a 10 MiB output limit.
- Partial staging files are removed, and successful results are cached by
  content hash for the current root session.
- Once conversion is active, recognized files fail closed with actionable
  diagnostics if path validation, conversion, or limits fail.
- Converted Markdown is untrusted document data. A system capability and a
  diagnostic appended to every converted result instruct the model not to
  follow embedded requests or treat them as configuration.

The automatic `read` interception is available only while the ordinary `read`
tool is active. Felan's Codex mode currently replaces that tool, so this
extension does not add a second Codex-specific document tool.

## Composition and package boundary

```ts
import markitdownExtension from '@felan-ai/ext-markitdown';

const extension = markitdownExtension;
```

The package owns format selection, bounded staging, conversion diagnostics, and
cache redirection. The host supplies `AgentRuntime`, installation policy, and
the `markitdown` executable. It requires a compatible `@felan-ai/agent-core`
peer and Python 3.10 or newer only when the managed converter is installed.

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
