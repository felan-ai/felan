# Felan

Felan is an MIT-licensed monorepo for the portable Felan agent runtime contract,
shared agent core, first-party Pi extensions, and local terminal application.

## Packages

- `@felan-ai/agent-core`: portable runtime contracts, Node.js host runtime, and runtime test kit
- `@felan-ai/ext-context`: runtime-portable progressive loading of nested project instructions
- `@felan-ai/ext-prewalk`: prewalk extension package
- `@felan-ai/ext-powerline`: ANSI-aware local TUI footer with cached Git, model, session, context, and extension status segments
- `@felan-ai/felan`: account-free local terminal application with the `felan` binary

The local terminal application composes the host runtime and source-controlled
extension set around Agent Core. `@felan-ai/ext-powerline` is enabled by default
only in the local TUI and remains inert in headless modes.

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
