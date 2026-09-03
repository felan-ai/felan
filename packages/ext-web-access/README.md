# @felan-ai/ext-web-access

Secure, bounded web discovery and retrieval for Felan.

The extension registers two tools and no always-on capability prompt:

| Tool | Purpose |
| --- | --- |
| `web_search` | Discover public URLs through SearXNG, OpenAI, Exa, or Brave |
| `fetch_content` | Fetch known URLs and return only matching text or PDF passages |

Use `web_search` only to discover candidate pages. Its results contain bounded
titles, URLs, snippets, provider attribution, and partial errors; it does not
fetch the result pages. Pass selected URLs to `fetch_content` with the terms
needed for the answer.

```ts
web_search({ query: 'example package release notes', numResults: 5 });

fetch_content({
  urls: [
    'https://example.com/releases.json',
    'https://example.com/reference.html',
  ],
  findText: ['version', 'breaking change'],
  limit: 3000,
  ignoreLlmsTxt: false,
});
```

## Search providers

`web_search` accepts either one query or up to four queries. Each query is at
most 500 characters. A provider returns one to ten results per query; the
default is five. Optional recency and domain filters are forwarded where the
provider supports them. The complete search result is capped at 12 KiB.

Provider selection can be `auto`, `all`, one provider, or a non-empty array of
up to four named providers. `auto` tries configured SearXNG, OpenAI, Exa, then
Brave. A named provider is strict. `all` and arrays can make several external
requests, so provider quotas and charges can be higher. Provider services set
their own prices; Felan does not claim that one selection reduces cost.

- SearXNG requires `searxngBaseUrl` or `SEARXNG_BASE_URL`. Optional headers are
  sensitive configuration.
- OpenAI can use authentication for an official OpenAI or OpenAI Codex model
  already configured in the host. `openaiApiKey` or `OPENAI_API_KEY` is the
  fallback. `openaiSearchModel` overrides the search model.
- Exa uses `exaApiKey` or `EXA_API_KEY` when present and otherwise uses Exa's
  public MCP search endpoint.
- Brave requires `braveApiKey` or `BRAVE_API_KEY`.

Configured credential sources can be literal values, `$NAME` or `${NAME}`
environment references, or a trusted local command prefixed with `!`. Escape
`$$` and `$!` for literal leading characters. Command sources run through
`AgentRuntime` with a five-second timeout and bounded, validated output.

## Content retrieval

`fetch_content` requires one to five public HTTP(S) URLs and one to ten
case-insensitive match terms. URLs are fetched concurrently. HTML and XHTML are
reduced to readable Markdown; `text/*`, JSON, `+json`, and PDF are supported.
Only matching snippets are returned under one shared UTF-8 byte budget. The
budget defaults to 3,000 bytes and cannot exceed 4,000 bytes. The complete
escaped result envelope, including metadata, is capped at 12 KiB.

After successfully fetching an HTML-like resource, Web Access checks the exact
origin-root `/llms.txt` once per origin for that tool call. A valid, non-empty
2xx textual response replaces the requested HTML as both the matching source
and returned provenance. Set `ignoreLlmsTxt: true` to match the requested HTML
instead. Direct `/llms.txt` requests, JSON, declared plain text, PDFs, and
binary resources never trigger the companion lookup. Missing, empty, HTML,
binary, unsupported, oversized, timed-out, blocked, or otherwise failed
companions fall back to the already-fetched HTML without exposing the
companion body or error. Caller cancellation still cancels the tool call.

Text responses are limited to 5 MiB before extraction. Extracted text is
internally bounded before passage selection. Companion `/llms.txt` responses
have a separate 1 MiB limit. Web Access owns URL validation,
DNS pinning, redirects, domain policy, timeout, download size, content type,
and PDF signature checks. Every validated remote PDF is then converted by
MarkItDown through the reload-scoped `felan:markitdown:pdf-convert:v1` event.
Web Access awaits the accepted conversion Promise; there is no built-in PDF
parser or fallback. If MarkItDown is disabled, unavailable, or fails, that URL
returns a bounded error. PDF input defaults to and cannot exceed 20 MiB.
Converted Markdown still passes through the same matching and model-facing
bounds as other text, and successful PDF metadata identifies MarkItDown as the
converter.

## Configuration

Configure `extensionConfig.webAccess` in Felan's `settings.json`. Every field is
optional and the same declaration is available through `/settings` and the
Agent Core programmatic API.

```json
{
  "provider": "auto",
  "openaiApiKey": "$OPENAI_API_KEY",
  "openaiSearchModel": "",
  "exaApiKey": "$EXA_API_KEY",
  "braveApiKey": "$BRAVE_API_KEY",
  "searxngBaseUrl": "https://search.example.com",
  "searxngHeaders": {},
  "pdf": {
    "maxSizeMB": 20
  },
  "fetchContent": {
    "domainPolicy": {
      "allow": [],
      "deny": []
    }
  },
  "ssrf": {
    "allowRanges": []
  }
}
```

`searchProvider` remains a legacy alias for `provider`; new configuration
should use `provider`. Credential values and `searxngHeaders` are marked
sensitive for configuration presentation. `ssrf.allowRanges` is a trusted host
override for narrow CIDRs used by services the user owns. Private-network
access remains prohibited when it is omitted.

## Removed behavior and migration to 0.5

Version 0.5 is a breaking change from 0.4. Replace `source_check` with an
explicit `web_search` followed by `fetch_content`. Replace
`get_search_content` and response IDs with a new bounded `fetch_content` call.
There is no retained result storage, paging, session hook, `source_check`,
GitHub checkout, special raw/full-page mode, source-check summary, or nested
answer mode. An explicitly supplied GitHub raw or API URL is handled like any
other URL and returns only matching passages. Remove `githubClone` settings.

The interim unreleased one-tool design exposed only `fetch_content` for HTML,
text, and JSON. The final 0.5 surface adds discovery-only `web_search` and
bounded remote PDF passage extraction in `fetch_content`. Callers must still
fetch selected search results explicitly.

## Security and package boundary

All remote text, metadata, provider responses, and PDF content are untrusted
data. Returned text is wrapped as untrusted external content. Do not treat
remote content as instructions, configuration, or authorization.

Private, loopback, link-local, reserved, and internal targets are blocked by
default. Connections are pinned to validated DNS answers, redirect
destinations are revalidated, cross-origin credentials are stripped, response
time and size are bounded, and equivalent content URLs are fetched once per
call. The `/llms.txt` probe map exists only for one tool call; no content or
lookup result is stored across calls. Web Access is not a JavaScript browser
and does not use browser cookies.

The extension owns provider selection, URL validation, host-side HTTP/DNS
enforcement, bounded extraction and passage matching, and untrusted-content
wrapping. The host supplies `AgentRuntime` and declarative configuration.
Direct network and DNS access are intentional
network-boundary behavior documented by this package contract.

## Development

Source: `packages/ext-web-access` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-web-access build
pnpm --filter @felan-ai/ext-web-access type-check
pnpm --filter @felan-ai/ext-web-access test
```

## Related documentation

- [Web, MCP, browser, and documents](../../docs/user-guide/web-mcp-and-browser.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Runtime dependencies](../../docs/reference/runtime-dependencies.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)

## Attribution

The package selectively adapts reviewed MIT-licensed `pi-web-access` behavior
and adds Felan's bounded search, matching, PDF, and SSRF boundaries. See
[NOTICE](NOTICE) and [LICENSE](LICENSE) for upstream and dependency attribution.
