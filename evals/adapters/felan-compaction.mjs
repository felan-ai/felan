import { createReadStream } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { felanAdapter } from 'harness-evals';

const EXPECTATION_FILE = 'session-compaction-expectation.json';

export const felanCompactionAdapter = {
  name: 'felan',
  authEnvNames: felanAdapter.authEnvNames,
  getInstallRecipe: (input) => felanAdapter.getInstallRecipe(input),
  async prepareStep(input) {
    const plan = await felanAdapter.prepareStep(input);
    if (input.agent.config?.compactionCostAccounting !== true) return plan;
    const expectedOwner = expectedCompactionOwner(input.agent.config);
    const expectedMethod = expectedCompactionMethod(input.agent.config);
    return {
      ...plan,
      metadata: {
        ...(plan.metadata ?? {}),
        compactionCost: {
          activeProvider: input.agent.provider,
          activeModel: input.agent.model,
          expectedOwner,
          expectedMethod,
        },
      },
    };
  },
  async parseEvents(input) {
    const events = await felanAdapter.parseEvents(input);
    if (input.plan.parser === 'text' || input.plan.metadata?.compactionCost === undefined) return events;
    const expectedOwner = input.plan.metadata.compactionCost.expectedOwner;
    const expectedMethod = input.plan.metadata.compactionCost.expectedMethod;
    if (input.configDir === undefined || (expectedOwner !== 'native' && expectedOwner !== 'extension')) {
      throw new Error('Compaction cost accounting is missing verifier expectation metadata');
    }
    await writeCompactionExpectation(input.configDir, expectedOwner, expectedMethod);

    const cost = await parseFelanCompactionCost(input);
    return cost === undefined ? events : { ...events, cost };
  },
};

export function expectedCompactionOwner(config) {
  const enabled = config?.settings?.builtinExtensions?.sessionCompaction;
  if (typeof enabled !== 'boolean') {
    throw new Error('Compaction cost accounting requires explicit builtinExtensions.sessionCompaction');
  }
  return enabled ? 'extension' : 'native';
}

export function expectedCompactionMethod(config) {
  if (config?.settings?.builtinExtensions?.sessionCompaction !== true) return 'native';
  const method = config?.settings?.extensionConfig?.sessionCompaction?.method;
  return method === 'summary' ? 'summary' : 'classifier';
}

