# Upstream extension review baselines

This is the canonical provenance and differential-review inventory for adapted
or externally integrated extensions.

Felan extensions are portable adaptations rather than vendored upstream
snapshots. This inventory separates two revisions that serve different
purposes:

- **Initial adaptation source** records the immutable source/provenance
  checkpoint used for the first Felan implementation. Package-level `NOTICE`
  files record later adapted revisions and remain the attribution authority.
- **Latest reviewed upstream** records the newest release or revision whose
  changes have been evaluated. Advance this checkpoint even when no change is
  ported, so the next review starts from a known comparison point.

The latest repository-wide review was completed on **2026-09-05**. npm
versions below use the published package's `gitHead`; monorepo-only packages
use the reviewed path revision.

| Felan package | Relationship | Initial adaptation source | Latest reviewed upstream | Review outcome |
| --- | --- | --- | --- | --- |
| `@felan-ai/ext-ask-user` | Adapted source; the snapshot originates from `edlsh/pi-ask-user` | [`pi-ask-user` 0.11.2 at `7e72e509`][ask-user-baseline] | Origin [`pi-ask-user` 0.14.0 at `2de7e145`][ask-user-reviewed]; Felan fork remains at `7e72e509` | Ported proxy-safe option handling and bounded TUI improvements; retained Felan's portable host contract. |
| `@felan-ai/ext-background-bash` | Adapted source | [`pi-background-bash` 0.1.0 at `7e72e509`][background-bash-baseline] | Same release and revision | No upstream change; Felan now probes required POSIX runtime utilities and keeps the feature inactive when they are unavailable. |
| `@felan-ai/ext-browser` | External CLI integration; no upstream source copied | [`agent-browser` 0.31.1 at `ed2e1059`][agent-browser-reviewed] | Same release and revision | Felan exposes the version-matched bundled skills and CLI through a portable tool, adds host-owned onboarding, isolates sessions, and converts safe screenshots to native image content; it does not vendor the upstream daemon or install Chrome automatically. |
| `@felan-ai/ext-codex` | Adapted selected code and behavior | [`@howaboua/pi-codex-conversion` 3.0.8 at `62d1501a`][codex-baseline] | Release [`3.0.26` at `f16fee5`][codex-latest-reviewed] | Ported structured skill-prompt preservation, delete-and-readd patch replacement, shutdown fencing, and the narrow `strict: null` to `strict: false` compatibility normalization for direct Responses function tools; excluded the upstream provider, voice, native compaction, Code/Notebook modes, context windows, and display sidecar. |
| `@felan-ai/ext-codebase-memory` | Adapted behavior and prompt guidance plus external native CLI integration | [`pi-cbm` 1.2.1 at `921a749d`][codebase-memory-adaptation] and [`codebase-memory-mcp` 0.10.8 at `46ae198f`][codebase-memory-runtime] | Same releases and revisions | Ported a four-tool structural exploration surface to `AgentRuntime`; added exact-binary gating, explicit no-config installation, shared agent-scoped cache coordination, bounded grep/Codex augmentation, and startup/manual refresh while excluding watchers, LSP, ambient configuration, and automatic installation. |
| `@felan-ai/ext-context` | Adapted source | [`pi-progressive-context` 0.1.0 at `9571293d`][context-baseline] | [`0.1.0` at monorepo `7e72e509`][context-reviewed] | No path changes since the adaptation source. |
| `@felan-ai/ext-context-view` | Adapted source | [`pi-context` 0.1.0 at `7e72e509`][context-view-baseline] | Same revision | Ported the context estimate and overlay to Felan's public Agent Core surface; adapted prompt markup, tool attribution, and TUI boundaries. |
| `@felan-ai/ext-insights` | Adapted source with host-owned local storage | [`pi-insights` at `7e72e509`][insights-baseline] | Same revision | Ported bounded analytics and a self-contained Felan HTML report; filesystem discovery and report opening remain local-host responsibilities. |
| `@felan-ai/ext-prompt-history` | Adapted source with local TUI storage adapter | [`pi-prompt-history` at `7e72e509`][prompt-history-baseline] | Same revision | Ported the scoped prompt picker with inline-by-default or overlay presentation; historical session discovery remains owned by the local TUI host and is bounded/read-only. |
| `@felan-ai/ext-markitdown` | Adapted behavior with a new runtime safety boundary | [`pi-markitdown` 0.1.0 at `7e72e509`][markitdown-baseline] | Same release and revision | Ported automatic `read` interception for document formats while excluding PDF/image overlap plus source audio and recursive ZIP handling; replaced direct host I/O, silent binary fallback, and startup installation with bounded runtime staging, explicit installation, clear diagnostics, and untrusted-content guidance. |
| `@felan-ai/ext-mcp` | Adapted selected behavior | [`pi-mcp-adapter` 2.21.0 at `eaf37978`][mcp-baseline] | Release [`2.26.0` at `5ee81b47`][mcp-reviewed], plus main through [`1bf36719`][mcp-main-reviewed] | Ported the post-release nested gateway-arguments fix; other changes are host-owned, already covered, or outside the OAuth-only gateway. |
| `@felan-ai/ext-powerline` | Adapted source; subscription logic references `marckrenn/pi-sub` | [`pi-powerline` 0.1.0 at `7e72e509`][powerline-baseline] | Same primary revision; secondary [`@marckrenn/pi-sub-core` 1.5.0 at `65deb568`][pi-sub-reviewed] | No primary update; secondary changes are already represented by Felan's model-window prioritization or belong to the host/provider layer. |
| `@felan-ai/ext-prewalk` | Adapted source | [`pi-prewalk` 0.1.0 at `7e72e509`][prewalk-baseline] | Same release and revision | No upstream change. |
| `@felan-ai/ext-rtk-optimizer` | Adapted code and behavior | [`pi-rtk-optimizer` 0.9.0 at `d155d253`][rtk-baseline] | Same release and revision | No upstream change; Felan additionally supports managed runtime discovery and an explicit digest-verified official installer pinned to RTK 0.45.0. |
| `@felan-ai/ext-subagents` | Design reference only; no source copied | [`pi-subagents` 0.5.2-patched.1 at `7e72e509`][subagents-baseline] | Same release and revision | No upstream change. |
| `@felan-ai/ext-tasks` | Design reference only; no source copied | [`pi-todo-write` 0.1.0 at `9571293d`][tasks-baseline] | [`0.1.0` at monorepo `7e72e509`][tasks-reviewed] | No path changes since the design review. |
| `@felan-ai/ext-web-access` | Adapted source and behavior | [`pi-web-access` 0.18.0 at `d2aab00d`][web-access-baseline] | Release [`0.23.0` at `c77b2822`][web-access-reviewed], plus main through [`81e18785`][web-access-main-reviewed] | Retained provider search and bounded extraction concepts, then replaced cached research artifacts with discovery-only search, filtered text/PDF passages, and a stricter SSRF boundary. |

