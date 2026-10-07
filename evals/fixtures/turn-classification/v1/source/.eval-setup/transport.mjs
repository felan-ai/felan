import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const sumKnown = values => values.every(value => Number.isFinite(value) && value >= 0) ? values.reduce((a,b) => a+b, 0) : null;
export function mergeMetadata(results, elapsedMs) {
  const usage = {};
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'costUsd']) {
    const sum = sumKnown(results.map(result => result.metadata?.usage?.[key]));
    if (sum !== null) usage[key] = sum;
  }
  const same = key => results.every(r => r.metadata?.[key] === results[0]?.metadata?.[key]) ? results[0]?.metadata?.[key] : undefined;
  return { provider: same('provider'), model: same('model'), elapsedMs, usage };
}
export function createTransport(native, mode, validate, records) {
  if (mode === 'disabled') return undefined;
  if (!['shared','separated'].includes(mode)) throw new Error('Unknown transport');
  return {
    canEvaluate: (state, questions) => native.canEvaluate?.(state, questions) ?? true,
    async classify(state, questions, signal) {
      const started = performance.now();
      const ids = Object.keys(questions);
      const split = mode === 'separated' && ids.every(id => id.includes(':'));
      const groups = new Map();
      for (const [id, question] of Object.entries(questions)) {
        const key = split ? id.slice(0, id.indexOf(':')) : 'unchanged';
        if (!groups.has(key)) groups.set(key, {});
        groups.get(key)[id] = question;
      }
      const record = { stateDigest: digest(state), questionsDigest: digest(questions), questionIds: ids,
        questionCount: ids.length, nativeInvocations: groups.size, status: 'pending' };
      records.push(record);
      try {
        const results = await Promise.all([...groups.values()].map(async subset => {
          const result = await native.classify(state, subset, signal);
          return { ...result, answers: validate(subset, result.answers) };
        }));
        const answers = validate(questions, Object.assign({}, ...results.map(result => result.answers)));
        const metadata = mergeMetadata(results, performance.now() - started);
        Object.assign(record, { status: 'completed', metadata, answers });
        return { answers, metadata };
      } catch (error) {
        record.status = 'failed';
        throw error;
      }
    },
  };
}
export function measureNativeRuntime(runtime, requests) {
  return { async classify(model, request, options) {
    const row = { provider: model.provider, model: model.id, questionCount: Object.keys(request.questions).length,
      status: 'pending', inputTokens: null, outputTokens: null, costUsd: null };
    requests.push(row);
    const started = performance.now();
    try {
      const response = await runtime.classify(model, request, options);
      row.status = response.stopReason === 'stop' ? 'completed' : 'failed';
      row.inputTokens = response.usage?.input ?? null;
      row.outputTokens = response.usage?.output ?? null;
      row.costUsd = model.cost.input > 0 || model.cost.output > 0 ? response.usage?.cost?.total ?? null : null;
      return response;
    } catch (error) { row.status = 'failed'; throw error; }
    finally { row.elapsedMs = performance.now() - started; }
  } };
}
