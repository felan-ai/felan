import { associateExtensionConfig, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createOutputStyleExtension, DEFAULT_OUTPUT_STYLE, OUTPUT_STYLE_CONFIG, parseOutputStyle, resolveCustomOutputStyleSource } from './index.js';
import { loadOutputStyleInstructions } from './instructions.js';
export * from './index.js';

const extension = Object.assign((pi: FelanExtensionAPI) => {
  const style = parseOutputStyle(pi.config?.style ?? DEFAULT_OUTPUT_STYLE);
  if (style !== 'custom') return createOutputStyleExtension(style)(pi);
  const source = resolveCustomOutputStyleSource(pi.config?.instructions, pi.config?.instructionsFile);
  if (source.kind === 'inline') return createOutputStyleExtension(style, source.instructions)(pi);
  if (source.path.includes('\0')) throw new Error('outputStyle.instructionsFile must not contain NUL bytes');
  return loadOutputStyleInstructions({ runtime: pi.runtime, agentDir: pi.agentDir, path: source.path })
    .then(instructions => createOutputStyleExtension(style, instructions)(pi));
}, {
  serviceRequirements: {},
}) as ConfiguredFelanExtension;

associateExtensionConfig(extension, OUTPUT_STYLE_CONFIG);
export default extension;
