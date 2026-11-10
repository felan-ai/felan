import { afterEach, describe, expect, it } from 'vitest';
import { parseOperationResult, parseSessionSnapshot } from '@felan-ai/session-protocol';
import { assistant, fixture, fixtures, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

describe.skipIf(!supported)('Pi protocol projection performance', () => {
  it('benchmarks attach snapshot validation at five MiB', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const projection = f.registry.projection(b.sessionId); const runtime = f.instances.get(b.sessionId)!;
    const text = 'x'.repeat(1024 * 1024);
    b.runtime.session.sessionManager.appendMessage({ role: 'user', content: text, timestamp: 0 });
    const message = assistant('Pending'); runtime.emit({ type: 'message_start', message });
    for (let contentIndex = 0; contentIndex < 4; contentIndex++) runtime.emit({ type: 'message_update', message,
      assistantMessageEvent: { type: 'text_delta', contentIndex, delta: text, partial: message } });
    const snapshot = projection.snapshot();
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    expect(bytes).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    for (const [name, parse] of [
      ['parseSessionSnapshot', () => parseSessionSnapshot(snapshot)],
      ['parseOperationResult(attach)', () => parseOperationResult('attach', { attachmentId: 'attachment', snapshot })],
    ] as const) {
      for (let warmup = 0; warmup < 20; warmup++) parse();
      const samples: number[] = [];
      for (let sample = 0; sample < 50; sample++) {
        const start = performance.now(); parse(); samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      console.log(JSON.stringify({ validator: name, attachSnapshotBytes: bytes, validationSamples: samples.length,
        validationMedianMs: samples[25], validationP95Ms: samples[47] }));
    }
  }, 60_000);

  it('benchmarks unchanged catalog refreshes and incremental streaming', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const session = b.runtime.session; const runtime = f.instances.get(b.sessionId)!; const projection = f.registry.projection(b.sessionId);
    const parameters = { type: 'object', properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
      `option${index}`, { type: 'string', description: `Tool option ${index}`, enum: ['first', 'second', 'third'] },
    ])), required: ['option0'] };
    Object.assign(session, { getAllTools: () => Array.from({ length: 60 }, (_, index) => ({ name: `tool${index}`, description: `Tool ${index}`, parameters })) });
    for (let index = 0; index < 256; index++) session.sessionManager.appendMessage({ role: 'user', content: `Message ${index}`, timestamp: index });
    projection.refresh();
    for (let index = 0; index < 100; index++) projection.refresh();
    const median = (times: number[]) => times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
    const refreshTimes: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      for (let index = 0; index < 500; index++) projection.refresh();
      refreshTimes.push((performance.now() - start) / 500);
    }
    const deltaTimes: Record<string, number> = {};
    for (const size of [100, 200, 400]) {
      const times: number[] = [];
      const text = 'x'.repeat(size * 1024); const delta = 'x'.repeat(25);
      for (let sample = 0; sample < 5; sample++) {
        const message = assistant(text); runtime.emit({ type: 'message_start', message });
        const start = performance.now();
        for (let index = 0; index < text.length; index += delta.length) runtime.emit({ type: 'message_update', message,
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text.slice(index, index + delta.length), partial: message } });
        times.push(performance.now() - start);
        expect(projection.snapshot().activeStreams[0]?.text).toBe(text);
        runtime.emit({ type: 'message_end', message }); session.sessionManager.appendMessage(message); projection.refresh();
      }
      deltaTimes[`${size}KiB`] = median(times);
    }
    console.log(JSON.stringify({ refreshMedianMs: median(refreshTimes), deltaMedianMs: deltaTimes }));
  }, 60_000);
});
