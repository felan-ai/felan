# `@felan-ai/ext-mcp`

Portable OAuth-only remote MCP support for Felan. The package registers one
token-efficient `mcp` gateway for status, discovery, calls, authentication, and
logout. It also registers `/mcp` for interactive status, tool listing,
reconnection, authentication, and logout. The command remains available with
an empty config so consumers can
show setup guidance. The package intentionally does not load ambient MCP files,
launch browsers, or store credentials.

## Consumer-owned OAuth

Create the extension with an immutable server snapshot and an injected OAuth
host:

```ts
import { createMcpExtension } from '@felan-ai/ext-mcp';

const extension = createMcpExtension({
  config: {
    mcpServers: {
      notion: {
        url: 'https://mcp.notion.com/mcp',
        auth: 'oauth',
      },
    },
  },
  oauthHost,
});
```

`McpOAuthHost` creates a session-scoped adapter that supplies an MCP SDK OAuth
provider and owns the complete OAuth implementation: client configuration,
token and dynamic-client persistence, PKCE/state, callbacks, browser or web-app
presentation, refresh behavior, and logout. An interactive local host can wait
for a loopback callback, while a cloud host can return a persistent `pending`
interaction completed by its web application.

`pending` messages and interaction IDs are returned through the tool and may be
persisted in session history. They must be non-secret: never place OAuth state,
authorization codes, PKCE material, tokens, or credential-bearing URLs in
either field.

Cloud hosts must also apply their tenant identity and outbound network policy
to MCP and OAuth configuration before constructing the extension. In
particular, protect OAuth discovery/registration/token requests from private
network access and DNS rebinding, persist flow state and PKCE material across
instances, and bind credentials to tenant, server URL, issuer, client, and
redirect URI. Pass a policy-enforcing `fetch` in `createMcpExtension` options so
transport-driven MCP and OAuth requests use the consumer's network boundary.

The extension accepts only explicit `{ url, auth: "oauth" }` servers. It does
not support stdio, Unix sockets, bearer tokens, custom headers, embedded OAuth
secrets, direct MCP tools, resources/prompts, MCP Apps, scripting, sampling, or
ambient host config discovery.

All MCP metadata and tool output is bounded and returned inside an explicit
untrusted-content boundary. OAuth credentials and provider state are never
included in tool results or details.
