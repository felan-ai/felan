import { registerExecutionTools } from './execution-tools.js';
import { createCodebaseMemoryToolPresentation } from './tui.js';

export function registerTools(...args: Parameters<typeof registerExecutionTools>): void {
  registerExecutionTools(args[0], args[1], args[2], args[3], args[4], args[5] ?? createCodebaseMemoryToolPresentation);
}
