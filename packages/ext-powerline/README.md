# @felan-ai/ext-powerline

Default local TUI footer extension for Felan, targeting Pi 0.83.0.

The footer displays:

- current directory
- cached Git branch, revision, working-tree status, tag, age, stash, upstream, and repository name
- active model and thinking level
- session token and cost totals
- context-window usage
- statuses published by other Pi extensions

Rendering is ANSI-width-aware and supports left/right alignment, wrapping,
`minimal`, `powerline`, and `capsule` styles, plus text and Powerline Unicode
charsets. Git probes are asynchronous, cached, coalesced, time-bounded, and
executed exclusively through `pi.exec`.

The extension installs its footer on `session_start` only when `ctx.mode` is
`tui`, redraws for model, thinking, agent, turn, tool, compaction, tree, and Git
branch changes, and removes and disposes the footer on `session_shutdown`.
Headless Pi modes perform no footer or Git work.

## Display flags

Configuration is inert for the process lifetime. These Pi flags are read when
the TUI footer is installed:

| Flag | Supported values | Default |
| --- | --- | --- |
| `--felan-powerline-theme` | `dark`, `light`, `nord`, `tokyo-night`, `rose-pine`, `gruvbox` | `dark` |
| `--felan-powerline-style` | `minimal`, `powerline`, `capsule` | `powerline` |
| `--felan-powerline-charset` | `text`, `unicode` | `text` |
| `--felan-powerline-color` | `auto`, `none`, `ansi`, `ansi256`, `truecolor` | `auto` |
| `--felan-powerline-wrap` | boolean | `true` |
| `--felan-powerline-directory-style` | `full`, `fish`, `basename` | `fish` |
| `--felan-powerline-session-type` | `tokens`, `cost`, `both`, `breakdown` | `tokens` |
| `--felan-powerline-context-style` | `text`, `bar`, `blocks`, `blocks-line`, `dots` | `bar` |

The portable subset does not read or watch configuration files, inspect private
authentication files or JWTs, call subscription services, or depend on tmux or
private environment conventions.

## Development

Source: `packages/ext-powerline` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-powerline build
pnpm --filter @felan-ai/ext-powerline type-check
pnpm --filter @felan-ai/ext-powerline test
```

## Attribution

The rendering, theme, segment, lifecycle, and Git-cache design is adapted from
the MIT-licensed `pi-powerline` source by Milko Slavov. That source credits the
MIT-licensed `marckrenn/pi-sub` `packages/sub-core` for subscription provider
and usage logic. Felan excludes that credential and network functionality.
See [NOTICE](NOTICE).
