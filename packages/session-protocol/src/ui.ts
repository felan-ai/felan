import { Type, type Static } from 'typebox';
import { LIMITS, ProtocolValidationError, utf8Bytes } from './limits.js';
import { IdSchema, JsonValueSchema, assertJson, enumOf, parseSchema, text, unboundedText } from './schema.js';

export const UI_CAPABILITIES = ['ui.status', 'ui.progress', 'ui.document', 'ui.view', 'ui.action', 'native.events'] as const;
export const UiCapabilitySchema = enumOf(UI_CAPABILITIES);
export const UiFallbackSchema = unboundedText(1);

const closed = { additionalProperties: false } as const;
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const finiteNumber = Type.Number({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const field = { id: IdSchema, label: unboundedText(1), required: Type.Boolean() };
const options = Type.Array(Type.Object({ id: IdSchema, label: unboundedText(1) }, closed), { minItems: 1 });

export const UiHintSchema = Type.Object({ id: IdSchema, version: text(128, 1), data: Type.Optional(JsonValueSchema) }, closed);
export const UiValuesSchema = Type.Record(IdSchema, Type.Union([
  unboundedText(), finiteNumber, Type.Boolean(), Type.Array(IdSchema, { uniqueItems: true }),
]));
export const UiFieldSchema = Type.Union([
  Type.Object({ ...field, kind: Type.Literal('string'), maxLength: Type.Integer({ minimum: 0 }),
    placeholder: Type.Optional(unboundedText()), multiline: Type.Optional(Type.Boolean()) }, closed),
  Type.Object({ ...field, kind: Type.Literal('boolean') }, closed),
  Type.Object({ ...field, kind: Type.Literal('number'), minimum: Type.Optional(finiteNumber), maximum: Type.Optional(finiteNumber) }, closed),
  Type.Object({ ...field, kind: Type.Literal('enum'), options }, closed),
  Type.Object({ ...field, kind: Type.Literal('multi_select'), options, maxSelections: Type.Integer({ minimum: 1, maximum: 64 }) }, closed),
]);
export const UiInputSchema = Type.Object({
  fields: Type.Array(UiFieldSchema), defaults: Type.Optional(UiValuesSchema),
}, closed);
export const UiActionSchema = Type.Object({
  id: IdSchema, label: unboundedText(1), description: Type.Optional(unboundedText()), destructive: Type.Optional(Type.Boolean()),
  target: enumOf(['element', 'item'] as const), outcome: enumOf(['submit', 'cancel'] as const), input: Type.Optional(UiInputSchema),
}, closed);
export const UiFormSchema = Type.Object({
  title: unboundedText(1), description: Type.Optional(unboundedText()), markdown: Type.Optional(unboundedText()),
  fallback: UiFallbackSchema, input: UiInputSchema,
  actions: Type.Array(UiActionSchema, { minItems: 1 }), hint: Type.Optional(UiHintSchema),
}, closed);
export const UiFormRequestSchema = Type.Object({ kind: Type.Literal('form'), form: UiFormSchema }, closed);
export const UiFormAnswerSchema = Type.Object({
  kind: Type.Literal('form'), actionId: IdSchema, outcome: enumOf(['submit', 'cancel'] as const), values: UiValuesSchema,
}, closed);
export const UiActionRequestSchema = Type.Object({
  elementId: IdSchema, revision, actionId: IdSchema, outcome: enumOf(['submit', 'cancel'] as const),
  itemId: Type.Optional(IdSchema), values: UiValuesSchema,
}, closed);

const presentation = { id: IdSchema, revision, fallback: UiFallbackSchema, hint: Type.Optional(UiHintSchema) };
export const UiDocumentSchema = Type.Object({
  ...presentation, kind: Type.Literal('document'), title: unboundedText(1), markdown: unboundedText(1),
  data: Type.Optional(UiValuesSchema),
  actions: Type.Array(UiActionSchema),
}, { ...closed });
export const UiViewSchema = Type.Object({
  ...presentation, kind: Type.Literal('view'), title: unboundedText(1),
  fields: Type.Array(Type.Object({ id: IdSchema, label: unboundedText(1),
    valueKind: enumOf(['text', 'number', 'boolean', 'date'] as const) }, closed)),
  items: Type.Array(Type.Object({ id: IdSchema, values: Type.Record(IdSchema, Type.Union([
    unboundedText(), finiteNumber, Type.Boolean(),
  ])), fallback: UiFallbackSchema }, closed)),
  actions: Type.Array(UiActionSchema),
  query: Type.Optional(Type.Object({ actionId: IdSchema, values: UiValuesSchema }, closed)),
  paging: Type.Optional(Type.Object({ previousActionId: Type.Optional(IdSchema), nextActionId: Type.Optional(IdSchema) }, closed)),
}, closed);
export const UiProgressSchema = Type.Object({
  ...presentation, kind: Type.Literal('progress'), label: unboundedText(1),
  state: enumOf(['running', 'completed', 'failed', 'cancelled'] as const),
  fraction: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  actions: Type.Array(UiActionSchema),
}, { ...closed });
export const UiStatusValueSchema = Type.Union([
  Type.Object({ kind: Type.Literal('text'), text: unboundedText() }, closed),
  Type.Object({ kind: Type.Literal('tokens'), value: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, closed),
  Type.Object({ kind: Type.Literal('percent'), value: Type.Number({ minimum: 0, maximum: 100 }) }, closed),
  Type.Object({ kind: Type.Literal('money'), value: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    currency: Type.String({ pattern: '^[A-Z]{3}$' }) }, closed),
  Type.Object({ kind: Type.Literal('duration'), milliseconds: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, closed),
]);
export const UiStatusSchema = Type.Object({
  id: IdSchema, kind: Type.Literal('status'), key: IdSchema, value: UiStatusValueSchema,
  severity: Type.Optional(enumOf(['info', 'warning', 'error'] as const)), fallback: UiFallbackSchema, hint: Type.Optional(UiHintSchema),
}, { ...closed });
export const UiPresentationSchema = Type.Union([UiDocumentSchema, UiViewSchema, UiProgressSchema, UiStatusSchema]);

export type UiHint = Static<typeof UiHintSchema>;
export type UiValues = Static<typeof UiValuesSchema>;
export type UiField = Static<typeof UiFieldSchema>;
export type UiInput = Static<typeof UiInputSchema>;
export type UiAction = Static<typeof UiActionSchema>;
export type UiForm = Static<typeof UiFormSchema>;
export type UiFormRequest = Static<typeof UiFormRequestSchema>;
export type UiFormAnswer = Static<typeof UiFormAnswerSchema>;
export type UiActionRequest = Static<typeof UiActionRequestSchema>;
export type UiDocument = Static<typeof UiDocumentSchema>;
export type UiView = Static<typeof UiViewSchema>;
export type UiProgress = Static<typeof UiProgressSchema>;
export type UiStatusValue = Static<typeof UiStatusValueSchema>;
export type UiStatus = Static<typeof UiStatusSchema>;
export type UiPresentation = Static<typeof UiPresentationSchema>;
export type UiActionSource = UiDocument | UiView | UiProgress;

function invalid(message: string): never { throw new ProtocolValidationError('invalid_request', message); }
function unique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) invalid('UI identities must be unique.');
}

function validateValues(input: UiInput, values: UiValues, required: boolean): void {
  const fields = new Map(input.fields.map(value => [value.id, value]));
  if (Object.keys(values).some(key => !fields.has(key))) invalid('UI values contain an undeclared field.');
  for (const field of input.fields) {
    if (!Object.hasOwn(values, field.id)) {
      if (required && field.required) invalid(`UI field ${field.id} is required.`);
      continue;
    }
    const value = values[field.id];
    switch (field.kind) {
      case 'string':
        if (typeof value !== 'string' || utf8Bytes(value) > field.maxLength) invalid('Invalid UI string value.');
        break;
      case 'boolean': if (typeof value !== 'boolean') invalid('Invalid UI boolean value.'); break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value) || field.minimum !== undefined && value < field.minimum
          || field.maximum !== undefined && value > field.maximum) invalid('Invalid UI numeric value.');
        break;
      case 'enum':
        if (typeof value !== 'string' || !field.options.some(option => option.id === value)) invalid('Invalid UI option.');
        break;
      case 'multi_select':
        if (!Array.isArray(value) || value.length > field.maxSelections || new Set(value).size !== value.length
          || value.some(id => !field.options.some(option => option.id === id))) invalid('Invalid UI selections.');
        break;
    }
  }
}

