import { ConfigValuesSchema, parseSchema } from '@felan-ai/session-protocol';

export interface CliConfigOption {
  name: string;
  type: 'boolean' | 'number' | 'string' | 'json';
  values?: string[];
}

export const cliConfigOptions: readonly CliConfigOption[] = Object.entries(ConfigValuesSchema.properties)
  .filter(([name]) => name.includes('-'))
  .map(([name, schema]) => {
    const choices: unknown = Reflect.get(schema, 'enum');
    const values = Array.isArray(choices) && choices.every(value => typeof value === 'string') ? choices.filter((value): value is string => typeof value === 'string') : undefined;
    const kind: unknown = Reflect.get(schema, 'type');
    const type = kind === 'boolean' ? 'boolean' : kind === 'number' || kind === 'integer' ? 'number'
      : kind === 'string' || values ? 'string' : 'json';
    return { name, type, ...(values ? { values } : {}) };
  });

export function parseCliConfigValue(option: CliConfigOption, raw: string | boolean): unknown {
  let value: unknown = raw;
  if (option.type === 'number') value = Number(raw);
  else if (option.type === 'boolean' && typeof raw === 'string') {
    if (raw !== 'true' && raw !== 'false') throw new Error(`--${option.name} requires true or false`);
    value = raw === 'true';
  } else if (option.type === 'json' && typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { value = raw; }
  }
  return Reflect.get(parseSchema(ConfigValuesSchema, { [option.name]: value }), option.name);
}
