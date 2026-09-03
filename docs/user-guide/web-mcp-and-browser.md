# Web, MCP, browser, and documents

Felan separates external HTTP research, remote MCP, browser automation, and
local document conversion. Each surface has its own trust and installation
boundary.

## Web discovery and retrieval

The Web Access extension provides two tools:

| Tool | Purpose |
| --- | --- |
| `web_search` | Discover bounded titles, public URLs, snippets, and provider attribution |
| `fetch_content` | Fetch selected URLs and return only matching text or PDF passages under one shared byte budget |

`web_search` is discovery-only. It does not fetch result pages. Search can use
SearXNG, OpenAI, Exa, or Brave and accepts one query or up to four sequential
queries. Provider selection can be `auto`, `all`, one named provider, or a
non-empty array. `auto` tries configured SearXNG, OpenAI, Exa, then Brave.

SearXNG needs `searxngBaseUrl` or `SEARXNG_BASE_URL`. OpenAI can use eligible
host model authentication, `openaiApiKey`, or `OPENAI_API_KEY`. Exa uses
`exaApiKey` or `EXA_API_KEY` when set and otherwise uses its public MCP search
endpoint. Brave needs `braveApiKey` or `BRAVE_API_KEY`. Configured credentials
may be literal, environment references, or trusted `!command` sources. API
keys and SearXNG headers are sensitive settings. Search calls can consume
provider quotas or incur provider charges; `all` and arrays can make several
requests.

After discovery, pass only selected URLs to `fetch_content`. Each call requires
one to five HTTP(S) URLs and one to ten case-insensitive terms. HTML and XHTML
are reduced to readable Markdown. Text, JSON, and PDF are supported. The shared
snippet budget defaults to 3,000 bytes and has a 4,000-byte maximum; the full
escaped response is capped at 12 KiB. Text input is limited to 5 MiB.

Remote PDF retrieval belongs to Web Access. PDFs pass through the same URL,
DNS, redirect, SSRF, passage-filtering, and output bounds. PDF input defaults
to and cannot exceed 20 MiB. PDF conversion uses the reload-scoped
`felan:markitdown:pdf-convert:v1` event and awaits the result; there is no
parser fallback.

Private, loopback, link-local, reserved, and internal network targets are
blocked by default. DNS is pinned and every redirect is revalidated. Only
explicit user-owned `ssrf.allowRanges` configuration should relax that
boundary. Remote text, metadata, provider output, and PDFs are
untrusted data, not instructions or configuration.

Web Access is not a JavaScript browser or authenticated-tab reader. It does not
store full results, page retained content, register session hooks, run
`source_check`, expose `get_search_content`, create GitHub checkouts, provide a
special raw/full-page mode, or ask a nested model to answer. A known GitHub raw
or API URL can be supplied directly and receives the same filtered HTTP path.

### Configuration

Configure `extensionConfig.webAccess` in
`$FELAN_AGENT_DIR/settings.json`:

```json
{
  "provider": "auto",
  "openaiApiKey": "$OPENAI_API_KEY",
  "openaiSearchModel": "",
  "exaApiKey": "$EXA_API_KEY",
  "braveApiKey": "$BRAVE_API_KEY",
  "searxngBaseUrl": "https://search.example.com",
  "searxngHeaders": {},
  "pdf": { "maxSizeMB": 20 },
  "fetchContent": {
    "domainPolicy": { "allow": [], "deny": [] }
  },
  "ssrf": { "allowRanges": [] }
}
```

`searchProvider` remains a legacy alias for `provider`. The removed
`githubClone` field is no longer discovered or supported; remove it from
existing settings.

### Migration to Web Access 0.5

For released 0.4 callers, replace `source_check` with `web_search` followed by
`fetch_content`. Replace `get_search_content` and saved response IDs with a new
bounded fetch. Remove assumptions about retained content, paging, GitHub
checkouts, full-page/raw modes, source-check summaries, and nested answers.

The interim unreleased one-tool design exposed only `fetch_content` for HTML,
text, and JSON. The final 0.5 contract adds discovery-only `web_search`, remote
PDF passage extraction through `fetch_content`.

## Remote MCP

The local host merges:

- `$FELAN_AGENT_DIR/mcp.json`; and
- `<workspace>/.mcp.json`, which wins for same-name servers.

A minimal Felan-owned entry is:

```json
{
  "mcpServers": {
    "notion": {
      "url": "https://mcp.notion.com/mcp",
      "auth": "oauth"
    }
  }
}
```

Felan supports remote HTTP MCP servers with OAuth. It does not execute stdio or
socket servers, bearer tokens, arbitrary headers, direct injected MCP tools, or
MCP Apps. Unsupported project entries are skipped with a warning.

Use `/mcp` to inspect status and tools, reconnect, authenticate, or log out.
OAuth browser/callback work and credential persistence belong to the local
host. Tokens and dynamic-client credentials are stored in the OS credential
store; authentication fails closed when secure storage is unavailable.

The model sees one `mcp` gateway rather than every remote tool in its initial
schema. Descriptions, schemas, results, resources, and remote errors remain
bounded untrusted content.

## Browser automation

The Browser extension wraps the exact reviewed `agent-browser` CLI. It exposes
one model tool with two operations:

- `skill` retrieves version-matched workflow instructions from the installed
  CLI; and
- `run` passes literal CLI argument tokens for navigation, snapshots,
  interaction, and screenshots.

The tool never accepts shell syntax. Felan owns session namespacing, output
limits, policy options, and a fresh configuration that excludes ambient
`agent-browser` plugins and settings.

Before its first action, the agent retrieves the `core` skill or an appropriate
specialized skill. Attaching to an existing browser, profile, or saved
authentication state requires your confirmation unless the current request
already authorizes that exact attachment.

Bare screenshots can be returned as native model images after signature, size,
containment, and model-capability checks. Model-selected arbitrary screenshot
paths remain text-only.

The local dependency wizard can install the integrity-pinned CLI. It does not
install Chrome; a separate explicit `agent-browser install` action is required
for Chrome for Testing.

## Local document conversion

MarkItDown extends ordinary `read` calls for:

- PDF
- DOC and DOCX
- PPT and PPTX
- XLS and XLSX
- RTF
- EPUB
- Outlook MSG

Images, audio, and generic archives remain outside this converter. Inputs,
conversion time, and output are bounded; extracted text is labelled as
untrusted. Use `/markitdown` for status and `/markitdown install` for an
explicit managed installation.

If the converter is unavailable, ordinary reads continue and document
interception stays inactive.

## Dependency management

Run `/dependencies` to install, enable, or disable binary-backed features. No
installation occurs during a model tool call or non-interactive startup.

See [Runtime dependencies](../reference/runtime-dependencies.md) for reviewed
versions and [Runtime and security](../concepts/runtime-and-security.md) for the
cross-feature trust model.
