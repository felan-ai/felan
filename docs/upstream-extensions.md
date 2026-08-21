# Upstream extension review baselines

Felan extensions are portable adaptations rather than vendored upstream
snapshots. This inventory separates two revisions that serve different
purposes:

- **Initial adaptation source** records the immutable source/provenance
  checkpoint used for the first Felan implementation. Package-level `NOTICE`
  files record later adapted revisions and remain the attribution authority.
- **Latest reviewed upstream** records the newest release or revision whose
  changes have been evaluated. Advance this checkpoint even when no change is
  ported, so the next review starts from a known comparison point.

The latest repository-wide review was completed on **2026-08-17**. npm
versions below use the published package's `gitHead`; monorepo-only packages
use the reviewed path revision.

| Felan package | Relationship | Initial adaptation source | Latest reviewed upstream | Review outcome |
| --- | --- | --- | --- | --- |
| `@felan-ai/ext-ask-user` | Adapted source; the snapshot originates from `edlsh/pi-ask-user` | [`pi-ask-user` 0.11.2 at `7e72e509`][ask-user-baseline] | Origin [`pi-ask-user` 0.14.0 at `2de7e145`][ask-user-reviewed]; Felan fork remains at `7e72e509` | Ported proxy-safe option handling and bounded TUI improvements; retained Felan's portable host contract. |
| `@felan-ai/ext-background-bash` | Adapted source | [`pi-background-bash` 0.1.0 at `7e72e509`][background-bash-baseline] | Same release and revision | No upstream change; Felan now probes required POSIX runtime utilities and keeps the feature inactive when they are unavailable. |
| `@felan-ai/ext-browser` | External CLI integration; no upstream source copied | [`agent-browser` 0.31.1 at `ed2e1059`][agent-browser-reviewed] | Same release and revision | Felan exposes the version-matched bundled skills and CLI through a portable tool, adds host-owned onboarding, isolates sessions, and converts safe screenshots to native image content; it does not vendor the upstream daemon or install Chrome automatically. |
| `@felan-ai/ext-codex` | Adapted selected code and behavior | [`@howaboua/pi-codex-conversion` 3.0.8 at `62d1501a`][codex-baseline] | Release [`3.0.15` at `b4b99630`][codex-reviewed], plus main through [`2e775ab4`][codex-main-reviewed] | Ported delete-and-readd patch replacement and shutdown fencing; excluded the upstream provider, voice, compaction, Code Mode, Notebook Mode, and the post-release display sidecar. |
| `@felan-ai/ext-context` | Adapted source | [`pi-progressive-context` 0.1.0 at `9571293d`][context-baseline] | [`0.1.0` at monorepo `7e72e509`][context-reviewed] | No path changes since the adaptation source. |
| `@felan-ai/ext-markitdown` | Adapted behavior with a new runtime safety boundary | [`pi-markitdown` 0.1.0 at `7e72e509`][markitdown-baseline] | Same release and revision | Ported automatic `read` interception for document formats while excluding PDF/image overlap plus source audio and recursive ZIP handling; replaced direct host I/O, silent binary fallback, and startup installation with bounded runtime staging, explicit installation, clear diagnostics, and untrusted-content guidance. |
| `@felan-ai/ext-mcp` | Adapted selected behavior | [`pi-mcp-adapter` 2.21.0 at `eaf37978`][mcp-baseline] | Release [`2.26.0` at `5ee81b47`][mcp-reviewed], plus main through [`1bf36719`][mcp-main-reviewed] | Ported the post-release nested gateway-arguments fix; other changes are host-owned, already covered, or outside the OAuth-only gateway. |
| `@felan-ai/ext-powerline` | Adapted source; subscription logic references `marckrenn/pi-sub` | [`pi-powerline` 0.1.0 at `7e72e509`][powerline-baseline] | Same primary revision; secondary [`@marckrenn/pi-sub-core` 1.5.0 at `65deb568`][pi-sub-reviewed] | No primary update; secondary changes are already represented by Felan's model-window prioritization or belong to the host/provider layer. |
| `@felan-ai/ext-prewalk` | Adapted source | [`pi-prewalk` 0.1.0 at `7e72e509`][prewalk-baseline] | Same release and revision | No upstream change. |
| `@felan-ai/ext-rtk-optimizer` | Adapted code and behavior | [`pi-rtk-optimizer` 0.9.0 at `d155d253`][rtk-baseline] | Same release and revision | No upstream change; Felan additionally supports managed runtime discovery and an explicit digest-verified official installer pinned to RTK 0.45.0. |
| `@felan-ai/ext-subagents` | Design reference only; no source copied | [`pi-subagents` 0.5.2-patched.1 at `7e72e509`][subagents-baseline] | Same release and revision | No upstream change. |
| `@felan-ai/ext-tasks` | Design reference only; no source copied | [`pi-todo-write` 0.1.0 at `9571293d`][tasks-baseline] | [`0.1.0` at monorepo `7e72e509`][tasks-reviewed] | No path changes since the design review. |
| `@felan-ai/ext-web-access` | Adapted source and behavior | [`pi-web-access` 0.18.0 at `d2aab00d`][web-access-baseline] | Release [`0.23.0` at `c77b2822`][web-access-reviewed], plus main through [`81e18785`][web-access-main-reviewed] | Ported metadata-only session references backed by bounded runtime storage; kept Felan's smaller provider set and stricter credential/SSRF boundary. |

## 2026-08-17 decisions

The review accepted changes that fix behavior already owned by a Felan
extension:

- Ask User: tolerate provider-mangled option shapes, preserve legacy string
  inputs, normalize display preferences, bound multi-select/context rendering,
  and allow an explicit single-column layout.
- Codex: safely treat adjacent delete/add actions for one path as replacement,
  and prevent process work from entering a session manager after shutdown.
- MCP: recover a complete gateway request accidentally nested in `args`, while
  rejecting malformed nesting with sanitized guidance.
- Web Access: keep full fetched content out of session entries and tool details;
  store it in bounded `AgentRuntime.storage('session')` cache files referenced
  by metadata-only session entries.

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
[codex-reviewed]: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/b4b99630cda3c066749af0fb3ac9b8184b2a4c7d/packages/pi-codex-conversion
[codex-main-reviewed]: https://github.com/IgorWarzocha/howaboua-pi-stuff/commit/2e775ab4bb3d68bf9877332e87eccb74f7984ec9
[context-baseline]: https://github.com/mslavov/pi-extensions/tree/9571293d422db11de893fa80ed0fc3e39945c657/packages/pi-progressive-context
[context-reviewed]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-progressive-context
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
