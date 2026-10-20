import { SessionClient } from '../../dist/client/client.js';
import { localConnector } from '../../dist/client/transport.js';

const target = JSON.parse(process.argv[2]);
if (target.kind !== 'isolated') throw new Error('Client fixture refuses production');
let client;
let session;
let dropId;
const sent = [];
const waits = new Set();

function send(value) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return resolve();
    process.send(value, error => error ? reject(error) : resolve());
  });
}
function view() {
  return { pid: process.pid, environment: process.env.FELAN_PROCESS_ENV, status: client?.status, identity: client?.identity,
    attachment: session ? client?.getAttachment(session) : undefined, sent };
}
function close() {
  client?.close();
  for (const cancel of [...waits]) cancel(new Error('Client fixture closed'));
}
function construct(identity) {
  const next = new SessionClient({ target, expected: identity, clientVersion: 'process-fixture', kind: 'tui', retries: 0,
    reconnectAttempts: 0, connector: async receiver => {
      const real = localConnector(next.target);
      const transport = await real({
        closed: reason => receiver.closed(reason),
        frame: value => {
          if (dropId && value?.re === dropId && value.outcome === 'accepted') {
            dropId = undefined;
            void send({ event: 'ack-dropped', value }).catch(() => {});
            queueMicrotask(() => transport.close());
          } else receiver.frame(value);
        },
      });
      return {
        send(value) {
          if (sent.length >= 256) throw new Error('Fixture request limit exceeded');
          sent.push(value); transport.send(value);
        },
        close: () => transport.close(),
      };
    } });
  return next;
}
function waitState(wanted) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`State deadline: ${JSON.stringify(wanted)}`)), 12_000);
    let unlisten = () => {};
    const done = error => { clearTimeout(timer); unlisten(); waits.delete(done); error ? reject(error) : resolve(view()); };
    const check = () => {
      const current = view(); const snapshot = current.attachment?.state.snapshot;
      if (wanted.status && current.status !== wanted.status) return;
      if (!wanted.status && (current.status !== 'ready' || current.attachment?.state.status !== 'live')) return;
      if (wanted.sessionState && snapshot?.state !== wanted.sessionState) return;
      if (wanted.branch && snapshot?.branch !== wanted.branch) return;
      if (wanted.runState && snapshot?.run.state !== wanted.runState) return;
      if (wanted.runId && snapshot?.run.id !== wanted.runId) return;
      if (wanted.streamText && !snapshot?.activeStreams.some(stream => stream.text.includes(wanted.streamText))) return;
      if (wanted.historyText && (!snapshot || !JSON.stringify(snapshot.history.entries).includes(wanted.historyText))) return;
      if (wanted.process) {
        const resource = snapshot?.processes.find(item => item.id === wanted.process.id);
        if (!resource || wanted.process.state && resource.state !== wanted.process.state
          || resource.outputOffset < (wanted.process.minimumOutput ?? 0)) return;
      }
      done();
    };
    waits.add(done); unlisten = client.subscribe(check); check();
  });
}

process.on('disconnect', close);
process.on('message', command => {
  void (async () => {
    try {
      let value;
      if (command.op === 'connect') {
        if (client && !command.replace) throw new Error('Existing client must be replaced explicitly');
        close(); session = undefined; dropId = undefined;
        client = construct(command.identity);
        await client.connect(); value = view();
      } else if (command.op === 'reconnect') { await client.connect(); value = view(); }
      else if (command.op === 'attach') { session = command.session; const result = await client.attach(session); value = { result, ...view() }; }
      else if (command.op === 'request') value = await client.request(command.operation, command.params,
        { ...(command.session ? { session: command.session } : {}), ...(command.requestId ? { id: command.requestId } : {}) });
      else if (command.op === 'drop-ack') { dropId = command.requestId; value = { armed: dropId }; }
      else if (command.op === 'wait-state') value = await waitState(command.wanted);
      else if (command.op === 'state') value = view();
      else if (command.op === 'shutdown') { close(); value = { stopped: true }; }
      else throw new Error('Unknown client fixture operation');
      await send({ id: command.id, ok: true, value });
      if (command.op === 'shutdown' && process.connected) process.disconnect();
    } catch (error) { await send({ id: command.id, ok: false, error: error.message }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
});
await send({ event: 'ready', value: { pid: process.pid, environment: process.env.FELAN_PROCESS_ENV } });
