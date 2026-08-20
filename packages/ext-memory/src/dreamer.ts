export {
  createMemoryDreamerInstructions,
  createMemorySchemaMarkdown,
} from './schema.js';

export interface MemoryDreamWorkspace {
  readonly memoryPath: string;
  readonly inputPath: string;
}
