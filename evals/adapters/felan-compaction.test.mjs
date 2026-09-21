import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expectedCompactionOwner,
  expectedCompactionMethod,
  felanCompactionAdapter,
  parseFelanCompactionCost,
  writeCompactionExpectation,
} from './felan-compaction.mjs';

const fixture = fileURLToPath(new URL('../fixtures/session-compaction/v1/source/sessions/2026-08-27T10-35-33-058Z_01a042ca-0d42-75eb-aeac-0397822915e2.jsonl', import.meta.url));
const baseUsage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.03 } };
const assistant = (provider, model, usage = baseUsage) => ({
  type: 'message_end',
  message: { role: 'assistant', provider, model, usage },
});

const native = await parseFelanCompactionCost({
  stdout: `${JSON.stringify(assistant('openai-codex', 'gpt-5.6-sol'))}\n${JSON.stringify({
    type: 'compaction_end',
    aborted: false,
    result: { usage: { ...baseUsage, input: 100, output: 20, totalTokens: 120, cost: { total: 0.12 } } },
  })}\n`,
  plan: { parser: 'pi-jsonl', metadata: { compactionCost: { activeProvider: 'openai-codex', activeModel: 'gpt-5.6-sol' } } },
});
assert.equal(native.metadata.compactionRequests, 1);
assert.equal(native.totalCost, 0.15);
assert.deepEqual(native.usage.map(({ provider, model, requests }) => ({ provider, model, requests })), [
  { provider: 'openai-codex', model: 'gpt-5.6-sol', requests: 2 },
]);

const extension = await parseFelanCompactionCost({
  stdout: `${JSON.stringify(assistant('openai-codex', 'gpt-5.6-sol'))}\n${JSON.stringify({
    type: 'compaction_end',
    aborted: false,
    result: {
      details: { namespace: 'felan.session-compaction', selectedModel: 'openai-codex/gpt-5.6-luna' },
      usage: { ...baseUsage, input: 80, output: 10, totalTokens: 90, cost: { total: 0.01 } },
    },
  })}\n${JSON.stringify({ type: 'compaction_end', aborted: true, result: { usage: baseUsage } })}\n`,
  plan: { parser: 'pi-jsonl' },
});
assert.equal(extension.metadata.compactionRequests, 1);
assert.equal(extension.totalCost, 0.04);
assert.deepEqual(extension.usage.map(({ provider, model }) => ({ provider, model })), [
  { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  { provider: 'openai-codex', model: 'gpt-5.6-luna' },
]);

const classifier = await parseFelanCompactionCost({
  stdout: `${JSON.stringify({
    type: 'compaction_end',
    aborted: false,
    result: {
      details: {
        namespace: 'felan.session-compaction',
        method: 'classifier',
        prune: { status: 'ran', asked: 3, classifier: {
          provider: 'openrouter', model: 'typesafe/jev-1.13',
          usage: { requests: 2, inputTokens: 400, outputTokens: 20, costUsd: 0.00002 },
        } },
      },
    },
  })}\n`,
  plan: { parser: 'pi-jsonl' },
});
assert.equal(classifier.metadata.classifierRequests, 2);
assert.equal(classifier.totalCost, 0.00002);

const configDir = await mkdtemp(join(tmpdir(), 'felan-compaction-adapter-'));
try {
  assert.equal(expectedCompactionOwner({
    settings: { builtinExtensions: { sessionCompaction: false } },
  }), 'native');
  await writeCompactionExpectation(configDir, 'native', 'native');
  assert.deepEqual(JSON.parse(await readFile(join(configDir, 'session-compaction-expectation.json'), 'utf8')), {
    expectedOwner: 'native', expectedMethod: 'native',
  });
  assert.equal(expectedCompactionOwner({
    settings: { builtinExtensions: { sessionCompaction: true } },
  }), 'extension');
  assert.equal(expectedCompactionMethod({
    settings: { builtinExtensions: { sessionCompaction: true } },
  }), 'classifier');
  assert.equal(expectedCompactionMethod({
    settings: { builtinExtensions: { sessionCompaction: true }, extensionConfig: { sessionCompaction: { method: 'classifier' } } },
  }), 'classifier');
  assert.equal(expectedCompactionMethod({
    settings: { builtinExtensions: { sessionCompaction: true }, extensionConfig: { sessionCompaction: { method: 'summary' } } },
  }), 'summary');
  await assert.rejects(async () => expectedCompactionOwner({ settings: { builtinExtensions: {} } }),
    /requires explicit builtinExtensions\.sessionCompaction/,
  );

  const victim = join(configDir, 'victim.json');
  const expectation = join(configDir, 'session-compaction-expectation.json');
  await rm(expectation);
  await writeFile(victim, 'unchanged\n');
  await symlink(victim, expectation);
  await writeCompactionExpectation(configDir, 'extension', 'summary');
  assert.equal(await readFile(victim, 'utf8'), 'unchanged\n');
  assert.equal((await lstat(expectation)).isFile(), true);
  assert.deepEqual(JSON.parse(await readFile(expectation, 'utf8')), { expectedOwner: 'extension', expectedMethod: 'summary' });

  await felanCompactionAdapter.parseEvents({
    stdout: '',
    stderr: '',
    configDir,
    plan: { parser: 'pi-jsonl', metadata: { compactionCost: { expectedOwner: 'native', expectedMethod: 'native' } } },
  });
  assert.deepEqual(JSON.parse(await readFile(expectation, 'utf8')), { expectedOwner: 'native', expectedMethod: 'native' });
} finally {
  await rm(configDir, { recursive: true, force: true });
}

const fixtureText = await readFile(fixture, 'utf8');
const fixtureManifest = JSON.parse(await readFile(new URL('../fixtures/session-compaction/v1/fixture.json', import.meta.url), 'utf8'));
const fixtureEntries = fixtureText.trimEnd().split('\n').map((line) => JSON.parse(line));
assert.match(fixtureText, /"version":3/);
assert.equal(fixtureEntries.length, 234);
assert.equal(fixtureEntries[0].id, '01a042ca-0d42-75eb-aeac-0397822915e2');
assert.equal(fixtureEntries.filter(({ type }) => type === 'compaction').length, 0);
assert.doesNotMatch(fixtureText, /\/Users\/milkoslavov|thinkingSignature|textSignature|responseId|encrypted_content/);
assert.equal(createHash('sha256').update(fixtureText).digest('hex'), fixtureManifest.files[0].sha256);
console.log('felan-compaction adapter tests passed');
