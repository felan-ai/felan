import assert from 'node:assert/strict';
import { workerReadEvidence } from './worker-evidence.mjs';

const ids = ['remember-old', 'provider-incident', 'forget-old', 'remember-new'];
assert.deepEqual(workerReadEvidence('{"id":"remember-old"}\n{ "id": "forget-old" }', ids), {
  'remember-old': true, 'provider-incident': false, 'forget-old': true, 'remember-new': false,
});
assert.deepEqual(workerReadEvidence([
  '[source session="memory-processing-first" entry="provider-incident" role=user]',
  '| An incident happened.', '[/source]',
  '[source session="memory-processing-second" entry="remember-new" role=user]',
].join('\n'), ids), {
  'remember-old': false, 'provider-incident': true, 'forget-old': false, 'remember-new': true,
});
assert.deepEqual(workerReadEvidence('No source markers or JSONL entries here.', ids), Object.fromEntries(ids.map((id) => [id, false])));
console.log('memory worker evidence diagnostics passed');
