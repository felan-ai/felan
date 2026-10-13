import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDaemonOwnership } from '../../dist/daemon/ownership.js';
import { DaemonControlStore } from '../../dist/daemon/control-store.js';

const [directory, namespaceId, id, mode] = process.argv.slice(2);
const owner = await acquireDaemonOwnership({ kind: 'isolated', directory, namespaceId });
const store = new DaemonControlStore(owner);
if (store.snapshot().sessions.length) store.recover();
const piPath = join(owner.target.agentDir, 'session.jsonl');
writeFileSync(piPath, '{"type":"session","version":3,"id":"session","cwd":"/fixture"}\n');
store.createSession({ id: 'session', root: 'session', cwd: '/fixture', piPath, state: 'open', residency: 'warm', run: { state: 'running', id: 'run' }, policy: { effective: 'host-default', generation: 0 }, title: '' });
const die = () => process.kill(process.pid, 'SIGKILL');
if (mode.startsWith('pi-')) {
  if (mode !== 'pi-control-first') appendFileSync(piPath, '{"type":"message","id":"entry","message":{"id":"message"}}\n');
  if (mode !== 'pi-content-first') store.project('session', [{ type: 'message', id: 'message', entryId: 'entry', state: 'observed' }]);
  die();
} else if (mode.startsWith('answer-')) {
  store.putInteraction({ id: 'question', scope: { kind: 'session', session: 'session', root: 'session' }, request: { kind: 'input', title: 'Proceed?' }, deferrable: true, state: 'waiting', createdAt: Date.now() });
  const answer = { kind: 'input', text: 'yes' };
  store.admit({ v: 1, id, op: 'interaction.answer', session: 'session', params: { interactionId: 'question', answer } }, 'owner');
  store.answerInteraction(id, answer, 'continuation');
  if (mode !== 'answer-ready') store.transitionContinuation('continuation', 'dispatch_intent');
  if (mode === 'answer-effect') appendFileSync(join(owner.target.agentDir, 'effects'), 'continuation\n');
  if (mode === 'answer-completed') store.transitionContinuation('continuation', 'completed');
  die();
} else {
  store.admit({ v: 1, id, op: 'prompt', session: 'session', params: { text: 'fake offline request' } }, 'owner');
  if (mode !== 'intent') store.markDispatched(id);
  if (mode === 'effect' || mode === 'outcome') appendFileSync(join(owner.target.agentDir, 'effects'), 'prompt\n');
  if (mode === 'outcome') store.finishRequest(id, { v: 1, re: id, outcome: 'accepted', result: { runId: 'run' } });
  die();
}
