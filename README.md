# Felan

Felan is an MIT-licensed monorepo for the portable Felan agent runtime contract,
shared agent core, first-party Pi extensions, and local terminal application.

## Packages

- `@felan-ai/agent-core`: portable runtime contracts, Node.js host runtime, and runtime test kit
- `@felan-ai/ext-context`: progressive-context extension package
- `@felan-ai/ext-prewalk`: prewalk extension package
- `@felan-ai/ext-powerline`: terminal powerline extension package
- `@felan-ai/felan`: local terminal application package

The extension and terminal packages are compile-safe foundations for their
respective implementation stories.

## Requirements

- Node.js 22.20.0 for development and CI; packages support Node.js >=22.19.0
- pnpm 9.15.5

## Development

```sh
corepack enable
pnpm install
pnpm verify
```

See [Contributing](CONTRIBUTING.md) and [Release process](docs/releasing.md).

## License

[MIT](LICENSE)
