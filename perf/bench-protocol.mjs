import assert from 'node:assert/strict';
import { built, dependency } from './lib.mjs';
import { delta, snapshot } from './fixtures.mjs';

export async function run(ctx) {
  const P = await built('packages/session-protocol/dist/index.js');
  await ctx.case('text-delta', async () => {
    const event = delta(0, 'ASCII 中文 🐈');
    const frame = Buffer.from(P.encodeFrame(event));
    assert.deepEqual(new P.JsonLineDecoder().push(frame), [event]);
    ctx.bench('delta.stringify', () => Buffer.from(JSON.stringify(event) + '\n'));
    ctx.bench('delta.encodeFrame', () => P.encodeFrame(event));
    ctx.bench('delta.JSON.parse', () => JSON.parse(frame.toString()));
    ctx.bench('delta.decode', () => new P.JsonLineDecoder().push(frame));
    ctx.bench('delta.validate', () => P.parseServerEnvelope(event));
    ctx.bench('delta.classify', () => assert.equal(P.classifyTextDelta(undefined, event), 'start'));
  });
  for (const size of [4096, 65536]) await ctx.case(`tool.${size}`, async () => {
    const event = { v: 1, session: 'perf-session', rev: 11, change: { type: 'tool.updated', tool: { id: 'c', name: 'read', message: 'm-live', state: 'running', output: 'x'.repeat(size), truncated: false } } };
    const frame = P.encodeFrame(event);
    ctx.bench(`tool.${size}.encode`, () => P.encodeFrame(event));
    ctx.bench(`tool.${size}.decode`, () => new P.JsonLineDecoder().push(frame));
    ctx.bench(`tool.${size}.validate`, () => P.parseServerEnvelope(event));
  });
  for (const large of [false, true]) await ctx.case(`snapshot.${large ? '5MiB' : 'small'}`, async () => {
    const snap = snapshot({ large });
    P.parseSessionSnapshot(snap);
    const label = large ? 'snapshot.5MiB' : 'snapshot.small';
    const response = { v: 1, re: 'perf-request', outcome: 'accepted', result: { attachmentId: 'a', snapshot: snap } };
    const frame = P.encodeFrame(response);
    ctx.value(`${label}.bytes`, Buffer.byteLength(JSON.stringify(snap)), 'bytes');
    ctx.bench(`${label}.stringify`, () => JSON.stringify(response));
    ctx.bench(`${label}.parse`, () => JSON.parse(Buffer.from(frame).toString()));
    ctx.bench(`${label}.encode`, () => P.encodeFrame(response));
    ctx.bench(`${label}.decode`, () => new P.JsonLineDecoder().push(frame));
    ctx.bench(`${label}.validate`, () => P.parseSessionSnapshot(snap));
    ctx.bench(`${label}.attach-validate`, () => P.parseServerEnvelope(response, 'attach'));
    ctx.bench(`${label}.clone`, () => structuredClone(snap));
    await ctx.case(`${label}.reducer`, async () => {
      const R = await built('apps/felan/dist/client/reducer.js');
      let state = R.reduceSession(R.createSessionState(snap.session), { type: 'snapshot', snapshot: snap });
      assert.equal(state.status, 'live');
      ctx.bench(`${label}.reducer-tiny-event`, () => {
        state = R.reduceSession(state, { type: 'update', update: { v: 1, session: snap.session, rev: state.snapshot.revision + 1, change: { type: 'run.updated', run: { state: 'running', id: 'r' } } } });
        assert.equal(state.status, 'live');
      });
      let offset = 0;
      ctx.bench(`${label}.reducer-stream`, () => {
        state = R.reduceSession(state, { type: 'update', update: delta(offset, 'ab中文🐈') });
        offset += 5;
        assert.equal(state.status, 'live');
      }, { iterations: ctx.quick ? 200 : 2000 });
    });
  });
  await ctx.case('typebox', async () => {
    const { Value } = await dependency('typebox/value');
    const { Compile } = await dependency('typebox/compile');
    for (const [label, schema, value] of [['delta', P.TextStreamEventSchema, delta()], ['snapshot', P.SessionSnapshotSchema, snapshot({ large: true })]]) {
      const compiled = Compile(schema);
      assert.equal(compiled.Check(value), true);
      ctx.bench(`typebox.${label}.interpreted`, () => Value.Check(schema, value));
      ctx.bench(`typebox.${label}.compiled`, () => compiled.Check(value));
    }
  });
  await ctx.case('strings', async () => {
    const value = 'ASCII中文🐈'.repeat(100000);
    assert.equal(P.utf8Bytes(value), Buffer.byteLength(value));
    ctx.bench('string.utf8Bytes', () => P.utf8Bytes(value));
    ctx.bench('string.Buffer.byteLength', () => Buffer.byteLength(value));
    ctx.bench('string.codePointLength', () => P.codePointLength(value));
  });
}
