# @felan-ai/ext-felan-api

Portable single-tool gateway for the authenticated Felan REST API. It replaces
many endpoint-specific tools with one `felan_api` request surface that can be
composed by local and managed hosts.

## Activation and composition

The default export is environment-aware. When the extension is invoked, it
uses `FELAN_API_KEY`; with no non-empty key it registers no tool or capability.
An explicit key takes precedence over the environment, and an explicit blank
key disables activation:

```ts
import felanApiExtension, {
  createFelanApiExtension,
} from '@felan-ai/ext-felan-api';

// Uses FELAN_API_KEY, FELAN_API_URL, and FELAN_TEAM_SLUG when bound.
const environmentExtension = felanApiExtension;

// Explicit configuration is useful for managed hosts and tests.
const cloudExtension = createFelanApiExtension({
  apiKey: 'bzy_team_…',
  baseUrl: 'https://app.felan.ai',
  docsBaseUrl: 'https://felan.ai/docs',
  teamSlug: 'acme',
});
```

`baseUrl` defaults to `FELAN_API_URL`, then `https://app.felan.ai`. It may be a
host URL or an existing `/api/v1` URL. `docsBaseUrl` defaults to
`FELAN_DOCS_URL`, then `https://felan.ai/docs`. `teamSlug` defaults to
`FELAN_TEAM_SLUG`. An explicitly provided value takes precedence; an explicit
blank value suppresses environment-provided team guidance. The slug is guidance
only, so team-scoped paths still need to include the slug required by the API.

## The `felan_api` tool

The extension registers exactly one tool when active:

```ts
felan_api({
  method: 'GET',
  path: 'teams/acme/integrations',
  query: { providers: 'github,linear' },
});
```

Inputs are:

- `method`: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`; defaults to `GET`.
- `target`: `api` (default) or `docs` for the public documentation service.
- `path`: a relative path below `/api/v1`, without a query or fragment. For
  `target: "docs"`, omit it for `llms.txt` or pass a relative Markdown page.
- `query`: bounded string, number, and boolean query values.
- `body`: JSON data for non-GET requests.

Call `GET openapi.json` when the current API contract is unknown. The gateway
uses `Authorization: Bearer <key>` for API requests, never sends that header to
the documentation target, rejects path traversal, absolute URLs, cross-origin
redirects, oversized bodies, and oversized responses, and returns a bounded
response envelope.

Responses are wrapped in `<untrusted_felan_api_content>` and must be treated as
remote data, not instructions. The key is redacted from model-visible output
and error details. API mutations may be externally visible or destructive; the
host/model must have clear authorization for the exact operation and scope.
The portable extension does not assume a UI confirmation mechanism.

## Development

Source: `packages/ext-felan-api` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-felan-api build
pnpm --filter @felan-ai/ext-felan-api type-check
pnpm --filter @felan-ai/ext-felan-api test
```
