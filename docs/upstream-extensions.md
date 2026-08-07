# Upstream extension baselines

Felan extensions are portable adaptations rather than vendored upstream
snapshots. This inventory records the immutable upstream revision reviewed
when each extension was implemented. It is intended for later feature and bug
fix reviews; the package-level `NOTICE` files remain the attribution authority.

Advance a baseline only after the corresponding upstream changes have been
reviewed or incorporated. Do not advance it merely because a newer version was
published.

| Felan package | Relationship | Reviewed upstream baseline | Current upstream history |
| --- | --- | --- | --- |
| `@felan-ai/ext-ask-user` | Adapted source; the snapshot originates from `edlsh/pi-ask-user` | [`pi-ask-user` 0.11.2 at `7e72e509`][ask-user-baseline] | [`mslavov/pi-extensions`][ask-user-history], [`edlsh/pi-ask-user`][ask-user-origin-history] |
| `@felan-ai/ext-background-bash` | Adapted source | [`pi-background-bash` 0.1.0 at `7e72e509`][background-bash-baseline] | [History][background-bash-history] |
| `@felan-ai/ext-codex` | Adapted selected code and behavior | [`@howaboua/pi-codex-conversion` 3.0.8 at `62d1501a`][codex-baseline] | [History][codex-history] |
| `@felan-ai/ext-context` | Adapted source | [`pi-progressive-context` 0.1.0 at `9571293d`][context-baseline] | [History][context-history] |
| `@felan-ai/ext-mcp` | Adapted selected behavior | [`pi-mcp-adapter` 2.21.0 at `eaf37978`][mcp-baseline] | [History][mcp-history] |
| `@felan-ai/ext-powerline` | Adapted source; that source incorporates subscription logic from `marckrenn/pi-sub` | [`pi-powerline` 0.1.0 at `7e72e509`][powerline-baseline] | [History][powerline-history] |
| `@felan-ai/ext-prewalk` | Adapted source | [`pi-prewalk` 0.1.0 at `7e72e509`][prewalk-baseline] | [History][prewalk-history] |
| `@felan-ai/ext-rtk-optimizer` | Adapted code and behavior | [`pi-rtk-optimizer` 0.9.0 at `d155d253`][rtk-baseline] | [History][rtk-history] |
| `@felan-ai/ext-subagents` | Design reference only; no source copied | [`pi-subagents` 0.5.2-patched.1 at `7e72e509`][subagents-baseline] | [History][subagents-history] |
| `@felan-ai/ext-tasks` | Design reference only; no source copied | [`pi-todo-write` 0.1.0 at `9571293d`][tasks-baseline] | [History][tasks-history] |
| `@felan-ai/ext-web-access` | Adapted source and behavior | [`pi-web-access` 0.18.0 at `d2aab00d`][web-access-baseline] | [History][web-access-history] |

For a path in an upstream monorepo, a focused review can use:

```sh
git log --oneline <baseline>..origin/main -- <package-path>
git diff <baseline>..origin/main -- <package-path>
```

For a standalone upstream repository, omit the package path. Use the full
commit hashes from the baseline links or the corresponding package `NOTICE`.

[ask-user-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-ask-user
[ask-user-history]: https://github.com/mslavov/pi-extensions/commits/main/packages/pi-ask-user
[ask-user-origin-history]: https://github.com/edlsh/pi-ask-user/commits/main
[background-bash-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-background-bash
[background-bash-history]: https://github.com/mslavov/pi-extensions/commits/main/packages/pi-background-bash
[codex-baseline]: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/62d1501ac0c6acb39c4b4d225a9e9056a7ba3b91/packages/pi-codex-conversion
[codex-history]: https://github.com/IgorWarzocha/howaboua-pi-stuff/commits/main/packages/pi-codex-conversion
[context-baseline]: https://github.com/mslavov/pi-extensions/tree/9571293d422db11de893fa80ed0fc3e39945c657/packages/pi-progressive-context
[context-history]: https://github.com/mslavov/pi-extensions/commits/main/packages/pi-progressive-context
[mcp-baseline]: https://github.com/nicobailon/pi-mcp-adapter/tree/eaf379782fddf836828811d1b71ad85d27bc70dd
[mcp-history]: https://github.com/nicobailon/pi-mcp-adapter/commits/main
[powerline-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-powerline
[powerline-history]: https://github.com/mslavov/pi-extensions/commits/main/packages/pi-powerline
[prewalk-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-prewalk
[prewalk-history]: https://github.com/mslavov/pi-extensions/commits/main/packages/pi-prewalk
[rtk-baseline]: https://github.com/MasuRii/pi-rtk-optimizer/tree/d155d253cb2f1358e34e717d47a82ebccb08cb8e
[rtk-history]: https://github.com/MasuRii/pi-rtk-optimizer/commits/main
[subagents-baseline]: https://github.com/mslavov/pi-extensions/tree/7e72e509fe45a5a87c4c2e176cb711de994a8c1d/packages/pi-subagents
[subagents-history]: https://github.com/mslavov/pi-extensions/commits/main/packages/pi-subagents
[tasks-baseline]: https://github.com/mslavov/pi-extensions/tree/9571293d422db11de893fa80ed0fc3e39945c657/packages/pi-todo-write
[tasks-history]: https://github.com/mslavov/pi-extensions/commits/main/packages/pi-todo-write
[web-access-baseline]: https://github.com/nicobailon/pi-web-access/tree/d2aab00dcf0547572276d9de4bc4a2a49d640e13
[web-access-history]: https://github.com/nicobailon/pi-web-access/commits/main
