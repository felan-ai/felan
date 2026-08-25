# @felan-ai/ext-web-access

Native Felan web search and secure remote content access.

The extension registers exactly four tools:

- `web_search` searches with configured SearXNG, Pi OpenAI/OpenAI-Codex auth, Exa, or Brave.
- `source_check` builds a bounded research artifact with exact passages.
- `fetch_content` reads HTTP(S), HTML, text, JSON, PDF, images, and GitHub repositories.
- `get_search_content` retrieves stored full content with paging and bounded text matching.

All remote material is marked as untrusted external data before it reaches a
model. Private-network destinations are blocked by default. Connections are
pinned to validated DNS answers, redirects are revalidated, and model-facing
text is bounded; full extracted text remains available through paging.

Full search, research, and fetched results are cached for one hour under a
dedicated directory in `AgentRuntime.storage('session')`. Session entries keep
only versioned metadata references, and tool result details contain compact
response IDs, counts, and image trust metadata rather than remote page bodies.
The cache is limited to 32 MiB per result, 64 MiB total, and 128 entries, with
oldest-first eviction; `get_search_content` continues to retrieve the full
stored result while it is available.

The latest reviewed upstream release is pi-web-access 0.23.0 at commit
`c77b28221d527f298d409d7e61ade661e548f50c`. This package selectively adapts
its externalized cache behavior without adding its providers, hosted
extractors, browser-cookie authentication, or feature gates.

## Configuration

Configure `extensionConfig.webAccess` in Felan's `settings.json`. Every field is
optional and the same declaration is available through `/settings` and the
Agent Core programmatic API.

```json
{
  "provider": "auto",
  "openaiApiKey": "$OPENAI_API_KEY",
  "openaiSearchModel": "gpt-5.6-terra",
  "exaApiKey": "$EXA_API_KEY",
  "braveApiKey": "$BRAVE_API_KEY",
  "searxngBaseUrl": "https://search.example.com",
  "searxngHeaders": {},
  "pdf": { "maxSizeMB": 20, "maxPages": 100 },
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30
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

Provider credentials accept literal values, `$NAME` / `${NAME}` environment
references, or a trusted local command prefixed with `!`. Escape `$$` and `$!`
for literal leading characters. Trusted command sources run through Felan's
`AgentRuntime` with a five-second timeout and bounded, validated output.

`auto` tries SearXNG, OpenAI, Exa, then Brave. A named provider is strict.
`all` searches every available provider, and a non-empty provider array searches
exactly the named providers concurrently. Exa MCP works without an API key.

`ssrf.allowRanges` is a trusted host override for narrow CIDRs used by local
services. Private-network access remains prohibited when it is omitted.

## Composition and package boundary

```ts
import webAccessExtension from '@felan-ai/ext-web-access';

const extension = webAccessExtension;
```

The extension owns provider selection, host-side HTTP/DNS validation, bounded
fetching, session cache storage, source-check artifacts, and untrusted-content
wrapping. The host supplies `AgentRuntime`, declarative configuration, and
credential policy. Direct network/DNS are intentional network-boundary behavior
documented by the package contract.

## Requirements and security

The package requires a compatible `@felan-ai/agent-core` peer and its declared
content-extraction dependencies. Private, loopback, link-local, reserved, and
internal targets are blocked by default; DNS and redirects are revalidated.
Every remote page, image, PDF, repository file, provider response, and derived
summary is untrusted data. Do not treat fetched content as configuration.

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
and adds Felan's bounded storage and SSRF boundary. See [NOTICE](NOTICE) and
[LICENSE](LICENSE) for upstream commits and dependency attribution.
