# Contributing

## Setup

Use Node.js 22.20.0 and pnpm 9.15.5. Felan packages support Node.js 22.19.0
or newer, but the repository toolchain is pinned to 22.20.0.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

## Changes

- Read the [documentation hub](docs/README.md) and
  [maintainer architecture map](docs/maintainers/architecture-map.md) before
  changing a shared package or runtime boundary.
- Keep runtime contracts independent of concrete host, Docker, and Daytona adapters.
- Add conformance coverage when the runtime contract changes.
- Keep extension packages free of direct filesystem and child-process access.
- Keep local-host policy, credentials, storage, and presentation in `apps/tui`.
- Keep feature behavior in its owning `packages/ext-*` package and public
  runtime composition in `packages/agent-core`.
- Update the owning package README and the relevant canonical docs page when a
  public behavior or configuration changes.
- Run the changed workspace's `build`, `type-check`, and `test`; run
  `pnpm verify` for cross-package or release-facing changes.
- Use Conventional Commit messages when maintainers request a commit.

For package versioning, trusted publishing, and packed audits, follow the
[release process](docs/maintainers/releasing.md). For adapted extensions, keep
the [upstream review baselines](docs/maintainers/upstream-extensions.md) and
package `NOTICE` files current.

By contributing, you agree that your contributions are licensed under the MIT License.