## 2026-09-05 decisions

The review accepted changes that fix behavior already owned by a Felan
extension:

- Ask User: tolerate provider-mangled option shapes, preserve legacy string
  inputs, normalize display preferences, bound multi-select/context rendering,
  and allow an explicit single-column layout.
- Codex: safely treat adjacent delete/add actions for one path as replacement,
  prevent process work from entering a session manager after shutdown, and
  preserve optional Responses function-tool arguments when Pi emits nullable
  strictness.
- MCP: recover a complete gateway request accidentally nested in `args`, while
  rejecting malformed nesting with sanitized guidance.
- Web Access: the reviewed cache design was later superseded. Version 0.5 keeps
  full fetched content out of session state entirely and exposes no retained
  result storage, paging, or session hooks.

The review deliberately did **not** add ambient browser-cookie access, hosted
URL extractors, new web providers, MCP stdio/direct tools/resources/apps or
command-derived headers, Codex provider replacement/voice/Code Mode/Notebook
Mode, Ask User's project-specific lifecycle events, or upstream-owned OAuth
storage and callback UI. Those changes either conflict with Felan's security
and ownership boundaries or add unrelated product surface.

`ext-tasks` also cites the Beads task tracker as a general design influence.
That reference is not an extension source snapshot: Felan copies no Beads code
and does not invoke its CLI, so it is not used as a future source-diff
checkpoint.

