import {
  DefaultResourceLoader,
  SettingsManager,
  type InlineExtension,
  type ResourceLoader,
  type Skill,
} from '@earendil-works/pi-coding-agent';
import { collectCapabilities, formatCapabilitiesSection } from './capabilities.js';
import { FELAN_BASE_SYSTEM_PROMPT } from './system-prompt.js';

export const runtimeToolsExtensionName = '@felan-ai/agent-core/runtime-tools';
const runtimeToolsExtensionPath = `<inline:${runtimeToolsExtensionName}>`;

export interface CreateAgentCoreResourceLoaderOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly extensionFactories: readonly InlineExtension[];
  readonly skillPaths?: readonly string[];
  readonly skills?: readonly Skill[];
  readonly appendSystemPrompt?: readonly string[];
}

interface CreateAgentCoreResourceLoaderInternalOptions extends CreateAgentCoreResourceLoaderOptions {
  readonly contextFiles?: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

export async function createAgentCoreResourceLoader(
  options: CreateAgentCoreResourceLoaderOptions,
): Promise<ResourceLoader> {
  return createAgentCoreResourceLoaderWithContextFiles(options);
}

export async function createAgentCoreResourceLoaderWithContextFiles(
  options: CreateAgentCoreResourceLoaderInternalOptions,
): Promise<ResourceLoader> {
  const skills = options.skills === undefined ? undefined : [...options.skills];
  const contextFiles = (options.contextFiles ?? []).map((file) => ({ ...file }));
  const consumerAppends = (options.appendSystemPrompt ?? []).filter((prompt) => prompt.trim().length > 0);
  const resourceSettings = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: resourceSettings,
    additionalExtensionPaths: [],
    additionalSkillPaths: [...(options.skillPaths ?? [])],
    additionalPromptTemplatePaths: [],
    additionalThemePaths: [],
    extensionFactories: [...options.extensionFactories],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: FELAN_BASE_SYSTEM_PROMPT,
    appendSystemPrompt: [],
    ...(skills === undefined
      ? {}
      : {
          skillsOverride: () => ({
            skills,
            diagnostics: [],
          }),
        }),
    agentsFilesOverride: () => ({
      agentsFiles: contextFiles,
    }),
    systemPromptOverride: () => FELAN_BASE_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => {
      const capabilities = formatCapabilitiesSection(collectCapabilities(options.extensionFactories));
      return [...(capabilities === undefined ? [] : [capabilities]), ...consumerAppends];
    },
  });

  await loader.reload();
  const extensionsResult = loader.getExtensions();
  const actionableErrors = extensionsResult.errors.filter(({ path, error }) => (
    path !== runtimeToolsExtensionPath || !error.startsWith('Tool "')
  ));
  extensionsResult.errors.splice(0, extensionsResult.errors.length, ...actionableErrors);
  if (extensionsResult.errors.length > 0) {
    const first = extensionsResult.errors[0]!;
    throw new Error(`${first.path}: ${first.error}`);
  }

  return loader;
}