export async function writeCompactionExpectation(configDir, expectedOwner, expectedMethod = 'native') {
  if (expectedOwner !== 'native' && expectedOwner !== 'extension') {
    throw new Error(`Invalid expected compaction owner: ${String(expectedOwner)}`);
  }
  if (!['native', 'summary', 'classifier'].includes(expectedMethod)) {
    throw new Error(`Invalid expected compaction method: ${String(expectedMethod)}`);
  }
  const path = join(configDir, EXPECTATION_FILE);
  const temporary = join(configDir, `.${EXPECTATION_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ expectedOwner, expectedMethod })}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function parseFelanCompactionCost(input) {
  const usageByModel = new Map();
  let assistantRequests = 0;
  let compactionRequests = 0;
  let classifierRequests = 0;

  for await (const line of readStdoutLines(input)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    if (event.type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant') {
      if (addUsage(usageByModel, event.message.usage, {
        provider: stringValue(event.message.provider) ?? 'felan',
        model: stringValue(event.message.model) ?? 'unknown',
      })) assistantRequests += 1;
      continue;
    }

    if (event.type !== 'compaction_end' || event.aborted === true || !isRecord(event.result)) continue;
    const selection = compactionModel(event.result.details, input.plan.metadata);
    if (addUsage(usageByModel, event.result.usage, selection)) compactionRequests += 1;
    const classifier = classifierUsage(event.result.details);
    if (classifier !== undefined) {
      classifierRequests += classifier.requests;
      if (addUsage(usageByModel, classifier.rawUsage, classifier.selection)) {
        bumpRequests(usageByModel, classifier.selection, Math.max(0, classifier.requests - 1));
      }
    }
  }

  if (usageByModel.size === 0) return undefined;
  const usage = [...usageByModel.values()];
  const totalCost = sumDefined(usage.map((entry) => entry.totalCost));
  return {
    available: true,
    ...(totalCost === undefined ? {} : { currency: 'USD', totalCost }),
    totalTokens: usage.reduce((sum, entry) => sum + entry.totalTokens, 0),
    usage,
    metadata: {
      source: 'felan-jsonl-with-compaction',
      assistantRequests,
      compactionRequests,
      classifierRequests,
      compactionUsageIncluded: compactionRequests > 0,
    },
  };
}

function bumpRequests(usageByModel, selection, amount) {
  if (amount <= 0) return;
  const current = usageByModel.get(JSON.stringify([selection.provider, selection.model]));
  if (current) current.requests += amount;
}

function classifierUsage(details) {
  const usage = isRecord(details) && isRecord(details.prune) && isRecord(details.prune.classifier)
    ? details.prune.classifier
    : undefined;
  if (!usage || typeof usage.provider !== 'string' || typeof usage.model !== 'string' || typeof usage.usage !== 'object') return undefined;
  const raw = usage.usage;
  if (!isRecord(raw)) return undefined;
  const input = finiteNumber(raw.inputTokens);
  const output = finiteNumber(raw.outputTokens);
  const cost = finiteNumber(raw.costUsd);
  if (input === undefined && output === undefined && cost === undefined) return {
    requests: finiteNumber(raw.requests) ?? 0,
    rawUsage: undefined,
    selection: { provider: usage.provider, model: usage.model },
  };
  return {
    requests: finiteNumber(raw.requests) ?? 0,
    rawUsage: {
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      totalTokens: (input ?? 0) + (output ?? 0),
      ...(cost === undefined ? {} : { cost: { total: cost } }),
    },
    selection: { provider: usage.provider, model: usage.model },
  };
}

async function* readStdoutLines(input) {
  if (input.stdoutPath) {
    const stream = createReadStream(input.stdoutPath, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) yield line;
      return;
    } catch {
      // Fall back to the retained in-memory output when the full artifact is unavailable.
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  for (const line of input.stdout.split(/\r?\n/u)) yield line;
}

function addUsage(usageByModel, rawUsage, selection) {
  if (!isRecord(rawUsage)) return false;
  const key = JSON.stringify([selection.provider, selection.model]);
  const current = usageByModel.get(key) ?? {
    provider: selection.provider,
    model: selection.model,
    inputTokens: 0,
    promptTokens: 0,
    uncachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
  const inputTokens = finiteNumber(rawUsage.input) ?? 0;
  const cacheReadInputTokens = finiteNumber(rawUsage.cacheRead) ?? 0;
  const cacheWriteInputTokens = finiteNumber(rawUsage.cacheWrite) ?? 0;
  const outputTokens = finiteNumber(rawUsage.output) ?? 0;
  const reasoningTokens = finiteNumber(rawUsage.reasoning) ?? 0;
  const totalTokens = finiteNumber(rawUsage.totalTokens)
    ?? inputTokens + cacheReadInputTokens + cacheWriteInputTokens + outputTokens;
  const totalCost = finiteNumber(isRecord(rawUsage.cost) ? rawUsage.cost.total : undefined);

  current.inputTokens += inputTokens;
  current.promptTokens += inputTokens + cacheReadInputTokens + cacheWriteInputTokens;
  current.uncachedInputTokens += inputTokens;
  current.cacheReadInputTokens += cacheReadInputTokens;
  current.cacheWriteInputTokens += cacheWriteInputTokens;
  current.outputTokens += outputTokens;
  current.cachedInputTokens += cacheReadInputTokens;
  current.reasoningTokens += reasoningTokens;
  current.totalTokens += totalTokens;
  current.requests += 1;
  if (totalCost !== undefined) {
    current.totalCost = (current.totalCost ?? 0) + totalCost;
    current.currency = 'USD';
  }
  usageByModel.set(key, current);
  return true;
}

function compactionModel(details, metadata) {
  const selectedModel = isRecord(details) ? stringValue(details.selectedModel) : undefined;
  const selected = selectedModel ? splitModelReference(selectedModel) : undefined;
  if (selected) return selected;

  const configured = isRecord(metadata) && isRecord(metadata.compactionCost)
    ? metadata.compactionCost
    : undefined;
  return {
    provider: stringValue(configured?.activeProvider) ?? 'felan',
    model: stringValue(configured?.activeModel) ?? 'unknown',
  };
}

function splitModelReference(value) {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function sumDefined(values) {
  const present = values.filter((value) => value !== undefined);
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default felanCompactionAdapter;
