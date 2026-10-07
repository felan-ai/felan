import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
export const requiredProfiles = {
  planning: { provider: 'openai-codex', models: ['gpt-6.1-sol'], thinking: ['high', 'xhigh'] },
  implementation: { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'medium' },
};
export const requiredPolicy = {
  provider: 'openai-codex', models: ['gpt-6.1-sol', 'gpt-6-luna'], startingThinking: 'high',
  classifier: { provider: 'typesafe', model: 'jev-latest' },
  extensions: ['@felan-ai/ext-codex', '@felan-ai/ext-tasks', '@felan-ai/ext-prewalk', '@felan-ai/ext-subagents'],
  prewalk: { entryApproval: 'allow', planReview: 'skip', targetModel: 'low', targetThinking: 'medium', restorePlanner: true },
};
const SAFE_VALUES = new Set([...requiredPolicy.models, requiredPolicy.provider, 'high', 'xhigh', 'medium', 'low', 'off', 'minimal', 'USD', 'order-created', 'unchanged', 'changed']);
const SAFE_FIELDS = new Set(['subtotal', 'discount', 'tax', 'shipping', 'total', 'tax105', 'vipDiscount1000', 'availableA', 'shippingUS', 'currency', 'eventName']);
export function safeVerifierValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000 ? value : '[redacted]';
  if (typeof value === 'string') return SAFE_VALUES.has(value) ? value : '[redacted]';
  if (depth >= 2) return '[omitted]';
  if (Array.isArray(value)) return value.slice(0, 8).map(item => safeVerifierValue(item, depth + 1));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => SAFE_FIELDS.has(key)).slice(0, 8)
      .map(([key, child]) => [key, safeVerifierValue(child, depth + 1)]));
  }
  return '[redacted]';
}
function verifierFailure(check, message, expected, actual) {
  const error = new Error(message);
  error.safeCheck = check;
  error.safeExpected = safeVerifierValue(expected);
  error.safeActual = safeVerifierValue(actual);
  throw error;
}
function requireCheck(condition, check, message, expected, actual) {
  if (!condition) verifierFailure(check, message, expected, actual);
}
function checkProfiles(result, id) {
  assert.ok(['disabled', 'shared', 'separated'].includes(result.mode), 'Unknown benchmark arm');
  assert.ok(requiredPolicy.models.includes(result.config.startingModel), 'Starting model is outside the pinned scope');
  assert.deepEqual(result.config, { ...requiredPolicy, startingModel: result.config.startingModel,
    mode: result.mode, dynamicThinking: true, sessionMode: 'rpc' }, 'Benchmark policy differs from the fixture requirements');
  const inferences = result.phases.filter(row => row.kind === 'inference');
  requireCheck(inferences.some(row => row.scope === 'root'), 'inference.root.present', 'Missing root inference evidence', true, false);
  for (const row of inferences) {
    assert.ok(['root', 'child'].includes(row.scope), 'Unknown inference scope');
    assert.equal(row.provider, requiredPolicy.provider, 'Inference provider is outside the authenticated scope');
    assert.ok(requiredPolicy.models.includes(row.model), 'Inference model is outside the pinned scope');
    assert.ok(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(row.thinking), 'Missing or invalid inference effort');
    assert.ok(row.phase === null || /^pi-prewalk:[a-z-]+$/.test(row.phase), 'Missing or invalid inference phase');
    if (row.phase === 'pi-prewalk:planning') {
      requireCheck(requiredProfiles.planning.models.includes(row.model), 'inference.planning.model', 'Planning requires the pinned capable model', requiredProfiles.planning.models, row.model);
      requireCheck(requiredProfiles.planning.thinking.includes(row.thinking), 'inference.planning.effort', 'Planning inference is below the high-effort floor', requiredProfiles.planning.thinking, row.thinking);
    }
    if (row.phase === 'pi-prewalk:implementation') {
      requireCheck(row.model === requiredProfiles.implementation.model, 'inference.implementation.model', 'Implementation must honor the configured low target', requiredProfiles.implementation.model, row.model);
      requireCheck(row.thinking === requiredProfiles.implementation.thinking, 'inference.implementation.effort', 'Implementation must honor configured effort', requiredProfiles.implementation.thinking, row.thinking);
    }
  }
  if (id === 'implementation' && result.mode !== 'disabled') {
    for (const phase of ['planning', 'implementation']) requireCheck(inferences.some(row => row.scope === 'root'
      && row.phase === `pi-prewalk:${phase}`), `inference.root.${phase}.present`, `Missing root ${phase} inference evidence`, true, false);
  }
}
export function checkMetadata(result, id) {
  assert.equal(result.schemaVersion, 1, 'metadata: unsupported result schema');
  assert.equal(result.status, 'completed', 'metadata: agent driver did not complete');
  assert.equal(result.id, id, 'metadata: scenario identity mismatch');
  assert.ok(result.source.imageId && result.source.source.commit && result.source.digest, 'metadata: source provenance missing');
  assert.equal(result.fixture.version, 'v1', 'metadata: fixture version mismatch');
  assert.ok(result.fixture.fileCount >= 20, 'metadata: fixture file inventory is incomplete');
  assert.match(result.fixture.digest, /^[a-f0-9]{64}$/u, 'metadata: fixture digest is invalid');
  assert.equal(result.config.startingThinking, 'high', 'metadata: starting effort must be high');
  assert.equal(result.config.sessionMode, 'rpc', 'metadata: persistent RPC session required');
  assert.equal(result.config.prewalk.entryApproval, 'allow', 'metadata: entry approval policy changed');
  assert.equal(result.config.prewalk.planReview, 'skip', 'metadata: plan review policy changed');
  assert.equal(result.counts.classifierProviderRequests, result.classifierRequests.length, 'metadata: classifier request accounting mismatch');
  assert.equal(result.usage.combined.costUsd, null, 'metadata: unknown subscription cost must not be represented as known');
  assert.ok(result.timing.inputToFirstOutputMs === null || result.timing.inputToFirstOutputMs >= 0, 'metadata: invalid first-output timing');
  checkProfiles(result, id);
  if (result.mode === 'disabled') {
    assert.equal(result.classifierRequests.length, 0, 'metadata: disabled arm dispatched classifier requests');
    assert.equal(result.classifications.length, 0, 'metadata: disabled arm recorded classifications');
  } else if (id !== 'recovery') {
    assert.ok(result.classifierRequests.length > 0, 'metadata: configured classifier did not dispatch');
    assert.ok(result.classifications.some(row => row.questionIds.some(id => id.includes(':'))), 'metadata: no registered producer questions were classified');
  }
  if (id === 'recovery') {
    assert.deepEqual(result.manual, { requestedThinking: 'low', afterOverride: 'low', afterTask: 'low', afterRecovery: 'low' }, 'metadata: manual thinking override did not survive recovery');
  }
}
export async function checkBusiness(root, id) {
  const baseline = JSON.parse(await readFile(new URL('./baseline.json', import.meta.url), 'utf8'));
  const allowed = { routine: ['billing/tax.mjs'], discovery: [], implementation: ['billing/tax.mjs','shipping/fee.mjs','orders/quote.mjs'], recovery: ['shipping/fee.mjs'] }[id];
  assert.ok(allowed, 'Unknown scenario');
  for (const [path, hash] of Object.entries(baseline)) if (!allowed.includes(path)) {
    const actual = createHash('sha256').update(await readFile(join(root,path))).digest('hex');
    requireCheck(actual === hash, 'business.protected-file', 'Unexpected change to a protected project file', 'unchanged', 'changed');
  }
  const load = path => import(pathToFileURL(join(root, path)).href);
  const { available } = await load('inventory/available.mjs');
  const { discount } = await load('billing/discount.mjs');
  const { fee } = await load('shipping/fee.mjs');
  const { tax } = await load('billing/tax.mjs');
  assert.equal(available('A'), 9, 'business: SKU A inventory changed'); assert.equal(available('B'), 7, 'business: SKU B inventory changed');
  assert.equal(discount(999,true), 99, 'business: VIP discount calculation mismatch'); assert.equal(discount(999,false), 0, 'business: non-VIP discount calculation mismatch');
  if (id === 'routine' || id === 'implementation') {
    for (const cents of [0,1,5,15,105,999,10000]) for (const rate of [0,725,1000,2000]) {
      const expected = Math.floor(cents * rate / 10000 + 0.5);
      expectEqual(tax(cents,rate), expected, 'business: tax rounding mismatch', 'business.tax-rounding');
    }
  }
  if (id === 'recovery') {
    expectEqual(fee('US',4999),500,'business: shipping mismatch','business.shipping-fee');
    expectEqual(fee('US',5000),0,'business: shipping mismatch','business.shipping-fee');
    expectEqual(fee('US',5001),0,'business: shipping mismatch','business.shipping-fee');
    expectEqual(fee('CA',5000),900,'business: shipping mismatch','business.shipping-fee'); assert.throws(() => fee('XX',1));
  }
  if (id === 'discovery') {
    const expected = { tax105:10, vipDiscount1000:100, availableA:9, shippingUS:500, currency:'USD', eventName:'order-created' };
    const actual = JSON.parse(await readFile(join(root,'findings.json'),'utf8'));
    requireDeepCheck(actual, expected, 'business.discovery-findings',
      'business: discovery findings are incomplete or incorrect');
  }
  if (id === 'implementation') {
    const { quote } = await load('orders/quote.mjs');
    for (const [sku, price, max] of [['A',105,9],['B',2500,7]]) for (let quantity = 1; quantity <= max; quantity++) for (const country of ['US','CA']) for (const vip of [false,true]) {
      const input = Object.freeze({ sku,quantity,country,vip });
      const subtotal = price * quantity;
      const d = vip ? Math.floor(subtotal / 10) : 0;
      const t = Math.floor((subtotal-d) / 10 + 0.5);
      const shipping = country === 'CA' ? 900 : subtotal-d >= 5000 ? 0 : 500;
      const expected = { subtotal,discount:d,tax:t,shipping,total:subtotal-d+t+shipping };
      const actual = quote(input);
      requireDeepCheck(actual, expected, 'business.order-quote', 'business: order quote calculation mismatch');
      const repeated = quote(input);
      requireDeepCheck(repeated, expected, 'business.order-quote.determinism', 'business: order quote is not deterministic');
    }
    for (const input of [{sku:'Z',quantity:1,country:'US'}, {sku:'A',quantity:10,country:'US'}, {sku:'B',quantity:8,country:'US'}, {sku:'A',quantity:1,country:'XX'}, ...[0,-1,1.5,NaN,'1'].map(quantity => ({sku:'A',quantity,country:'US'}))]) assert.throws(() => quote(input));
    assert.equal(available('A'),9); assert.equal(available('B'),7);
  }
}

function expectEqual(actual, expected, message, check = 'business.assert-equal') {
  const success = Array.isArray(expected) ? expected.includes(actual) : Object.is(actual, expected);
  if (success) return;
  verifierFailure(check, message, expected, actual);
}

function requireDeepCheck(actual, expected, check, message) {
  try { assert.deepEqual(actual, expected); }
  catch { verifierFailure(check, message, expected, actual); }
}