## Future reviews

For a path in an upstream monorepo, compare from the **latest reviewed**
revision rather than the older adaptation source:

```sh
git log --oneline <latest-reviewed>..origin/main -- <package-path>
git diff <latest-reviewed>..origin/main -- <package-path>
```

For a standalone upstream repository, omit the package path. When a newer
release is reviewed, update its version, full commit link, review date, and
outcome even when the decision is "do not port."

[ask-user-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-ask-user
[ask-user-reviewed]: https://github.com/edlsh/pi-ask-user/tree/2de7e145227f7a527e995e323a50e7ee9bf88b0e
[agent-browser-reviewed]: https://github.com/vercel-labs/agent-browser/tree/ed2e10598c9064aecfaeb7cf21b540684db4be2c
[background-bash-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-background-bash
[codex-baseline]: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/62d1501ac0c6acb39c4b4d225a9e9056a7ba3b91/packages/pi-codex-conversion
[codex-latest-reviewed]: https://github.com/IgorWarzocha/howaboua-pi-stuff/commit/f16fee563f71849cc2b9a94be2b6f70e12fca804
[codebase-memory-adaptation]: https://github.com/alexykn/pi-cbm/tree/921a749d5cea74bda8f647542627ef9518fec272
[codebase-memory-runtime]: https://github.com/DeusData/codebase-memory-mcp/tree/46ae198fc11cda80e817acbc5f5908d7c2de7032
[context-baseline]: https://github.com/mslavov/pi-extensions/tree/9571293d422db11de893fa80ed0fc3e39945c657/packages/pi-progressive-context
[context-reviewed]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-progressive-context
[context-view-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-context
[insights-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-insights
[prompt-history-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-prompt-history
[markitdown-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-markitdown
[mcp-baseline]: https://github.com/nicobailon/pi-mcp-adapter/tree/eaf379782fddf836828811d1b71ad85d27bc70dd
[mcp-reviewed]: https://github.com/nicobailon/pi-mcp-adapter/tree/5ee81b47b571b3c4ac2e68a03812c64e3f95cb98
[mcp-main-reviewed]: https://github.com/nicobailon/pi-mcp-adapter/commit/1bf36719cec478a163bb52e3390182963aab9f85
[powerline-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-powerline
[pi-sub-reviewed]: https://github.com/marckrenn/pi-sub/tree/65deb56853b924fbbcee1b77e09c71f5f08fc9a2/packages/sub-core
[prewalk-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-prewalk
[rtk-baseline]: https://github.com/MasuRii/pi-rtk-optimizer/tree/d155d253cb2f1358e34e717d47a82ebccb08cb8e
[subagents-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-subagents
[tasks-baseline]: https://github.com/mslavov/pi-extensions/tree/9571293d422db11de893fa80ed0fc3e39945c657/packages/pi-todo-write
[tasks-reviewed]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-todo-write
[web-access-baseline]: https://github.com/nicobailon/pi-web-access/tree/d2aab00dcf0547572276d9de4bc4a2a49d640e13
[web-access-reviewed]: https://github.com/nicobailon/pi-web-access/tree/c77b28221d527f298d409d7e61ade661e548f50c
[web-access-main-reviewed]: https://github.com/nicobailon/pi-web-access/commit/81e18785fdf6e14f9dee28d8a805c74eca29b991
