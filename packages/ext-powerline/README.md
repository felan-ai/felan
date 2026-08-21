# @felan-ai/ext-powerline

Portable ANSI-aware TUI footer extension targeting Pi 0.84.2. The local Felan
TUI enables it by default and binds a host that can display Codex or Claude
subscription usage; the package itself is hostless by default.

The footer displays:

- current directory
- cached Git branch, revision, working-tree status, tag, age, stash, upstream, and repository name
- active model and thinking level
- session token and cost totals
- active Codex or Claude subscription usage
- context-window usage
- statuses published by other Pi extensions

Rendering is ANSI-width-aware and supports left/right alignment, wrapping,
`minimal`, `powerline`, and `capsule` styles, plus text and Powerline Unicode
charsets. Git probes are asynchronous, cached, coalesced, time-bounded, and
executed exclusively through `pi.exec`.

The extension installs its footer on `session_start` only when `ctx.mode` is
`tui`, redraws for model, thinking, agent, turn, tool, compaction, tree, usage,
and Git branch changes, and removes and disposes the footer on
`session_shutdown`. Headless Pi modes perform no footer, Git, or subscription
work.

## Configuration

The extension reads `$FELAN_AGENT_DIR/powerline.json`, which defaults to
`~/.felan/powerline.json`, when it initializes. It accepts the compatible Pi
powerline fields for display layout, supported segments, and custom colors.

The `subscription` segment supports Codex and Claude OAuth plans. Codex values
show remaining percentage; Claude values show used percentage. The segment can
configure `showProviderName`, `showReset`, `showPercentage`, and `maxWindows`.
It refreshes at startup, after turns and model changes, and once per minute.

Configuration is inert for the process lifetime. These Pi flags override the
file when the TUI footer is installed:

| Flag | Supported values | Default |
| --- | --- | --- |
| `--felan-powerline-theme` | `dark`, `light`, `nord`, `tokyo-night`, `rose-pine`, `gruvbox`, `custom` | `dark` |
| `--felan-powerline-style` | `minimal`, `powerline`, `capsule` | `powerline` |
| `--felan-powerline-charset` | `text`, `unicode` | `text` |
| `--felan-powerline-color` | `auto`, `none`, `ansi`, `ansi256`, `truecolor` | `auto` |
| `--felan-powerline-wrap` | boolean | `true` |
| `--felan-powerline-directory-style` | `full`, `fish`, `basename` | `fish` |
| `--felan-powerline-session-type` | `tokens`, `cost`, `both`, `breakdown` | `tokens` |
| `--felan-powerline-context-style` | `text`, `bar`, `blocks`, `blocks-line`, `dots` | `bar` |

The package default export is hostless and renders no subscription data.
Consumers enable subscription usage with
`createPowerlineExtension(subscriptionUsageHost)`. The portable package owns
provider detection, response parsing, caching, throttling, and rendering; the
host owns credential access and provider requests.

Hosts can supply `options.footerRows` as the second argument to append
width-aware rows after the configured powerline status lines.

Felan's local TUI supplies a host backed by `ModelRuntime`. It uses the active
provider's Felan OAuth credential and fixed Codex or Anthropic usage endpoints.
The extension package does not inspect authentication files, receive stored
credential objects, or perform network requests.

## Package boundary and requirements

```ts
import { createPowerlineExtension } from '@felan-ai/ext-powerline';

const extension = createPowerlineExtension();
```

The package owns width-safe rendering, layout/config parsing, Git-cache
behavior, provider detection, response parsing, caching, and throttling. Hosts
own credential access, provider requests, TUI installation, and any extra footer
rows. The footer is installed only in TUI mode; headless sessions do no Git or
subscription work.

The local default can be disabled with `builtinExtensions.powerline: false` in
Felan settings. The package requires a compatible `@felan-ai/agent-core` peer
and Pi-TUI.

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

The rendering, theme, segment, lifecycle, Git-cache, and subscription controller
design is adapted from the MIT-licensed `pi-powerline` source by Milko Slavov.
That source credits the MIT-licensed `marckrenn/pi-sub` `packages/sub-core` for
subscription provider and usage logic. See [NOTICE](NOTICE).
See [LICENSE](LICENSE) for the package license.

## Related documentation

- [Local CLI and Powerline behavior](../../docs/user-guide/local-cli.md)
- [Configuration](../../docs/user-guide/configuration.md#powerline)
- [Extension catalog](../../docs/reference/extension-catalog.md)
