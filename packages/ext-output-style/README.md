# @felan-ai/ext-output-style

Portable output-style instructions for Felan sessions.

The extension appends one clearly bounded `## Output Style` section to the
system prompt before each model run. It provides the built-in `concise`,
`explanatory`, and `caveman` styles plus a `custom` style for caller-provided
instructions. `concise` is the default. File-backed styles are not supported.

```ts
import { createOutputStyleExtension } from '@felan-ai/ext-output-style';

const extension = createOutputStyleExtension('explanatory');
const caveman = createOutputStyleExtension('caveman');
const experiment = createOutputStyleExtension('custom', 'Answer in one compact paragraph.');
```

Felan declares the style as `extensionConfig.outputStyle.style`. Custom
instructions use `extensionConfig.outputStyle.instructions`:

```json
{
  "extensionConfig": {
    "outputStyle": {
      "style": "custom",
      "instructions": "Answer in one compact paragraph without omitting blockers."
    }
  }
}
```

The local TUI, CLI, `/settings`, and Agent Core consumers resolve these fields
before activating the extension for root and child sessions. A custom style
requires non-empty instructions.

## Package boundary and requirements

The package owns the supported style names, built-in instructions, custom-text
validation, and prompt-section formatting. A host owns style selection,
built-in enablement, and session lifecycle. The package requires a compatible
`@felan-ai/agent-core` peer and does not read settings, prompt files, or ambient
resources itself.

## Development

Source: `packages/ext-output-style` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-output-style build
pnpm --filter @felan-ai/ext-output-style type-check
pnpm --filter @felan-ai/ext-output-style test
```

## Related documentation

- [Configuration](../../docs/user-guide/configuration.md#output-style)
- [Extension catalog](../../docs/reference/extension-catalog.md)
- [Architecture](../../docs/concepts/architecture.md)

## Attribution

This package is original Felan project code. See [NOTICE](NOTICE) and
[LICENSE](LICENSE).
