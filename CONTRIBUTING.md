# Contributing

## Setup

Use Node.js 22.23.4 and pnpm 9.15.5. Felan packages support Node.js 22.19.0
or newer, but the repository toolchain is pinned to 22.23.4.

```sh
corepack enable
pnpm install --frozen-lockfile
scripts/test-isolated.sh pnpm verify
```

## Changes

- Read the [documentation hub](docs/README.md) and
  [maintainer architecture map](docs/maintainers/architecture-map.md) before
  changing a shared package or runtime boundary.
- Keep runtime contracts independent of concrete host, Docker, and Daytona adapters.
- Add conformance coverage when the runtime contract changes.
- Keep extension packages free of direct filesystem and child-process access.
- Keep canonical storage, admission and execution lifetime in `apps/daemon`.
  Local providers in `apps/felan` own host policy, credentials and runtime
  composition; clients own CLI/TUI, ACP and headless presentation. The daemon
  must not depend on the client application or extension implementations.
- Keep feature behavior in its owning `packages/ext-*` package and public
  runtime composition in `packages/agent-core`.
- Update the owning package README and the relevant canonical docs page when a
  public behavior or configuration changes.
- Run the changed workspace's `build`, `type-check`, and `test`; run
  `scripts/test-isolated.sh pnpm verify` for cross-package or release-facing
  changes. Run daemon and client tests only through `scripts/test-isolated.sh`.
- Root `pnpm test` runs every workspace suite in one Vitest process with a
  shared worker pool; `pnpm test -- --project <package name>` selects packages.
  Use `pnpm test -- --maxWorkers=2` for lower CPU usage. Run local repetitions
  serially rather than emulating concurrent CI jobs on a shared machine.
  Files named `*.perf.test.ts` run only through `pnpm test:perf`. Run Supabase
  suites through `pnpm --filter @felan-ai/daemon test:integration` and built-package
  smokes through `pnpm test:dist`.
  The [test audit](docs/maintainers/test-audit.md) records the reduction and
  reliability decisions and their verification.
- For terminal theme work, run `pnpm theme:preview`, review both light and dark
  states at wide and narrow widths, and run `pnpm theme:preview:check`.
- Use Conventional Commit messages when maintainers request a commit.

For package versioning, trusted publishing, and packed audits, follow the
[release process](docs/maintainers/releasing.md). For adapted extensions, keep
the [upstream review baselines](docs/maintainers/upstream-extensions.md) and
package `NOTICE` files current.

By contributing, you agree that your contributions are licensed under the MIT License.
