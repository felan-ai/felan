# Felan

Felan is an MIT-licensed monorepo for the portable Felan agent runtime contract,
shared agent core, first-party Pi extensions, and local terminal application.

## Packages

- `@felan-ai/agent-core`: portable runtime contracts, Node.js host runtime, and generic session composition
- `@felan-ai/ext-subagents`: canonical tracked subagent tools over an application-owned host
- `@felan-ai/ext-tasks`: dependency-aware task tracking shared by a root session and its subagents
- `@felan-ai/ext-context`: runtime-portable progressive loading of nested project instructions
- `@felan-ai/ext-prewalk`: prewalk extension package
- `@felan-ai/ext-background-bash`: runtime-portable detached Bash processes for non-OpenAI models
- `@felan-ai/ext-codex`: GPT-only structured command, patch, and image tools with OpenAI Responses controls
- `@felan-ai/ext-powerline`: ANSI-aware local TUI footer with cached Git, model, session, context, and extension status segments
- `@felan-ai/felan`: account-free local terminal application with the `felan` binary

The local terminal application composes the host runtime and source-controlled
extension set around Agent Core. `@felan-ai/ext-powerline` is enabled by default
only in the local TUI and remains inert in headless modes. Felan settings and
state live under `~/.felan`; built-in extensions are configurable there, while
external extensions remain disabled.

Agent Core owns Felan's base system prompt and assembles enabled extension
capabilities before application appends, explicit Agent Skills, and the current
working directory. The local application supports one optional
`$FELAN_AGENT_DIR/APPEND_SYSTEM.md` append file.

Extensions consume one app-provided Agent Core instance through a
compatible-minor peer dependency. Their workspace development dependency keeps
source builds and tests on the repository's current Core version without
installing a second runtime copy in packed applications.

## Requirements

- Node.js 22.20.0 for development and CI; packages support Node.js >=22.19.0
- pnpm 9.15.5

## Development

```sh
corepack enable
pnpm install
pnpm verify
```

After installation, run `felan` for the interactive local agent or
`felan --diagnostics` for runtime versions. Local model credentials are managed
through the TUI and do not require a Felan account.

See [Contributing](CONTRIBUTING.md) and [Release process](docs/releasing.md).
The release process includes packed clean-install, clean audit, extension
boundary, and parameterized `felan`/`felan-cli` co-installation gates.

## License

[MIT](LICENSE)
