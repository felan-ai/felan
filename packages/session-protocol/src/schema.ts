import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { LIMITS, ProtocolValidationError, utf8Bytes } from './limits.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function enumOf<const T extends readonly [string, ...string[]]>(values: T) {
  return Type.Enum<[...T]>([...values]);
}

export const text = (bytes: number, minLength = 0) => Type.String({ minLength, maxLength: bytes, 'x-maxBytes': bytes });
export const IdSchema = text(LIMITS.idBytes, 1);
export const NameSchema = text(LIMITS.commandBytes, 1);
export const PathSchema = Type.String({ minLength: 1, maxLength: LIMITS.pathBytes, pattern: '^[^\u0000]+$', 'x-maxBytes': LIMITS.pathBytes });
export const AbsolutePathSchema = Type.String({ ...PathSchema, pattern: '^(?:/|[a-zA-Z]:[\\\\/]|\\\\\\\\)[^\u0000]*$' });
export const CounterSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const RevisionSchema = CounterSchema;
export const ClientKindSchema = enumOf(['tui', 'acp', 'headless'] as const);
export const ThinkingSchema = enumOf(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const);
export const ModelSchema = Type.Object({ provider: IdSchema, id: IdSchema });
export const CursorSchema = text(4096, 1);
export const PageRequestSchema = Type.Object({ cursor: Type.Optional(CursorSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.pageEntries })) });
export const DiagnosticTextSchema = Type.String({ ...text(4096), pattern: '^[^\u0000-\u001f\u007f-\u009f]*$' });
export const JsonValueSchema = Type.Unsafe<JsonValue>(Type.Unknown({
  'x-jsonValue': true, 'x-maxEncodedBytes': LIMITS.structuredBytes, 'x-maxCollectionEntries': LIMITS.catalogEntries,
}));

export const DaemonTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal('production') }),
  Type.Object({ kind: Type.Literal('isolated'), runtimeDir: AbsolutePathSchema, fixtureRoot: AbsolutePathSchema }),
]);
export const DaemonIdentitySchema = Type.Object({
  namespaceId: IdSchema, instanceId: IdSchema, agentDir: AbsolutePathSchema,
  rootSet: Type.Array(AbsolutePathSchema, { minItems: 1, maxItems: LIMITS.catalogEntries, uniqueItems: true }),
});
export type DaemonTarget = Static<typeof DaemonTargetSchema>;
export type DaemonIdentity = Static<typeof DaemonIdentitySchema>;

export function assertJson(value: unknown, maxBytes = LIMITS.frameBytes): asserts value is JsonValue {
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > LIMITS.depth) throw new ProtocolValidationError('invalid_request', 'JSON nesting limit exceeded');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (!wellFormed(item)) throw new ProtocolValidationError('invalid_request', 'Invalid Unicode string');
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || ancestors.has(item)) {
      throw new ProtocolValidationError('invalid_request', 'Expected finite, acyclic JSON data');
    }
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new ProtocolValidationError('invalid_request', 'Expected plain JSON objects');
    }
    ancestors.add(item);
    for (const key of Object.keys(item)) {
      if (!wellFormed(key) || key === '__proto__') {
        throw new ProtocolValidationError('invalid_request', 'Unsafe JSON property');
      }
      const property = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in property)) throw new ProtocolValidationError('invalid_request', 'Expected JSON data properties');
      visit(property.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  if (utf8Bytes(JSON.stringify(value)) > maxBytes) throw new ProtocolValidationError('invalid_request', 'Encoded data limit exceeded');
}