function validateInput(input: UiInput): void {
  unique(input.fields.map(field => field.id));
  for (const field of input.fields) {
    if (field.kind === 'number' && field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) invalid('Invalid UI numeric range.');
    if (field.kind === 'enum' || field.kind === 'multi_select') {
      unique(field.options.map(option => option.id));
      if (field.kind === 'multi_select' && field.maxSelections > field.options.length) invalid('Invalid UI selection bound.');
    }
  }
  if (input.defaults) validateValues(input, input.defaults, false);
}

function validateActions(actions: readonly UiAction[], items: boolean): void {
  unique(actions.map(action => action.id));
  if (actions.filter(action => action.target === 'element').length > 16 || actions.filter(action => action.target === 'item').length > 16) invalid('UI action capacity exceeded.');
  for (const action of actions) {
    if (!items && action.target === 'item') invalid('Item actions require a view.');
    if (action.outcome === 'cancel' && action.input !== undefined) invalid('Cancel actions cannot collect input.');
    if (action.input) validateInput(action.input);
  }
}

function validateMarkdown(markdown: string): void {
  validateUiMarkdown(markdown);
  let inLabel = false;
  for (let index = 0; index < markdown.length; index++) {
    if (markdown[index] === '\\') { index++; continue; }
    if (markdown[index] === '[') { inLabel = true; continue; }
    if (markdown[index] !== ']') continue;
    const definition = inLabel && markdown[index + 1] === ':';
    inLabel = false;
    if (!definition) continue;
    let start = index + 2;
    while (start < markdown.length && /\s/u.test(markdown[start]!)) start++;
    let end = start;
    while (end < markdown.length && !/\s/u.test(markdown[end]!)) end++;
    if (start === end) continue;
    let url: URL;
    try { url = new URL(markdown.slice(start, end)); } catch { invalid('UI reference links must be absolute HTTP(S) URLs.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') invalid('UI reference links must use HTTP(S).');
    index = end - 1;
  }
}

export function parseUiForm(value: unknown): UiForm {
  const form = parseSchema(UiFormSchema, value);
  if (form.hint?.data !== undefined) assertJson(form.hint.data, LIMITS.uiHintBytes);
  validateInput(form.input); validateActions(form.actions, false);
  if (form.actions.some(action => action.input !== undefined)) invalid('Form actions use the form input.');
  if (form.markdown !== undefined) validateMarkdown(form.markdown);
  return form;
}

export function validateUiFormAnswer(form: UiForm, value: unknown): UiFormAnswer {
  const source = parseUiForm(form);
  const answer = parseSchema(UiFormAnswerSchema, value);
  const action = source.actions.find(action => action.id === answer.actionId);
  if (!action || action.outcome !== answer.outcome) invalid('UI form action or outcome mismatch.');
  if (action.outcome === 'cancel') {
    if (Object.keys(answer.values).length) invalid('Cancel actions cannot submit values.');
  } else validateValues(source.input, answer.values, true);
  return answer;
}

export function parseUiPresentation(value: unknown): UiPresentation {
  const source = parseSchema(UiPresentationSchema, value);
  if (source.hint?.data !== undefined) assertJson(source.hint.data, LIMITS.uiHintBytes);
  if (source.kind === 'status') return source;
  validateActions(source.actions, source.kind === 'view');
  if (source.kind === 'document') validateMarkdown(source.markdown);
  if (source.kind === 'view') {
    unique(source.fields.map(field => field.id)); unique(source.items.map(item => item.id));
    const fields = new Map(source.fields.map(field => [field.id, field]));
    for (const item of source.items) for (const [key, value] of Object.entries(item.values)) {
      const kind = fields.get(key)?.valueKind;
      if (!kind || kind === 'text' && typeof value !== 'string' || kind === 'number' && typeof value !== 'number'
        || kind === 'boolean' && typeof value !== 'boolean' || kind === 'date' && (typeof value !== 'string'
          || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))
          || new Date(value).toISOString() !== value)) invalid('UI view values must match declared field kinds.');
    }
    const navigation = (id: string) => {
      const action = source.actions.find(action => action.id === id);
      if (!action || action.target !== 'element' || action.outcome !== 'submit') invalid('Invalid UI navigation action.');
      return action;
    };
    if (source.query) validateValues(navigation(source.query.actionId).input ?? { fields: [] }, source.query.values, false);
    if (source.paging && source.paging.previousActionId === undefined && source.paging.nextActionId === undefined) invalid('UI paging must declare a navigation action.');
    unique([source.query?.actionId, source.paging?.previousActionId, source.paging?.nextActionId].filter((id): id is string => id !== undefined));
    for (const id of [source.paging?.previousActionId, source.paging?.nextActionId]) if (id !== undefined) {
      const action = navigation(id);
      if (action.input?.fields.length) invalid('UI paging actions cannot require client input.');
    }
  }
  return source;
}

