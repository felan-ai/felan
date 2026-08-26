# Web, MCP, browser, and documents

Felan separates external HTTP research, remote MCP, browser automation, and
local document conversion. Each surface has its own trust and installation
boundary.

## Web research

The Web Access extension provides four tools:

| Tool | Purpose |
| --- | --- |
| `web_search` | Search one or more OpenAI, Exa, Brave, or SearXNG providers |
| `source_check` | Check a claim and retain bounded exact passages |
| `fetch_content` | Fetch readable/raw pages, grounded answers, PDF text, images, or GitHub content; local hosts expose a bounded exact checkout and managed runtimes use the GitHub API |
| `get_search_content` | Page or search content retained from an earlier response |

Search can run up to four queries per call. Retrieved content is bounded,
externalized when large, and marked as untrusted before model delivery.

Configure providers in `$FELAN_AGENT_DIR/settings.json` under
`extensionConfig.webAccess`. Provider selection
can be `auto`, `all`, one named provider, or a non-empty array of named
providers. Keep API credentials in this user-owned file rather than a project
repository.

Private, loopback, link-local, reserved, and internal network targets are
blocked by default. DNS is pinned and redirects are revalidated. Only explicit
user-owned `ssrf.allowRanges` configuration should relax that boundary.

Web fetching is HTTP/content extraction, not a JavaScript browser and not an
authenticated-tab reader.

GitHub repository URLs are handled specially. On the local host, Felan creates
a shallow checkout verified at an exact commit and returns a trusted path for
ordinary inspection tools, alongside a concise tree/README or requested file.
Managed runtimes do not execute Git; they receive a bounded GitHub API view.
Checkout paths are session-local, capped by the Web Access `maxCheckouts`
setting, and removed when the session ends. Repository content is still
untrusted external data.

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

- DOC and DOCX
- PPT and PPTX
- XLS and XLSX
- RTF
- EPUB
- Outlook MSG

PDFs, images, audio, and generic archives remain outside this converter. Inputs,
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
