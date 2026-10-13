# @felan-ai/ext-browser

Portable Felan browser automation backed by the reviewed `agent-browser 0.37.1`
CLI. The package does not vendor the upstream Rust daemon or Chrome. It probes
the exact reviewed CLI on Felan's `AgentRuntime` and otherwise remains safely
unavailable.

## Configured authorization service

The package root exports a service-backed execution entry. A trusted provider
may register `BROWSER_AUTHORIZATION_SERVICE` from
`@felan-ai/ext-browser/service` (`felan.browser.authorization@1`). Without it,
the extension still registers `browser` for isolated sessions and skills, but
does not register `browser_authorize`.

The service implements `authorize(request)` and optionally `checkExecution()`.
Each authorization request includes the existing `BrowserAuthorizationRequest`
fields plus `authorizationPolicy`, resolved from `pi.config.authorizationPolicy`
with the schema default `ask`. The provider must honor this policy, the request's
cancellation signal, and the attachment/lease contract. Policy persistence,
consent presentation, and Chrome discovery remain provider-owned; no ambient
policy lookup occurs in the execution entry. Changed configuration applies to
new extension activations. `checkExecution` retains the host's inherited CLI
configuration guard.

`createBrowserExtension` and the existing host types remain available for
explicit composition.

## Tool

The extension registers the ordinary `browser` tool and, when its host supplies
authorization, a separate `browser_authorize` control-plane tool.

`browser_authorize` supports `authorize`, `status`, and `revoke`. The
`authorize` operation requires a concise, non-blank `reason` explaining the
authenticated task. The configured provider presents an owner-only session
approval with that reason when policy requires consent, then opens a fresh
strict pinned tab in the existing Chrome session. Capable TUI and ACP clients
can present the approval; client kind alone grants no authority. Hosts can
configure `always-allow` through browser settings; changing it back to `ask` restores the prompt for
later authorizations. The host supplies a transient validated loopback CDP
endpoint. After authorization, the attached browser accepts the native CLI
command surface, including authenticated browser state and advanced
diagnostics. Felan replaces its session, namespace, configuration, output, and
connection options before dispatch. Direct `connect`, `--cdp`, and
`--auto-connect` arguments cannot replace the leased connection.

The `browser` tool has two operations:

- `skill` runs the installed CLI's `skills get <name>` command. Start with
  `core`, use `full: true` for the complete command reference, and request a
  specialized skill such as `electron`, `slack`, `dogfood`, or
  `vercel-sandbox` when appropriate. Skill content is retrieved at runtime so
  it remains matched to the installed CLI version rather than being copied
  into Felan's prompt. Any `args` supplied with a skill request are ignored.
- `run` accepts literal CLI argument tokens, for example
  `['open', 'https://example.com']`, `['snapshot', '-i']`, or
  `['fill', '@e3', 'value']`. The operation never accepts shell syntax. Felan owns
  the session, namespace, idle-timeout, JSON, content-boundary, and output-limit
  options, plus domain/action policy and local-file-access controls. Each tool
  operation also uses a freshly written Felan-owned config,
  so ambient project/global `agent-browser` configuration and plugins are not loaded;
  permitted options must be passed explicitly or supplied by the host
  environment. Sessions are namespaced to the Felan session, CLI JSON output
  is bounded, and page/CLI output is marked as untrusted data. Any `skill` or
  `full` fields supplied with a run request are ignored.

Install, upgrade, repair, plugin, MCP/stream/dashboard server, chat,
action-confirmation, raw skill, and cross-session close commands are not
available through the model tool. `batch` remains unavailable so each browser
call is visible to the agent runtime. Installation and policy confirmation are
host-owned and explicit.

Use a bare `['screenshot']` (optionally with flags) when the selected model
accepts image input. Felan stages that screenshot at a random path in session
storage, validates PNG/JPEG/GIF/WebP magic bytes, bounds the read to 20 MiB,
resizes it to at most 2,000 pixels per side and 4 MiB of encoded data, and
returns native image content. Text-only models or unreadable/invalid staged
images receive a bounded text fallback instead. Model-selected screenshot
paths remain text-only and are never opened automatically.

The owned browser session is closed during session shutdown. Revocation and
shutdown disconnect an attached session without closing the user's Chrome.
CDP attachment remains browser-level authority. The initial authorization
observation and lease protect the connection, but Felan does not probe the
daemon or target before and after every command. A live authorized attachment
may read sensitive browser data or execute page JavaScript, so authorize it
only when that access is intended. The requested origin is only the initial
destination, and attached navigation may cross HTTP(S) origins. Felan makes
one connection attempt per approval and retries setup only after an explicit
user action.

A managed CLI install sets a one-hour daemon idle timeout; it does not install Chrome. Run
the explicit `agent-browser install` action when a local Chrome for Testing
binary is needed.

## Runtime dependency and onboarding

The host checks for the exact reviewed CLI. If it is unavailable, explicit
dependency setup can request a managed installation or disable the extension.
The trusted provider applies installation policy and obtains eligible
local-console consent when required; an extension's session form is not
installation authority. The managed
installer downloads the pinned npm archive into Felan agent storage, verifies
its SHA-512 integrity and platform native binary SHA-256 digest, extracts the
bundled version-matched skills without lifecycle scripts, and verifies the CLI
version. A readiness marker is written only after verification, and managed
binary integrity is checked again before discovery executes it. Concurrent
installers use separate candidate directories, and discovery considers only
fully verified candidates. Installation never runs from non-interactive
startup or a model tool call.

Cloud and other non-interactive hosts should preinstall the reviewed CLI in
the active runtime or disable this extension in their host configuration.

## Development

```sh
pnpm --filter @felan-ai/ext-browser build
pnpm --filter @felan-ai/ext-browser type-check
pnpm --filter @felan-ai/ext-browser test
```

See [NOTICE](NOTICE) for upstream attribution and the reviewed immutable
release details.

## Package boundary and security

The extension owns literal-argv validation, session namespacing, bounded output,
version-matched skill retrieval, screenshot validation, and safe text/image
fallbacks. Hosts own credentials, attachment authorization, dependency
installation, and browser policy. Page content, CLI output, and bundled skill
text are untrusted. Existing-browser attachment requires `browser_authorize`.
When policy requires consent and no eligible owner client can answer, access
fails closed.

## Related documentation

- [Browser workflow](../../docs/user-guide/web-mcp-and-browser.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Runtime dependencies](../../docs/reference/runtime-dependencies.md)

## Attribution

The integration is reviewed against `agent-browser` 0.37.1. The package does
not vendor its daemon or Chrome. See [NOTICE](NOTICE) and [LICENSE](LICENSE) for
the immutable upstream release, digests, and TypeBox attribution.
