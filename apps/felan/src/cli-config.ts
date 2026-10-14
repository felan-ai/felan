import { getExtensionConfigCliOptions, parseExtensionConfigCliValue, type ExtensionConfigCliOption } from '@felan-ai/agent-core';
import { builtinExtensionPackages, loadLocalExtensionConfigDefinitions } from './providers/extensions.js';
import { presentationCliOptions } from './tui/presentation-preferences.js';
import { defaultPresentationPreferences, validatePresentationPreferences, type TuiPresentationPreferences } from './tui/preferences-schema.js';

export type CliConfigOption = ExtensionConfigCliOption & { presentation?: boolean };
export async function cliConfigOptions(): Promise<readonly CliConfigOption[]> {
  const definitions = await loadLocalExtensionConfigDefinitions(Object.values(builtinExtensionPackages));
  return [...getExtensionConfigCliOptions(definitions), ...presentationCliOptions.map(option => ({ ...option, presentation: true }))];
}
export function parseCliConfigValue(option: CliConfigOption, input: string | boolean) {
  const value = parseExtensionConfigCliValue(option, input);
  if (option.presentation) {
    const id = option.extensionId as keyof TuiPresentationPreferences;
    validatePresentationPreferences({ ...defaultPresentationPreferences,
      [id]: { ...defaultPresentationPreferences[id], [option.field]: value } });
  }
  return value;
}