export function validateUiAction(source: UiActionSource, value: unknown): UiActionRequest {
  const current = parseUiPresentation(source);
  const request = parseSchema(UiActionRequestSchema, value);
  if (current.kind === 'status') invalid('Status items have no actions.');
  const action = current.actions.find(action => action.id === request.actionId);
  if (current.id !== request.elementId || current.revision !== request.revision || !action) {
    throw new ProtocolValidationError('stale_request', 'UI action is undeclared or its element revision is stale.');
  }
  if (action.outcome !== request.outcome) invalid('UI action outcome mismatch.');
  if (action.target === 'item') {
    if (current.kind !== 'view' || !current.items.some(item => item.id === request.itemId)) invalid('UI action item is not in the current view.');
  } else if (request.itemId !== undefined) invalid('Element actions cannot target an item.');
  validateValues(action.input ?? { fields: [] }, request.values, true);
  return request;
}

export function validateUiMarkdown(markdown: string): void {
  if (/<\/?[a-z][^>]*>/iu.test(markdown)) throw new ProtocolValidationError('invalid_request', 'UI documents cannot contain raw HTML.');
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/gu)) {
    let url: URL;
    try { url = new URL(match[1]!); } catch { throw new ProtocolValidationError('invalid_request', 'UI document links must be absolute HTTP(S) URLs.'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProtocolValidationError('invalid_request', 'UI document links must use HTTP(S).');
  }
}
