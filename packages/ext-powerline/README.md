# @felan-ai/ext-powerline

Portable Powerline data and an ANSI-aware TUI footer targeting Pi. The package
root publishes generic `pi.ui` views and typed statuses in TUI, ACP, and headless
sessions without requiring a presentation service. Optional usage providers add
Codex, Claude, or Grok subscription usage and estimated savings. Footer
construction remains client-side.

The footer displays:

- current directory
- cached Git branch, revision, working-tree status, tag, age, stash, upstream, and repository name
- active model and thinking level
- session token and cost totals (a configured usage provider can include root
  and child sessions; without one, totals cover the active session only)
- active Codex, Claude, or Grok subscription usage
- estimated API-equivalent Felan savings for the configured recent-day period
- context-window usage
- statuses published by other Pi extensions
- the Felan version when enabled by the host application

Rendering is ANSI-width-aware and supports left/right alignment, wrapping,
`minimal`, `powerline`, and `capsule` styles, plus text and Powerline Unicode
charsets. Git probes are asynchronous, cached, coalesced, time-bounded, and
executed exclusively through `pi.exec`.

The default entry publishes on `session_start` and refreshes for model,
thinking, agent, turn, tool, compaction, tree, usage, and Git changes. Its generic
views retain every configured segment and display setting, splitting larger
outputs into views of at most 100 rows without shortening segment text. Session
and context metrics also use typed token, percent, and USD statuses. The
optional `felan.powerline@2.0.0` hint changes presentation only; clients without
it can display the same columns, rows, and values. Other extensions' common UI
statuses remain separately available to clients rather than being copied into
Powerline through a feature service.

Shutdown aborts Git probes, usage requests, and pending presentation requests,
joins owned work, closes views, and removes statuses. A failed publication stops
refresh timers and preserves a sanitized cleanup failure. Felan's client installs
the optional footer; the extension never constructs terminal components.

Powerline inherits the active Pi theme. Segment roles use Pi semantic color
tokens, so changing the TUI theme also changes the footer; Powerline does not
maintain a second palette or color compatibility setting.

## Configuration

All configuration is supplied through the declarative `powerline` extension
settings. The settings include scalar display fields and ordered `lines` with
supported segment objects. Theme selection and colors belong to Pi.

The optional `version` segment displays the Felan version supplied by the host.
It is not enabled by the package default; hostless consumers omit it when no
version is provided. Felan's local usage provider supplies its application version.

The `subscription` segment supports native OpenAI ChatGPT, Codex, Claude, and
Grok SuperGrok / X Premium OAuth plans. ChatGPT, Codex, and Grok values show
remaining percentage; Claude values show used percentage. Native OpenAI usage
requires both an OpenAI ChatGPT OAuth login and a separate Codex OAuth login
for the same ChatGPT account/workspace (`/login openai-codex`). ChatGPT values
show shared-plan primary/secondary windows only; app-specific quotas are not
displayed. The host uses Codex credentials only for the companion ChatGPT usage
endpoints; it never sends native OpenAI tokens to ChatGPT backend endpoints.
These companion endpoints are undocumented. If the Codex companion is missing
or its app registration cannot be matched, the footer displays
`ChatGPT usage: web only`; users can review usage at
<https://chatgpt.com/settings/usage>. App-registration matching is a safeguard,
not independent proof that the accounts match. Native OpenAI usage is
session-local and is not persisted/shared with Codex usage. The segment can
configure `showProviderName`, `showReset`,
`showPercentage`, and `maxWindows`. It refreshes at startup, after turns and
model changes, and once per minute. Only model changes bypass the 30-second
minimum between requests. For Codex, Claude, and Grok, after HTTP 429 every
refresh waits for the provider's `Retry-After` or an exponential backoff from
one minute up to 30 minutes, and the segment keeps showing the last successful
values whose reset time has not passed. Hosts can pass a `subscriptionStore`,
optionally backed by host-owned persistence, to share those values, the latest
error, and the backoff across sessions, restarts, and processes. A host that coordinates processes returns
`REFRESH_DEFERRED` when another process owns the refresh; the segment then shows
the shared values. Native OpenAI values are neither persisted nor shared across
sessions and clear to the web-only fallback when companion validation fails.
The controller calls `releaseRefreshLease` when the model changes provider or
the session shuts down.

The `savings` segment is enabled by default at the end of the first line and is
right-aligned above the model. It reports estimated API-equivalent savings
across all retained local Felan activity for seven inclusive UTC calendar days
(today plus the six previous days), displayed as
`Est. Savings(7d): $33.00`. Set `periodDays` on the segment to choose another
period. A `~` before the amount means at least one measurement had unavailable
pricing, so the USD total is incomplete. The configured usage provider supplies the query;
the portable package does not access storage itself.

Scalar display settings are available through generated `felan --powerline-*`
options and `/settings`; structured `lines` values are edited as JSON in
`settings.json` or `/settings`.

The package default export obtains optional Models, Usage and Sessions services.
The portable package owns
provider detection, response parsing, caching, throttling, and rendering; the
host owns credential access and provider requests.

A local host can supply usage backed by `ModelRuntime`. It uses the active
provider's Felan OAuth credential and fixed Codex, Anthropic, or xAI Grok Build
billing endpoints. The extension package does not inspect authentication files,
receive stored credential objects, or perform network requests.

## Package boundary and requirements

The root uses optional Agent Core services:

- `felan.models@1` supplies authenticated subscription usage without exposing credentials; the provider shares caching and rate-limit backoff across sessions.
- `felan.usage@1` supplies savings summaries.
- `felan.sessions@1` supplies execution usage totals and execution change events.
- `pi.runtime.host` supplies host version metadata without exposing a runtime factory.

There is no Powerline-specific service. Omitting optional services leaves normal
session/model/context rendering intact and omits unavailable subscription and
savings segments. The root exports portable runtime APIs plus the service-backed
default; `./runtime` exposes explicit runtime composition and `./data` exposes
normalized records. Neither loads footer implementations or Pi-TUI. The package
exports no TUI or view entrypoint; native footer rendering belongs to `apps/felan`.

The package owns width-safe rendering, layout/config validation, Git-cache
behavior, provider detection, response parsing, caching, and throttling. Hosts
own credential access, provider requests, TUI installation, and any extra footer
rows. Only footer construction is TUI-specific; generic data collection and
publication are not gated by client mode or the presence of a footer.

Configured hosts select this package through their extension list. The package
requires a compatible `@felan-ai/agent-core` peer.

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
