# @felan-ai/ext-powerline

Portable ANSI-aware TUI footer extension targeting Pi 0.84.4. The local Felan
TUI enables it by default and binds a host that can display Codex or Claude
subscription usage; the package itself is hostless by default.

The footer displays:

- current directory
- cached Git branch, revision, working-tree status, tag, age, stash, upstream, and repository name
- active model and thinking level
- session token and cost totals (the local Felan TUI includes the root session
  and local subagent sessions; hostless consumers use the active session only)
- active Codex or Claude subscription usage
- estimated API-equivalent Felan savings for the configured recent-day period
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

Powerline inherits the active Pi theme. Segment roles use Pi semantic color
tokens, so changing the TUI theme also changes the footer; Powerline does not
maintain a second palette or color compatibility setting.

## Configuration

All configuration is supplied through the declarative `powerline` extension
settings. The settings include scalar display fields and ordered `lines` with
supported segment objects. Theme selection and colors belong to Pi.

The `subscription` segment supports Codex and Claude OAuth plans. Codex values
show remaining percentage; Claude values show used percentage. The segment can
configure `showProviderName`, `showReset`, `showPercentage`, and `maxWindows`.
It refreshes at startup, after turns and model changes, and once per minute.

The `savings` segment is enabled by default at the end of the first line and is
right-aligned above the model. It reports estimated API-equivalent savings
across all retained local Felan activity for seven inclusive UTC calendar days
(today plus the six previous days), displayed as
`Est. Savings(7d): $33.00`. Set `periodDays` on the segment to choose another
period. A `~` before the amount means at least one measurement had unavailable
pricing, so the USD total is incomplete. The local TUI supplies the host query;
the portable package does not access storage itself.

Scalar display settings are available through generated `felan --powerline-*`
options and `/settings`; structured `lines` values are edited as JSON in
`settings.json` or `/settings`.

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

The package owns width-safe rendering, layout/config validation, Git-cache
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
