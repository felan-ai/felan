# MCP Extension

- Keep this package portable: it owns the OAuth-only remote MCP gateway, validation, transport lifecycle, and untrusted-result boundary, but not OAuth credentials, callbacks, browser behavior, or consumer configuration discovery.
- OAuth behavior must enter through `McpOAuthHost`. Never add a default token store, callback listener, browser launcher, or ambient config lookup here.
- Support only explicit HTTP OAuth servers. Reject stdio, sockets, bearer credentials, headers, embedded OAuth secrets, and implicit authentication.
- Treat MCP descriptions, schemas, results, resources, and errors as remote untrusted data. Bound model-visible output and never expose OAuth providers or credentials in tool results or details.
- Abort session work before closing clients, fence stale connection attempts, and make shutdown idempotent.