function wellFormed(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

type SchemaNode = TSchema & {
  type?: string; const?: unknown; enum?: unknown[]; required?: string[];
  'x-jsonValue'?: boolean; 'x-maxBytes'?: number; 'x-maxEncodedBytes'?: number; 'x-maxCollectionEntries'?: number; anyOf?: SchemaNode[];
  items?: SchemaNode; properties?: Record<string, SchemaNode>; patternProperties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
};

const patterns = new Map<string, RegExp>();

function matchesDiscriminants(schema: SchemaNode, value: unknown): boolean {
  if (schema.anyOf && !schema.anyOf.some(branch => matchesDiscriminants(branch, value))) return false;
  if (Object.hasOwn(schema, 'const') && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'array' && !Array.isArray(value)) return false;
  if (schema.type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) return false;
  if (schema.type === 'null' && value !== null) return false;
  if (['string', 'boolean', 'number'].includes(schema.type ?? '') && typeof value !== schema.type) return false;
  if (schema.properties && value !== null && typeof value === 'object') {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && (Object.hasOwn(child, 'const') || child.enum) &&
        !matchesDiscriminants(child, (value as Record<string, unknown>)[key])) return false;
    }
  }
  return true;
}

function selectBranch(schema: SchemaNode, value: unknown, validated: boolean): SchemaNode {
  const candidates = (schema.anyOf ?? [schema]).filter(branch => matchesDiscriminants(branch, value));
  if (validated && candidates.length === 1) return candidates[0]!;
  const match = candidates.find(branch => Value.Check(branch, value));
  if (!match) throw new ProtocolValidationError('invalid_request', 'Schema validation failed');
  return match;
}

function enforceLimits(schema: SchemaNode, value: unknown): void {
  if (typeof schema['x-maxBytes'] === 'number' && typeof value === 'string' && utf8Bytes(value) > schema['x-maxBytes']) {
    throw new ProtocolValidationError('invalid_request', 'UTF-8 field limit exceeded');
  }
  if (typeof schema['x-maxEncodedBytes'] === 'number' && utf8Bytes(JSON.stringify(value)) > schema['x-maxEncodedBytes']) {
    throw new ProtocolValidationError('invalid_request', 'Encoded field limit exceeded');
  }
}

function checkJsonCollections(value: unknown, maxEntries: number): void {
  if (value === null || typeof value !== 'object') return;
  const values = Array.isArray(value) ? value : Object.values(value);
  if (values.length > maxEntries) throw new ProtocolValidationError('invalid_request', 'JSON collection limit exceeded');
  for (const child of values) checkJsonCollections(child, maxEntries);
}

function normalize(schema: SchemaNode, value: unknown): unknown {
  enforceLimits(schema, value);
  if (schema['x-jsonValue']) {
    if (typeof schema['x-maxCollectionEntries'] === 'number') checkJsonCollections(value, schema['x-maxCollectionEntries']);
    return JSON.parse(JSON.stringify(value));
  }
  if (schema.anyOf) return normalize(selectBranch(schema, value, true), value);
  if (Array.isArray(value) && schema.items) return value.map(item => normalize(schema.items!, item));
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    const entries: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) {
      let childSchema = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      for (const [pattern, candidate] of Object.entries(schema.patternProperties ?? {})) {
        let regex = patterns.get(pattern);
        if (!regex) { regex = new RegExp(pattern); patterns.set(pattern, regex); }
        if (regex.test(key)) { childSchema = candidate; break; }
      }
      if (childSchema) entries.push([key, normalize(childSchema, child)]);
      else if (typeof schema.additionalProperties === 'object') entries.push([key, normalize(schema.additionalProperties, child)]);
      else if (schema.additionalProperties === true) entries.push([key, JSON.parse(JSON.stringify(child))]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

export function parseSchema<const S extends TSchema>(schema: S, value: unknown): Static<S> {
  assertJson(value);
  const node = schema as SchemaNode;
  const selected = node.anyOf ? selectBranch(node, value, false) : node;
  if (!node.anyOf && !Value.Check(node, value)) throw new ProtocolValidationError('invalid_request', 'Schema validation failed');
  if (node !== selected) enforceLimits(node, value);
  return normalize(selected, value) as Static<S>;
}
