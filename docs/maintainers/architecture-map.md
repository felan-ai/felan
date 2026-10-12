# Maintainer architecture map

Use this map before changing a shared contract. Felan's ownership direction is:

```text
apps/felan (CLI/TUI, ACP, headless)
        |
        v
apps/daemon (local host, policy, profiles, execution, storage)
        |
        v
packages/ext-* (portable feature behavior and host interfaces)
        |
        v
packages/agent-core (runtime-neutral contracts and Pi composition)
        |
        v
pinned @earendil-works/pi-* packages
```

## Where to start

| Change | Start here | Canonical documentation | Required verification |
| --- | --- | --- | --- |
| Local CLI, dependency onboarding, TUI, ACP, headless | `apps/felan/src` | [Local CLI](../user-guide/local-cli.md), [Configuration](../user-guide/configuration.md) | `pnpm --filter @felan-ai/felan build`, `type-check`, `test` |
| Session server, local profile, settings, credentials, storage, execution | `apps/daemon/src` | [Distribution boundary](../decisions/0025-separate-daemon-and-client-distributions.md), [Runtime/security](../concepts/runtime-and-security.md) | `pnpm --filter @felan-ai/daemon build`, `type-check`, `test` |
| Runtime paths, process/PTY, coding tools, base prompt, Pi exports | `packages/agent-core/src` | [Architecture](../concepts/architecture.md), [`agent-core` README](../../packages/agent-core/README.md) | Agent Core build, type-check, test; then affected applications |
| One portable feature | owning `packages/ext-*/src` | [Extension catalog](../reference/extension-catalog.md), package README, [security](../concepts/runtime-and-security.md) | Changed package build, type-check, test |
| Local memory scheduling/publication | `apps/daemon/src/memory` plus `packages/ext-memory/src` | [Local memory architecture](../concepts/local-memory.md) | Daemon, client and memory package suites |
| Upstream adaptation or provenance | package `NOTICE`, `docs/maintainers/upstream-extensions.md` | [Upstream reviews](upstream-extensions.md) | License checks and affected package suite |
| Published package version or dependency | package manifest and `scripts/package-paths.mjs` | [Release process](releasing.md) | `pnpm verify`, packed audit, release workflow |
| Competitive claim | `docs/comparisons/` | [Comparison methodology](../comparisons/methodology.md) | Verify official source, reviewed baseline, and local links |

## Repository checks

TUI, ACP, and headless are daemon clients. The daemon owns local state, policy,
and execution; clients own presentation and themes. The pinned Pi SDK
transitively includes `pi-tui`, so no terminal-free daemon payload is claimed.
See the [implementation handoff](session-daemon-implementation.md).

The normal repository gates are:

```sh
pnpm check:licenses
pnpm build
pnpm type-check
pnpm test
pnpm pack:all
pnpm test:packed-bin
```

`pnpm verify` runs the complete cross-package suite. Use the changed
workspace's individual build, type-check, and test commands while iterating.

## Documentation ownership

- Root `README.md`: product positioning and first successful run.
- `docs/user-guide/`: local workflows and configuration.
- `docs/concepts/`: architecture, security, and memory design.
- `docs/reference/`: extension and dependency catalogues.
- Package README: public package API, host boundary, constraints, and package
  development.
- `docs/comparisons/`: dated external claims and methodology.
- `docs/maintainers/`: release, provenance, and source maps.

Avoid copying implementation detail into the root README. Link to the
authoritative topic or package document instead.
