# @felan-ai/ext-output-style

Portable output-style instructions for Felan sessions.

The extension appends one clearly bounded `## Output Style` section to the
system prompt before each model run. It accepts only the built-in `concise` and
`explanatory` styles; arbitrary prompt text and file-backed styles are not
supported. `concise` is the default.

```ts
import { createOutputStyleExtension } from '@felan-ai/ext-output-style';

const extension = createOutputStyleExtension('explanatory');
```

The Felan TUI validates its global `outputStyle` setting and binds the selected
style to this extension for root and child sessions.

## Development

Source: `packages/ext-output-style` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-output-style build
pnpm --filter @felan-ai/ext-output-style type-check
pnpm --filter @felan-ai/ext-output-style test
```
