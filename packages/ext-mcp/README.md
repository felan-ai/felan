# `@felan-ai/ext-mcp`

Portable OAuth-only remote MCP support for Felan. The package registers one
token-efficient `mcp` gateway for status, reconnection, discovery, calls,
authentication, and logout. It also registers `/mcp` for interactive status,
tool listing, reconnection, authentication, and logout. The command remains
available with an empty config so consumers can show setup guidance. The
default entry loads configuration through Runtime files and persists OAuth
credentials through Core Secrets. It never launches a browser or accesses a
native credential store directly.

The model-facing gateway exposes `status`, `reconnect`, `list`, `search`,
`describe`, `call`, `authenticate`, and `logout`. Its capability and tool
description identify the validated configured server names. Connections are
session-scoped and lazy: `disconnected` means there is no live transport in the
current session; it does not indicate whether the consumer's OAuth host has
credentials available or persists them. Discovery and call actions connect
automatically, while `reconnect` explicitly replaces a live connection or
connects a disconnected server:

```ts
mcp({ action: 'reconnect', server: 'docs' });
```

If reconnecting reports `needs-auth`, use the model-facing `authenticate`
action. For other failures, retry once and then inspect the consumer-owned MCP
configuration and network policy rather than starting OAuth unnecessarily.
Interactive `/mcp` messages include bounded, sanitized diagnostics when the
SDK provides a structured OAuth, HTTP, timeout, or network error. Model-facing
errors expose only the safe category, provider error code, and HTTP status;
remote error text is not copied into model context.

## Core services and host authorization

The default entry requires Core `SECRETS_SERVICE` (`felan.secrets@1`). It reads
`mcp.json` using `runtime.readAgentFile` and the workspace `.mcp.json` using
`runtime.readFile`. Project entries override agent entries. Invalid or unsupported
project entries produce bounded warnings; global configuration errors fail loading.

The extension owns OAuth discovery, dynamic client registration, PKCE/state,
refresh and logout. Credentials are scoped by agent directory, server name, URL,
OAuth profile and issuer, and written with Secrets version checks. Configured
OAuth clients may provide `clientSecret` or `clientSecretEnv` for confidential
clients. Environment references are resolved through Runtime, never ambient
extension I/O. Configured client secrets are not copied into the token store.

Local sign-in additionally uses optional `MCP_OAUTH_CALLBACK_SERVICE`
(`felan.mcp.oauth-callback@1`) from `@felan-ai/ext-mcp/service`. This is a narrow
host exception because Runtime does not expose inbound HTTP listeners. It only
reserves an HTTP loopback callback and returns its result; it does not read
configuration, store tokens, or implement authorization UI. The local provider
owns listener activation, cancellation and cleanup.

The authorization URL appears in a nondeferrable, transient `pi.ui.request` form
with `audience: 'host'`. Its presentation is never stored in the control snapshot.
Only an eligible local console may present it; no client-kind
claim or ordinary session form grants authority. The user opens the URL locally,
and the form closes when the callback finishes. There is no browser launcher or
extension-specific presenter. Without a callback provider, sign-in is unavailable;
existing credentials can still be used, including credentials provisioned by a
cloud host through Secrets and config sync.

The named factory remains available for explicit composition:

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

`McpOAuthHost` remains an explicit composition boundary for consumers using the
named factory. Its sessions supply the SDK OAuth provider and honor shutdown and
cancellation. The default entry composes the extension-owned implementation from
Runtime, Secrets, host UI and the optional loopback service.

Cloud hosts must also apply their tenant identity and outbound network policy
to MCP and OAuth configuration before constructing the extension. In
particular, protect OAuth discovery/registration/token requests from private
network access and DNS rebinding, persist flow state and PKCE material across
instances, and bind credentials to tenant, server URL, issuer, client, and
redirect URI. Pass a policy-enforcing `fetch` in `createMcpExtension` options so
transport-driven MCP and OAuth requests use the consumer's network boundary.

The extension accepts only explicit `{ url, auth: "oauth" }` servers. It does
not support stdio, Unix sockets, bearer tokens, custom headers,
direct MCP tools, resources/prompts, MCP Apps, scripting, sampling, or
configuration discovery outside the Runtime file boundary.

All MCP metadata and tool output is bounded and returned inside an explicit
untrusted-content boundary. OAuth credentials and provider state are never
included in tool results or details.

## Package boundary and requirements

The package owns Runtime-backed configuration, OAuth orchestration, credential
serialization, the gateway, transport lifecycle and bounded untrusted results.
Hosts provide Secrets, UI authorization policy, and optionally the loopback
callback primitive. Native filesystem access, credential storage, callback
listeners and browser launchers do not belong in this package.

It requires a compatible `@felan-ai/agent-core` peer, MCP SDK client, and
TypeBox. Only explicit remote HTTP servers with `auth: 'oauth'` are accepted;
stdio, sockets, bearer tokens, custom headers, direct tools/resources/prompts,
and MCP Apps are rejected.

## Development

Source: `packages/ext-mcp` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-mcp build
pnpm --filter @felan-ai/ext-mcp type-check
pnpm --filter @felan-ai/ext-mcp test
```

## Related documentation

- [MCP workflow](../../docs/user-guide/web-mcp-and-browser.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)

## Attribution

Selected gateway behavior is adapted from the reviewed MIT-licensed
`pi-mcp-adapter` releases. See [NOTICE](NOTICE) and [LICENSE](LICENSE) for
source commits and MCP SDK attribution.
