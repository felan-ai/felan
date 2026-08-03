import {
  DefaultResourceLoader,
  SettingsManager,
  type InlineExtension,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';

export interface CreateAgentCoreResourceLoaderOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly extensionFactories: readonly InlineExtension[];
  readonly extensionFlagValues?: ReadonlyMap<string, boolean | string>;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
}

export async function createAgentCoreResourceLoader(
  options: CreateAgentCoreResourceLoaderOptions,
): Promise<ResourceLoader> {
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
    additionalSkillPaths: [],
    additionalPromptTemplatePaths: [],
    additionalThemePaths: [],
    extensionFactories: [...options.extensionFactories],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: [...options.appendSystemPrompt] }),
  });

  await loader.reload();
  const extensionsResult = loader.getExtensions();
  if (extensionsResult.errors.length > 0) {
    const first = extensionsResult.errors[0]!;
    throw new Error(`${first.path}: ${first.error}`);
  }

  applyExtensionFlagValues(loader, options.extensionFlagValues);
  return loader;
}

function applyExtensionFlagValues(
  loader: ResourceLoader,
  values?: ReadonlyMap<string, boolean | string>,
): void {
  if (!values) return;

  const extensionsResult = loader.getExtensions();
  const registeredFlags = new Map<string, 'boolean' | 'string'>();
  for (const extension of extensionsResult.extensions) {
    for (const [name, flag] of extension.flags) {
      registeredFlags.set(name, flag.type);
    }
  }

  for (const [name, value] of values) {
    const type = registeredFlags.get(name);
    if (!type) throw new Error(`Unknown extension flag: ${name}`);
    if (type !== typeof value) {
      throw new Error(`Extension flag ${name} requires a ${type} value`);
    }
    extensionsResult.runtime.flagValues.set(name, value);
  }
}
