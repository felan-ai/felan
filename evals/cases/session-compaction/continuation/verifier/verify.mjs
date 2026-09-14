import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const workspace = process.cwd();
const sessionPath = join(workspace, 'sessions', '2026-08-27T10-35-33-058Z_01a042ca-0d42-75eb-aeac-0397822915e2.jsonl');
const rewardPath = join(workspace, '.harness-evals-reward.json');
const rubric = JSON.parse(await readFile(process.env.FACTS_PATH ?? '/tests/facts.json', 'utf8'));
let summaryFidelity = 0;
let continuationFidelity = 0;
let passed = false;
let reason = '';

try {
  const expectation = JSON.parse(await readFile(
    process.env.EXPECTATION_PATH ?? '/agent-config/session-compaction-expectation.json',
    'utf8',
  ));
  const entries = (await readFile(sessionPath, 'utf8'))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const compactionIndexes = entries
    .map((entry, index) => entry.type === 'compaction' ? index : -1)
    .filter((index) => index >= 0);
  if (compactionIndexes.length !== 1) {
    throw new Error(`expected exactly one compaction, got ${compactionIndexes.length}`);
  }

  const compactionIndex = compactionIndexes[0];
  const compaction = entries[compactionIndex];
  const summary = typeof compaction.summary === 'string' ? compaction.summary : '';
  const details = compaction.details && typeof compaction.details === 'object' ? compaction.details : {};
  validateProvenance(compaction, details, expectation.expectedOwner);

  const postCompactionAssistants = entries.slice(compactionIndex + 1)
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant');
  const toolCalls = postCompactionAssistants.flatMap((entry) => (
    Array.isArray(entry.message.content)
      ? entry.message.content.filter((part) => part?.type === 'toolCall')
      : []
  ));
  if (toolCalls.length > 0) throw new Error(`continuation used ${toolCalls.length} tool call(s)`);
  const continuation = postCompactionAssistants
    .flatMap((entry) => textBlocks(entry.message?.content))
    .join('\n');
  if (!continuation) throw new Error('missing post-compaction assistant response');

  const summaryResult = evaluateFacts(rubric.summaryFacts, summary);
  const continuationResult = evaluateFacts(rubric.continuationFacts, continuation);

  if (hasUnsupersededAwsState(summary)) {
    throw new Error('summary leaves AWS/S3 as an active storage decision');
  }
  if (hasUnsupersededAwsState(continuation)) {
    throw new Error('continuation revives the superseded AWS/S3 backend');
  }
  if (summaryResult.missingRequired.length > 0) {
    throw new Error(`summary missing required facts: ${summaryResult.missingRequired.join(', ')}`);
  }
  if (continuationResult.missingRequired.length > 0) {
    throw new Error(`continuation missing required facts: ${continuationResult.missingRequired.join(', ')}`);
  }
  if (summaryResult.score < rubric.summaryThreshold) {
    throw new Error(`summary fidelity ${summaryResult.score} is below ${rubric.summaryThreshold}`);
  }
  if (continuationResult.score < rubric.continuationThreshold) {
    throw new Error(`continuation fidelity ${continuationResult.score} is below ${rubric.continuationThreshold}`);
  }

  summaryFidelity = summaryResult.score;
  continuationFidelity = continuationResult.score;
  passed = true;
  reason = `summary=${summaryResult.passed.length}/${rubric.summaryFacts.length} continuation=${continuationResult.passed.length}/${rubric.continuationFacts.length}`;
} catch (error) {
  reason = error instanceof Error ? error.message : String(error);
}

await writeReward({ summaryFidelity, continuationFidelity });
console.log(`${passed ? 1 : 0} (${reason})`);
if (!passed) process.exitCode = 1;

function validateProvenance(compaction, details, expectedOwner) {
  const extension = details.namespace === 'felan.session-compaction';
  if (expectedOwner === 'extension') {
    if (!extension) throw new Error('candidate used native compaction instead of the configured extension');
    if (details.requestedModel !== 'inherit' || details.modelFallback !== undefined) {
      throw new Error('extension compaction did not use the default inherit model setting');
    }
    if (details.selectedModel !== 'openai-codex/gpt-5.6-sol') {
      throw new Error('extension compaction did not inherit the active session model');
    }
    return;
  }
  if (expectedOwner === 'native') {
    if (extension || compaction.fromHook === true) {
      throw new Error('baseline compaction was extension-owned instead of native');
    }
    return;
  }
  throw new Error(`invalid expected compaction owner: ${String(expectedOwner)}`);
}

function evaluateFacts(facts, text) {
  const passedFacts = facts.filter((fact) => fact.groups.every((alternatives) => (
    alternatives.some((pattern) => new RegExp(pattern, 'iu').test(text))
  )));
  return {
    passed: passedFacts.map(({ id }) => id),
    missingRequired: facts
      .filter(({ id, required }) => required && !passedFacts.some((fact) => fact.id === id))
      .map(({ id }) => id),
    score: round(passedFacts.length / facts.length),
  };
}

function hasUnsupersededAwsState(text) {
  const statements = text.split(/\n+|(?<=[.!?])\s+/u).filter((statement) => /\b(?:aws|s3)\b/iu.test(statement));
  const superseded = statements.some((statement) => (
    /\b(?:remov\w*|drop\w*|defer\w*|supersed\w*|without|no longer|filesystem[- ]only)\b/iu.test(statement)
    || /\b(?:not|never|doesn't|does not|isn't|is not)\b/iu.test(statement)
  ));
  const active = statements.some((statement) => (
    /\b(?:use|uses|using|keep|keeps|retain|retains|require|requires|add|added|include|includes|implement|implemented|current|active)\b/iu.test(statement)
    && !/\b(?:not|never|doesn't|does not|isn't|is not|remov\w*|drop\w*|defer\w*|supersed\w*|without|no longer)\b/iu.test(statement)
  ));
  return active && !superseded;
}

function textBlocks(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map(({ text }) => text);
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function writeReward(value) {
  const handle = await open(rewardPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}
