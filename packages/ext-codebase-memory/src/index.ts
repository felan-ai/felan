import { createCodebaseMemoryExtension as createRuntimeExtension, type CodebaseMemoryExtensionOptions } from './runtime.js';
import { createCodebaseMemoryToolPresentation } from './tui.js';
export * from './runtime.js';

export function createCodebaseMemoryExtension(options: CodebaseMemoryExtensionOptions = {}) {
  return createRuntimeExtension({ ...options, toolPresentation: options.toolPresentation ?? createCodebaseMemoryToolPresentation });
}

export default createCodebaseMemoryExtension();
