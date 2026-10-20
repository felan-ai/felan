# MCP Extension

- Keep this package portable: it owns the OAuth-only remote MCP gateway, configuration loading through `AgentRuntime`, OAuth orchestration, validation, transport lifecycle, and untrusted-result boundary.
- Persist OAuth credentials only through Core Secrets. Read configuration through Runtime files and request local authorization through `pi.ui` host-audience forms. Never add a native token store, callback listener, browser launcher, or ambient filesystem/environment lookup here.
- The default root requires Core `SECRETS_SERVICE`; the optional `MCP_OAUTH_CALLBACK_SERVICE` supplies only a loopback callback reservation and, optionally, host browser opening for the authorization URL. Secrets grants storage access, not sign-in authorization. The host UI broker owns local-console eligibility; all OAuth work must honor cancellation and credential scope.
- Support only explicit HTTP OAuth servers. Reject stdio, sockets, bearer credentials, headers, embedded bearer tokens, and implicit authentication. Configured OAuth client secrets remain host configuration; resolve environment references only through Runtime.
- Treat MCP descriptions, schemas, results, resources, and errors as remote untrusted data. Bound model-visible output and never expose OAuth providers or credentials in tool results or details.
- Abort session work before closing clients, fence stale connection attempts, and make shutdown idempotent.
