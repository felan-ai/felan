# Contributing

## Setup

Use Node.js 22.20.0 and pnpm 9.15.5.

```sh
corepack enable
pnpm install
pnpm verify
```

## Changes

- Keep runtime contracts independent of concrete host, Docker, and Daytona adapters.
- Add conformance coverage when the runtime contract changes.
- Keep extension packages free of direct filesystem and child-process access.
- Use Conventional Commit messages when maintainers request a commit.

By contributing, you agree that your contributions are licensed under the MIT License.
