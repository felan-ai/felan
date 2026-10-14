# @felan-ai/ext-powerline

Portable Powerline data for client-owned footers. The package
root publishes generic `pi.ui` views and typed statuses in TUI, ACP, and headless
sessions without requiring a presentation service. Optional usage providers add
Codex, Claude, or Grok subscription usage and estimated savings. Footer
construction remains client-side.

Published data includes:

- current directory
- cached Git branch, revision, working-tree status, tag, age, stash, upstream, and repository name
- active model and thinking level
- session token and cost totals (a configured usage provider can include root
  and child sessions; without one, totals cover the active session only)
- active Codex, Claude, or Grok subscription usage
- estimated API-equivalent Felan savings for the configured recent-day period
- context-window usage
- the Felan version when supplied by the host application

Clients choose formatting, symbols, layout, styles, charsets and colors. Git probes
are asynchronous, cached, coalesced, time-bounded, and executed exclusively
through `pi.exec`.

The default entry publishes on `session_start` and refreshes for model,
thinking, agent, turn, tool, compaction, tree, and usage events, plus a 60-second refresh. Its generic
views publish structured segment values, semantic kinds and color roles, without
preformatted footer text, symbols, style or layout. Session
and context metrics also use typed token, percent, and USD statuses. The
optional `felan.powerline@3.0.0` hint changes presentation only; clients without
it can display the same columns, rows, and values. Other extensions' common UI
statuses remain separately available to clients rather than being copied into
Powerline through a feature service.

Shutdown aborts Git probes, usage requests, and pending publication requests,
joins owned work, closes views, and removes statuses. A failed publication stops
refresh timers and preserves a sanitized cleanup failure. Felan's client installs
the optional footer; the extension never constructs terminal components.

Semantic color roles let clients apply their own themes; the extension owns no
terminal palette or theme settings.

## Configuration

The extension declares only data-collection settings under `extensionConfig.powerline`:

```json
{ "showWorkingTree": true, "showStashCount": false, "periodDays": 7, "maxWindows": 3 }
```

Felan's TUI owns style, charset, wrapping, padding, ordered lines, alignment,
color roles and per-segment display choices under `presentation.powerline` in
`$FELAN_AGENT_DIR/tui/settings.json`. It reads released display settings as a
read-only fallback. These preferences never configure the daemon. `/settings`
separates display preferences from execution settings; the old display CLI flags
remain TUI-only launch overrides.

The extension publishes a `version` value when the host supplies one. Clients
decide whether and where to display it. The default Felan TUI footer does not
include a version segment.

The `subscription` segment supports native OpenAI ChatGPT, Codex, Claude, and
Grok SuperGrok / X Premium OAuth plans. ChatGPT, Codex, and Grok values show
remaining percentage; Claude values show used percentage. Native OpenAI usage
requires both an OpenAI ChatGPT OAuth login and a separate Codex OAuth login
for the same ChatGPT account/workspace (`/login openai-codex`). ChatGPT values
show shared-plan primary/secondary windows only; app-specific quotas are not
displayed. The host uses Codex credentials only for the companion ChatGPT usage
endpoints; it never sends native OpenAI tokens to ChatGPT backend endpoints.
These companion endpoints are undocumented. If the Codex companion is missing
or its app registration cannot be matched, the published data reports companion unavailability; clients can display
`ChatGPT usage: web only`; users can review usage at
<https://chatgpt.com/settings/usage>. App-registration matching is a safeguard,
not independent proof that the accounts match. Native OpenAI usage is
session-local and is not persisted/shared with Codex usage. The segment can
configure `showProviderName`, `showReset`,
`showPercentage` in the TUI. Extension `maxWindows` bounds published windows. It refreshes at startup, after turns and
model changes, and once per minute. Only model changes bypass the 30-second
minimum between requests. For Codex, Claude, and Grok, after HTTP 429 every
refresh waits for the provider's `Retry-After` or an exponential backoff from
one minute up to 30 minutes, and the segment keeps showing the last successful
values whose reset time has not passed. Hosts can pass a `subscriptionStore`,
optionally backed by host-owned persistence, to share those values, the latest
error, and the backoff across sessions, restarts, and processes. A host that coordinates processes returns
`REFRESH_DEFERRED` when another process owns the refresh; the extension then publishes
the shared values. Native OpenAI values are neither persisted nor shared across
sessions and clear to the web-only fallback when companion validation fails.
The controller calls `releaseRefreshLease` when the model changes provider or
the session shuts down.

Felan's TUI enables the `savings` segment by default at the end of the first line; it is
right-aligned above the model. It reports estimated API-equivalent savings
across all retained local Felan activity for seven inclusive UTC calendar days
(today plus the six previous days), displayed as
`Est. Savings(7d): $33.00`. Set extension `periodDays` to choose another
period. A `~` before the amount means at least one measurement had unavailable
pricing, so the USD total is incomplete. The configured usage provider supplies the query;
the portable package does not access storage itself.

Display settings are available through TUI-only `felan --powerline-*`
options and `/settings`; structured `lines` values live in `tui/settings.json`.

The package default export obtains optional Models, Usage and Sessions services.
The portable package owns
provider detection, response parsing, caching, and throttling; the
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
session/model/context data intact and omits unavailable subscription and
savings segments. The root exports portable runtime APIs plus the service-backed
default; `./runtime` exposes explicit runtime composition and `./data` exposes
normalized records. Neither loads footer implementations or Pi-TUI. The package
exports no TUI or view entrypoint; native footer rendering belongs to `apps/felan`.

The package owns data validation, Git-cache behavior, provider detection,
response parsing, caching, and throttling. Hosts own credential access and provider
requests. Clients own rendering, symbols, layout and extra footer rows; generic data collection and
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
