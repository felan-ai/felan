# @felan-ai/ext-browser

Portable Felan browser automation backed by the reviewed `agent-browser 0.31.1`
CLI. The package does not vendor the upstream Rust daemon or Chrome. It probes
the exact reviewed CLI on Felan's `AgentRuntime` and otherwise remains safely
unavailable.

## Tool

The extension registers one `browser` tool with two operations:

- `skill` runs the installed CLI's `skills get <name>` command. Start with
  `core`, use `full: true` for the complete command reference, and request a
  specialized skill such as `electron`, `slack`, `dogfood`, or
  `vercel-sandbox` when appropriate. Skill content is retrieved at runtime so
  it remains matched to the installed CLI version rather than being copied
  into Felan's prompt.
- `run` accepts literal CLI argument tokens, for example
  `['open', 'https://example.com']`, `['snapshot', '-i']`, or
  `['fill', '@e3', 'value']`. The command must be the first token, permitted
  options follow it, and the operation never accepts shell syntax. Felan owns
  the session, namespace, idle-timeout, JSON, content-boundary, and output-limit
  options, plus domain/action policy and local-file-access controls. Each tool
  operation also uses a freshly written Felan-owned config,
  so ambient project/global `agent-browser` configuration and plugins are not loaded;
  permitted options must be passed explicitly or supplied by the host
  environment. Sessions are namespaced to the Felan session, CLI JSON output
  is bounded, and page/CLI output is marked as untrusted data.

Install, upgrade, repair, plugin, nested batch, MCP/stream/dashboard server,
chat, action-confirmation, raw skill, and cross-session close commands are not
available through the model tool. Use sequential browser calls instead of
`batch`. Installation and policy confirmation are host-owned and explicit.

Use a bare `['screenshot']` (optionally with flags) when the selected model
accepts image input. Felan stages that screenshot at a random path in session
storage, validates PNG/JPEG/GIF/WebP magic bytes, bounds the read to 20 MiB,
resizes it to at most 2,000 pixels per side and 4 MiB of encoded data, and
returns native image content. Text-only models or unreadable/invalid staged
images receive a bounded text fallback instead. Model-selected screenshot
paths remain text-only and are never opened automatically.

The owned browser session is closed during session shutdown. A managed CLI
install sets a one-hour daemon idle timeout; it does not install Chrome. Run
the explicit `agent-browser install` action when a local Chrome for Testing
binary is needed.

## Runtime dependency and onboarding

The local TUI checks for the exact reviewed CLI during interactive startup. If
it is unavailable, `/dependencies` and the first-run dependency wizard offer a
confirmed managed installation or disabling the Browser extension. The managed
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
text are untrusted. Existing browser/profile/auth-state attachment requires
explicit authorization unless the current request already grants that action.

## Related documentation

- [Browser workflow](../../docs/user-guide/web-mcp-and-browser.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Runtime dependencies](../../docs/reference/runtime-dependencies.md)

## Attribution

The integration is reviewed against `agent-browser` 0.31.1. The package does
not vendor its daemon or Chrome. See [NOTICE](NOTICE) and [LICENSE](LICENSE) for
the immutable upstream release, digests, and TypeBox attribution.
