'use strict';
(() => {
  const { C, KINDS } = Felan;
  const S = window.FELAN_SCENES;
  const AB = [{ id: 'after', label: 'After' }, { id: 'before', label: 'Before', tone: 'before' }];

  // 07 ─────────────────────────────────────────────────────────────── reducer
  S.push({
    id: 'reducer', title: 'Client reducer', sub: 'Work proportional to the change', modes: AB,
    build(b, mode) {
      const before = mode === 'before';
      const perEvent = before ? 11.6 : 0.0012;
      const cpuText = v => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : before ? `${v.toFixed(1)} ms` : `${v.toFixed(4)} ms`);
      b.note(`${mode} · motion slowed`);
      b.zone({ x: 240, y: 112, w: 520, h: 360, label: 'client session state · 5 MiB' });
      const blocks = [];
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 14; c++) {
          if (r === 8 && c > 6) continue;
          if (r === 9 && c > 3) continue;
          const kind = r < 8 ? null : r === 8 ? KINDS.req : KINDS.dlt;
          const block = b.rect({ x: 264 + c * 34, y: 146 + r * 26, w: 30, h: 22, fill: kind ? kind.fill : '#e3e6ee', stroke: kind ? kind.stroke : '#c9cdd6', rx: 3, op: 0 });
          blocks.push(block);
          b.show(block, 300 + r * 120, 300);
        }
      }
      b.staticText({ x: 264, y: 432, text: 'history (≤ 256 entries)   ·   tools   ·   active stream', font: 'mono', size: 10 });
      const highlight = b.rect({ x: 260, y: 376, w: 140, h: 30, fill: 'none', stroke: C.accent, sw: 2.5, rx: 5, op: 0 });
      const sweep = b.rect({ x: 258, y: 140, w: 30, h: 266, fill: C.accent, rx: 3, op: 0 });
      b.line([[24, 300], [236, 300]], { color: C.accent });
      b.staticText({ x: 24, y: 288, text: 'incoming deltas', font: 'mono', size: 10 });

      b.staticText({ x: 800, y: 132, text: 'PER EVENT', font: 'mono', size: 10, spacing: '0.12em' });
      const pe = b.txt({ x: 800, y: 180, text: before ? '11.6 ms' : '0.0012 ms', font: 'serif', size: 44, fill: before ? C.bad : C.ok, op: 0 });
      b.staticText({ x: 800, y: 216, text: 'EVENTS APPLIED', font: 'mono', size: 10, spacing: '0.12em' });
      b.staticText({ x: 990, y: 216, text: 'CPU SPENT', font: 'mono', size: 10, spacing: '0.12em' });
      const count = b.txt({ x: 800, y: 246, text: '0', font: 'mono', size: 20 });
      const cpu = b.txt({ x: 990, y: 246, text: '0 ms', font: 'mono', size: 20, fill: before ? C.bad : C.ok });
      const card = b.card({ x: 800, y: 276, w: 376, title: 'per event', kind: before ? 'bad' : 'ok', lines: before
        ? ['apply the change, then', { text: 'JSON.stringify(whole snapshot)', mono: true }, 'and count its UTF-8 bytes vs 12 MiB.', 'Cost grows with the session.']
        : ['apply the change to the one list it touches;', 'size: running estimate += size of change;', 'exact recount only above the 12 MiB limit;', 'stream limits: 3 × UTF-16 length ≤ limit ⇒ fits.'] });

      b.beat(0, 'The client keeps a full copy of the session', `<p>After attaching, the client holds the session state: up to 256 history entries, tools, run, queue, interactions and active streams. Every frame updates this copy, and the TUI renders from it. A long session is several MiB.</p>`);
      const T2 = 1800;
      b.beat(T2, before ? 'Every event re-serialised the whole state' : 'A delta touches one stream', before
        ? `<p>After applying a change, the reducer ran <code>JSON.stringify</code> on the entire snapshot and counted its UTF-8 bytes to enforce the 12 MiB limit. On a 5 MiB session that took <span class="was">11.6 ms</span> per event, for every token.</p>`
        : `<p>The reducer finds the stream, checks the offset, appends the text and leaves everything else alone: <span class="num">≈ 0.001 ms</span> per event, whatever the session size.</p>`);
      b.show(pe, T2 + 200);
      for (let i = 0; i < 5; i++) {
        const at = b.route(b.pkt({ kind: 'dlt', label: `@${9 + i * 4} "${['ld', ' is', ' now', ' fast', '.'][i]}"` }), [[60, 300], [236, 300]], T2 + 300 + i * 900, { speed: 0.5 });
        if (before) {
          b.tw(at, 650, p => { sweep.m.x = 258 + 474 * p; sweep.m.op = 0.28 * Math.sin(Math.PI * p); }, 'lin');
        } else {
          b.tw(at, 500, p => { highlight.m.op = Math.sin(Math.PI * p); }, 'lin');
        }
        b.set(count, at, { text: `${i + 1}` });
        b.set(cpu, at, { text: cpuText((i + 1) * perEvent) });
      }

      const T3 = T2 + 300 + 5 * 900 + 400;
      b.beat(T3, before ? 'Cost grows with the session' : 'How the size limit still holds', before
        ? `<p>The work per event depended on how big the session already was, not on how small the change was.</p>`
        : `<p>The reducer keeps a running size estimate and adds the size of each change; the estimate can only overcount. The exact recount runs only when the estimate crosses 12 MiB. Stream text also has its own limits (1 MiB per stream, 4 MiB across streams); UTF-8 needs at most 3 bytes per UTF-16 code unit, so when 3 × <code>length</code> is under a limit its exact count is skipped. Accept and reject outcomes are identical.</p>`);
      b.show(card, T3 + 200);

      const T4 = T3 + 3200;
      b.beat(T4, 'A whole answer: 600 deltas', before
        ? `<p>600 deltas on a 5 MiB session cost <span class="was">≈ 7 s</span> of CPU (11.6 ms × 600), competing with keystrokes and rendering.</p>`
        : `<p>600 deltas cost <span class="num">≈ 0.7 ms</span> of CPU in total (0.0012 ms × 600).</p>`);
      b.count(count, T4 + 200, 2600, 5, 600);
      b.count(cpu, T4 + 200, 2600, 5 * perEvent, 600 * perEvent, cpuText);
      if (before) b.tw(T4 + 200, 2600, p => { const k = (p * 2600 / 160) % 1; sweep.m.x = 258 + 474 * k; sweep.m.op = 0.22; }, 'lin');
      else b.tw(T4 + 200, 2600, p => { highlight.m.op = 0.5 + 0.5 * Math.sin(p * 60); }, 'lin');
      b.set(sweep, T4 + 2800, { op: 0 });
      b.set(highlight, T4 + 2800, { op: 0 });

      const T5 = T4 + 3400;
      b.beat(T5, 'Attaching: validate once', `<p>The attach reply is validated once by the protocol parser. The reducer used to validate the snapshot a second time (≈ 37 ms at 5 MiB); it now takes a private copy with <code>structuredClone</code> (≈ 3 ms).</p>`);
      b.bars({ x: 240, y: 520, w: 936, t: T5 + 200, labelW: 220, valueW: 220, rows: [
        { label: 'attach a 5 MiB snapshot', b: 37, a: 3, bText: 'second validation ≈ 37 ms', aText: 'structuredClone ≈ 3 ms' },
      ] });
    },
  });

  // 08 ─────────────────────────────────────────────────────────────── sqlite
  S.push({
    id: 'sqlite', title: 'Control-store commits', sub: 'synchronous=NORMAL', modes: AB,
    build(b, mode) {
      const before = mode === 'before';
      const X0 = 140; const PX = 44; const K = 300;
      b.note(`${mode} · 1 ms shown as 300 ms`);
      b.staticText({ x: 24, y: 48, text: 'One prompt request on the daemon main thread', font: 'serif', size: 22, fill: C.ink });
      const lanes = [['main thread', 152, 44], ['disk', 214, 32], ['other work', 264, 32]];
      for (const [label, y, h] of lanes) {
        b.rect({ x: X0, y, w: 1032, h, fill: 'rgba(255,255,255,0.6)', stroke: C.rule, rx: 4, layer: b.bg });
        b.staticText({ x: 24, y: y + h / 2 + 4, text: label, size: 12, fill: C.ink });
      }
      for (let ms = 0; ms <= 22; ms += 2) {
        b.staticText({ x: X0 + ms * PX, y: 318, text: `${ms}`, anchor: 'middle', font: 'mono', size: 9.5 });
        b.line([[X0 + ms * PX, 300], [X0 + ms * PX, 306]], { color: C.soft, arrow: false });
      }
      b.staticText({ x: 1172, y: 318, text: 'ms', anchor: 'end', font: 'mono', size: 9.5 });

      const work = [['decode + admission', 0.6], ['start run', 1.5], ['queue + events', 0.8], ['extensions', 1.3]];
      const commitMs = before ? 3.9 : 0.005;
      const T0 = 1800;
      const segs = [];
      let ms = 0;
      b.staticText({ x: X0, y: 342, text: work.map(([label], i) => `${i + 1} ${label}`).join('   \u00b7   ') + '   (\u2248 4.2 ms of real work either way)', font: 'mono', size: 10 });
      work.forEach(([, d], i) => {
        segs.push({ label: `${i + 1}`, start: ms, d, kind: 'evt' });
        ms += d;
        segs.push({ label: before ? 'COMMIT 3.9 ms' : 'COMMIT', start: ms, d: commitMs, kind: 'io' });
        ms += commitMs;
      });
      const total = ms;
      for (const s of segs) {
        const x = X0 + s.start * PX;
        const w = Math.max(2, s.d * PX);
        const k = KINDS[s.kind];
        const r = b.rect({ x, y: 156, w: 0, h: 36, fill: k.fill, stroke: k.stroke, rx: 3 });
        const at = T0 + s.start * K;
        b.tw(at, Math.max(60, s.d * K), p => { r.m.w = w * p; }, 'lin');
        if (s.kind === 'evt') b.show(b.txt({ x: x + w / 2, y: 178, text: s.label, anchor: 'middle', font: 'mono', size: 10.5, weight: 600, fill: k.text, op: 0 }), at, 200);
        if (s.kind === 'io') {
          if (before) {
            b.show(b.txt({ x: x + 6, y: 178, text: s.label, font: 'mono', size: 10, fill: k.text, op: 0 }), at, 200);
            const disk = b.rect({ x, y: 218, w: 0, h: 24, fill: KINDS.bad.fill, stroke: C.bad, rx: 3 });
            b.tw(at + 0.2 * K, (s.d - 0.2) * K, p => { disk.m.w = (s.d - 0.2) * PX * p; }, 'lin');
            b.set(disk, at, { x: x + 0.2 * PX });
            b.show(b.txt({ x: x + 0.2 * PX + 6, y: 234, text: 'F_FULLFSYNC', font: 'mono', size: 10, fill: C.bad, op: 0 }), at + 0.2 * K, 200);
          } else {
            b.show(b.txt({ x: x - 2, y: 148, text: '5 µs', anchor: 'middle', font: 'mono', size: 9, fill: C.io, op: 0 }), at, 200);
          }
        }
      }
      const head = b.rect({ x: X0, y: 140, w: 2, h: 164, fill: C.ink, rx: 1, op: 0 });
      b.show(head, T0, 100);
      b.tw(T0, total * K, p => { head.m.x = X0 + total * PX * p; }, 'lin');
      const ackX = X0 + total * PX;
      const ack = b.rect({ x: ackX, y: 136, w: 3, h: 168, fill: C.accent, rx: 1, op: 0 });
      const ackLabel = b.txt({ x: ackX + 8, y: 136, text: `reply sent · ${total.toFixed(1)} ms`, font: 'mono', size: 11, fill: C.accent, op: 0 });
      b.show(ack, T0 + total * K, 200); b.show(ackLabel, T0 + total * K, 200);

      const tokens = before ? [2.0, 7.0, 12.4, 17.1] : [1.0, 2.6, 3.7];
      if (!before) b.staticText({ x: X0 + 12, y: 234, text: 'no fsync per commit · the WAL is synced at checkpoint', font: 'mono', size: 10.5 });
      tokens.forEach(a => {
        const blocking = segs.find(s => s.kind === 'io' && s.start <= a && a < s.start + s.d);
        const wait = blocking ? blocking.start + blocking.d - a : 0;
        const p = b.pkt({ kind: 'dlt', label: 'token' });
        const at = T0 + a * K;
        b.set(p, at, { x: X0 + a * PX, y: 280 });
        b.show(p, at, 150);
        if (wait > 0) {
          const bar = b.rect({ x: X0 + a * PX + 22, y: 276, w: 0, h: 8, fill: C.bad, rx: 2, op: 0.5 });
          b.tw(at, wait * K, q => { bar.m.w = Math.max(0, wait * PX - 22) * q; }, 'lin');
          b.show(b.txt({ x: X0 + a * PX + 26, y: 260, text: `waits ${wait.toFixed(1)} ms`, font: 'mono', size: 9.5, fill: C.bad, op: 0 }), at + 200, 200);
          b.set(p, at + wait * K, { kind: 'ok', label: 'handled' });
        } else {
          b.set(p, at + 150, { kind: 'ok', label: 'handled' });
        }
      });

      b.beat(0, 'Commands commit control state', `<p>The control store (SQLite in WAL mode) records sessions with their run state and revisions, requests, interactions and continuations, so a restarted daemon can answer a retried request without running it twice. <code>node:sqlite</code> is synchronous: while a commit runs, the daemon's event loop does nothing else. A prompt causes several commits (4–6 in the investigation).</p>`);
      b.beat(T0, before ? 'FULL + fullfsync: every commit waits for the SSD' : 'NORMAL: a commit is a WAL append', before
        ? `<p>With <code>synchronous=FULL</code> and <code>fullfsync=ON</code>, every COMMIT issues <code>F_FULLFSYNC</code>, which waits until the drive has the data in stable storage: about <span class="was">3.9 ms</span> per commit on this Mac.</p>`
        : `<p>With <code>synchronous=NORMAL</code> in WAL mode, COMMIT appends to the write-ahead log and returns. The log is synced when it is checkpointed (still with full fsync). A commit now takes <span class="num">≈ 5 µs</span> (p50 5.2 µs, p99 8.8 µs).</p>`);
      const T3 = T0 + total * K + 600;
      b.beat(T3, before ? 'Everything else waits too' : 'Nothing waits for the disk', before
        ? `<p>Tokens for other sessions, other clients' requests and replies all queue behind each commit. The prompt reply left after <span class="was">≈ 20 ms</span> (17–29 ms measured); <code>set_thinking</code> took 13–14 ms.</p>`
        : `<p>The reply leaves after <span class="num">4.2 ms</span>, nearly all of it real work. Tokens that arrive meanwhile are handled at once. <code>set_thinking</code>: <span class="was">13–14 ms</span> → <span class="num">2.5 ms</span>.</p>`);
      const numbers = b.card({ x: 616, y: 364, w: 560, title: 'measured', kind: before ? 'bad' : 'ok', lines: [
        { text: 'COMMIT p50   3.9 ms  →  5.2 µs  (p99 8.8 µs)', mono: true },
        { text: 'prompt ack   17–29 ms  →  4.2 ms', mono: true },
        { text: 'set_thinking 13–14 ms  →  2.5 ms', mono: true },
        { text: 'before: investigation · after: perf suite (ADR 0042)', size: 11, color: C.muted }] });
      b.show(numbers, T3 + 300);

      const T4 = T3 + 3000;
      if (before) {
        b.beat(T4, 'Why it was this way', `<p>FULL with fullfsync makes each individual commit survive a power loss, at the cost of milliseconds per commit on the main thread.</p>`);
        b.show(b.card({ x: 24, y: 364, w: 560, title: 'what FULL + fullfsync bought', kind: 'bad', lines: [
          '✓ every commit survives power loss',
          '✗ every COMMIT waits for F_FULLFSYNC (≈ 3.9 ms)',
          '✗ the event loop is blocked while it waits'] }), T4 + 200);
      } else {
        b.beat(T4, 'The trade-off (ADR 0042)', `<p>A crash of Felan or the daemon loses nothing that was committed. An OS crash or power loss can lose the commits since the log was last synced; a retried request may then run again, and session revision numbers can go backwards. Pi writes transcripts without fsync, so this is in line with the durability of the content itself. The decision is recorded in ADR 0042.</p>`);
        b.show(b.card({ x: 24, y: 364, w: 560, title: 'what NORMAL means', kind: 'io', lines: [
          '✓ Felan or daemon crash: committed data survives',
          '⚠ OS crash or power loss: the last commits',
          '   since the WAL sync can be lost',
          '→ a retried request may run again,',
          '   and revisions can go backwards'] }), T4 + 200);
      }
      b.legend(['evt', 'io', 'dlt', 'ok', 'bad']);
    },
  });

  // 09 ─────────────────────────────────────────────────────────────── tui
  S.push({
    id: 'tui', title: 'TUI rendering', sub: 'Prompt echo, streaming markdown, frames', modes: AB,
    build(b, mode) {
      const before = mode === 'before';
      b.note(`${mode} · motion slowed`);
      b.rect({ x: 24, y: 60, w: 720, h: 524, fill: '#fbfbf9', stroke: C.ink, rx: 8, layer: b.bg });
      b.rect({ x: 24, y: 60, w: 720, h: 28, fill: C.paper2, stroke: C.ink, rx: 8, layer: b.bg });
      b.staticText({ x: 40, y: 79, text: 'felan · session s1', font: 'mono', size: 11 });
      b.rect({ x: 24, y: 540, w: 720, h: 1, fill: C.rule, layer: b.bg });
      const type = (actor, full, t, msPerChar = 26) => { b.tw(t, full.length * msPerChar, p => { actor.m.text = full.slice(0, Math.round(full.length * p)); }, 'lin'); return t + full.length * msPerChar; };
      const line = (y, fill = C.ink, x = 44) => b.txt({ x, y, text: '', font: 'mono', size: 13, fill });

      const editor = line(566, C.ink);
      b.staticText({ x: 30, y: 566, text: '›', font: 'mono', size: 13, fill: C.link });
      const promptLine = line(124, C.link);
      const promptTag = b.txt({ x: 728, y: 124, text: '', anchor: 'end', font: 'mono', size: 10.5, fill: C.soft });

      const P = 'fix the flaky fan-out test';
      b.beat(0, before ? 'Your prompt appeared after the daemon confirmed it' : 'Your prompt appears at once', before
        ? `<p>The editor cleared on Enter, but the prompt only appeared in the transcript once the daemon's user message came back: after admission, commits and the start of the run.</p>`
        : `<p>On Enter the TUI adds the prompt to the transcript right away, marked as pending, and sends the request. When the user message reaches the session history (the daemon's <code>message.completed</code>), the echo is bound to it, so it never shows twice. It matches by text; because input hooks can rewrite a prompt, an accepted prompt whose run is active also takes the first unclaimed user message. A rejected prompt removes its echo. Only the newest 32 confirmed echoes are kept. Steering and follow-up messages are not echoed.</p>`);
      const typed = type(editor, P, 400, 22);
      const enter = typed + 300;
      b.set(editor, enter, { text: '' });
      const confirm = enter + 1600;
      const req = b.pkt({ kind: 'req', label: 'prompt →' });
      b.move(req, [600, 566], [720, 566], enter, 400); b.hide(req, enter + 400, 200);
      const back = b.pkt({ kind: 'res', label: '← message.completed' });
      b.move(back, [720, 150], [560, 150], confirm - 500, 500); b.hide(back, confirm, 200);
      if (before) {
        b.set(promptTag, enter, { text: 'waiting for the daemon…' });
        b.set(promptLine, confirm, { text: `› ${P}` });
        b.set(promptTag, confirm, { text: '' });
      } else {
        b.set(promptLine, enter, { text: `› ${P}` });
        b.set(promptTag, enter, { text: 'pending (echo)' });
        b.set(promptTag, confirm, { text: 'confirmed · bound to m6', fill: C.ok });
      }

      const blocks = [
        { y: 150, h: 28, lines: [[168, '## Why it flakes']] },
        { y: 186, h: 50, lines: [[204, 'Each delta became its own frame, so a slow'], [226, 'client hit the 1,024-frame limit.']] },
        { y: 244, h: 72, lines: [[262, '```ts'], [284, 'fanout.send(delta) // merges into the tail'], [306, '```']] },
        { y: 324, h: 50, lines: [[342, '- merge contiguous deltas'], [364, '- close with end(), not destroy()']] },
      ];
      const totalChars = blocks.reduce((n, block) => n + block.lines.reduce((m, [, s]) => m + s.length, 0), 0);
      const SCALE = 380 / totalChars;
      b.staticText({ x: 780, y: 84, text: 'WORK PER STREAMED UPDATE', font: 'mono', size: 10, spacing: '0.12em' });
      b.staticText({ x: 780, y: 108, text: 'whole message, re-lexed + re-wrapped (before)', size: 11.5 });
      b.rect({ x: 780, y: 116, w: 384, h: 14, fill: C.paper2, rx: 3, layer: b.bg });
      const barBefore = b.rect({ x: 780, y: 116, w: 0, h: 14, fill: '#b9bfcb', rx: 3 });
      b.staticText({ x: 780, y: 154, text: 'only the open block (after)', size: 11.5 });
      b.rect({ x: 780, y: 162, w: 384, h: 14, fill: C.paper2, rx: 3, layer: b.bg });
      const barAfter = b.rect({ x: 780, y: 162, w: 0, h: 14, fill: C.accent, rx: 3 });

      const T2 = confirm + 800;
      b.beat(T2, before ? 'Streaming: the whole answer re-rendered on every update' : 'Streaming: only the open block re-renders', before
        ? `<p>Each delta replaced the message text, and the markdown component re-lexed and re-wrapped the entire answer. The work per update grew with the answer, so long answers slowed down as they streamed: quadratic in total.</p><p>On a 20 KB code-heavy answer: <span class="was">≈ 9.9 s</span> of rendering.</p>`
        : `<p>The answer is split into top-level markdown blocks at blank lines. Finished blocks are rendered once and cached; only the open block at the end is re-lexed and re-wrapped. A block settles only once the next block's first line is complete, so splitting never changes the output.</p><p>On a 20 KB code-heavy answer: <span class="was">≈ 9.9 s</span> → <span class="num">≈ 0.27 s</span> of rendering.</p>`);
      const whole = b.rect({ x: 36, y: 150, w: 696, h: 28, fill: 'none', stroke: C.accent, sw: 2, rx: 4, op: 0 });
      const wholeLabel = b.txt({ x: 732, y: 144, text: 'whole message re-rendered', anchor: 'end', font: 'mono', size: 10, fill: C.accent, op: 0 });
      let t = T2 + 300;
      let doneChars = 0;
      let previous;
      blocks.forEach((block, k) => {
        const outline = b.rect({ x: 36, y: block.y, w: 696, h: block.h, fill: 'none', stroke: C.accent, sw: 2, rx: 4, op: 0 });
        const label = b.txt({ x: 728, y: block.y + 16, text: 'open block', anchor: 'end', font: 'mono', size: 10, fill: C.accent, op: 0 });
        const start = t;
        if (before) {
          b.show(whole, start, 200); b.show(wholeLabel, start, 200);
          b.tw(start, 300, p => { whole.m.h = Math.max(whole.m.h, (block.y + block.h - 150) * p + (k ? blocks[k - 1].y + blocks[k - 1].h - 150 : 28) * (1 - p)); });
        } else {
          b.show(outline, start, 200); b.show(label, start, 200);
        }
        let blockChars = 0;
        for (const [y, text] of block.lines) {
          const actor = line(y, text.startsWith('```') || text.startsWith('fanout') ? C.snap : text.startsWith('##') ? C.accent : C.ink);
          const prevDone = doneChars; const prevBlock = blockChars;
          b.tw(t, text.length * 30, p => {
            const n = Math.round(text.length * p);
            actor.m.text = text.slice(0, n);
            barBefore.m.w = SCALE * (prevDone + n);
            barAfter.m.w = SCALE * (prevBlock + n);
          }, 'lin');
          t += text.length * 30 + 120;
          if (!before && previous && blockChars === 0) {
            b.set(previous.outline, t, { stroke: C.ok });
            b.set(previous.label, t, { text: 'cached', fill: C.ok });
          }
          doneChars += text.length; blockChars += text.length;
        }
        previous = { outline, label };
        t += 300;
      });
      const cpuCard = b.card({ x: 780, y: 200, w: 396, title: '20 KB code-heavy answer (bench)', kind: 'ok', lines: [
        { text: 'whole-document render   ≈ 9.9 s', mono: true, color: C.bad },
        { text: 'incremental render      ≈ 0.27 s', mono: true, color: C.ok },
        'Same output: tests compare it with one full', 'render at every prefix and several widths.'] });
      b.show(cpuCard, t - 600);

      const T3 = t + 600;
      b.beat(T3, 'When it falls back to whole-document rendering', `<p>Some markdown can change how earlier text renders: HTML blocks that may span blank lines (<code>&lt;pre&gt;</code>, <code>&lt;script&gt;</code>, <code>&lt;style&gt;</code>, <code>&lt;textarea&gt;</code>, <code>&lt;!</code> comments and declarations, <code>&lt;?</code>), math blocks that start a line with <code>$$</code> or <code>\\[</code>, and reference definitions like <code>[x]: https://…</code>. A line start may be indented up to three spaces. A message containing one of those is rendered as a whole document, as before. Inline <code>$$</code> or <code>&lt;</code>, and tabs on their own, do not trigger it.</p>`);
      const fallback = b.card({ x: 780, y: 330, w: 396, title: 'falls back to whole document', kind: 'io', lines: [
        { text: '<pre> <script> <style> <textarea>', mono: true },
        { text: '<!   <?   at the start of a line', mono: true },
        { text: '$$ or \\[ at the start of a line', mono: true },
        { text: '[label]: https://…  (reference)', mono: true }] });
      b.show(fallback, T3 + 200);

      const T4 = T3 + 3200;
      b.beat(T4, 'Frames, not tokens, reach the terminal', `<p>pi-tui renders streamed updates at most once every 16 ms and rewrites only the range of lines that changed. Tokens that arrive between frames share the next one. That is why token → terminal is <span class="num">p50 ≈ 13 ms</span> while token → client state is <span class="num">≈ 0.2 ms</span>. Keystrokes skip the throttle and render immediately, so echo stays at about 1–3 ms, idle or while streaming.</p>`);
      const fx = ms => 780 + ms * 3;
      const strip = [
        b.txt({ x: 780, y: 480, text: 'PI-TUI FRAMES · AT MOST ONE PER 16 MS', font: 'mono', size: 10, fill: C.muted, op: 0 }),
        b.rect({ x: 780, y: 528, w: 384, h: 1, fill: C.muted, op: 0 }),
        b.txt({ x: 1164, y: 546, text: '128 ms', anchor: 'end', font: 'mono', size: 9.5, fill: C.muted, op: 0 }),
        b.txt({ x: 780, y: 546, text: '0', font: 'mono', size: 9.5, fill: C.muted, op: 0 }),
      ];
      for (const s of strip) b.show(s, T4 + 100, 200);
      const R = 3000 / 128;
      const tokens = [3, 5, 9, 14, 19, 22, 27, 33, 41, 44, 52, 57, 63, 70, 74, 81, 90, 95, 101, 108, 115, 121];
      for (const ms of tokens) {
        const dot = b.rect({ x: fx(ms) - 2, y: 494, w: 4, h: 10, fill: C.accent, rx: 1, op: 0 });
        b.show(dot, T4 + 300 + ms * R, 100);
      }
      for (let f = 16; f <= 128; f += 16) {
        const frame = b.rect({ x: fx(f) - 7, y: 510, w: 14, h: 14, fill: KINDS.ok.fill, stroke: C.ok, rx: 2, op: 0 });
        b.show(frame, T4 + 300 + f * R, 120);
      }
      b.show(b.txt({ x: 780, y: 566, text: 'orange: tokens arriving · green: frames written', font: 'mono', size: 9.5, fill: C.muted, op: 0 }), T4 + 300, 200);
    },
  });

  // 10 ─────────────────────────────────────────────────────────────── startup
  S.push({
    id: 'startup', title: 'Startup & session create', sub: 'Lazy imports, no dispose and reopen',
    build(b) {
      b.note('bars: before (gray) vs after (green)');
      b.staticText({ x: 24, y: 56, text: 'Cold start to first TUI frame', font: 'serif', size: 20, fill: C.ink });
      b.staticText({ x: 616, y: 56, text: 'Round trips', font: 'serif', size: 20, fill: C.ink });
      b.beat(0, 'Load fewer modules before the first frame', `<p>Cold start includes loading and compiling every ES module the first frame imports. Modules it doesn't need are now imported where they are used: command-line option definitions (only when flags need parsing), the updater, dependency onboarding, preference screens, the session and tree navigators, and the daemon process code. The client reads the daemon version and host config through small public exports such as <code>@felan-ai/daemon/version</code> and <code>@felan-ai/daemon/host-config</code>.</p>`);
      b.bars({ x: 24, y: 96, w: 560, t: 500, labelW: 140, valueW: 120, rows: [
        { label: 'empty session', b: 660, a: 394, bText: '620–700 ms', aText: '394 ms' },
        { label: '30-turn session', b: 1250, a: 896, bText: '1.2–1.3 s', aText: '896 ms' },
      ] });
      b.beat(3400, 'Fewer waits per request', `<p>These follow from microsecond commits and less work per refresh (chapters 4 and 8). Prompt to first token measured 12–13 ms on later turns and 87 ms on the first turn.</p>`);
      b.bars({ x: 616, y: 96, w: 560, t: 3600, labelW: 170, valueW: 110, rows: [
        { label: 'prompt acknowledged', b: 23, a: 4.2, bText: '17–29 ms', aText: '4.2 ms' },
        { label: 'set_thinking', b: 13.5, a: 2.5, bText: '13–14 ms', aText: '2.5 ms' },
      ] });

      const T3 = 6800;
      b.beat(T3, 'sessions.create: stop disposing what was just built', `<p>Creating a session opened a full runtime, disposed it only to write the session header, then opened it again, and disposal waited for providers to settle. Now the prepared runtime is kept: the header is written as before (exclusive create, then fsync of the file and its directory), and the same Pi session manager is pointed at the file with <code>setSessionFile</code>. <code>sessions.create</code> took <span class="was">450–525 ms</span> in the investigation and <span class="num">230 ms</span> in the full perf run.</p>`);
      b.show(b.txt({ x: 24, y: 340, text: 'sessions.create', font: 'serif', size: 20, fill: C.ink, op: 0 }), T3);
      b.bars({ x: 24, y: 380, w: 1152, t: T3 + 200, labelW: 200, valueW: 140, rows: [
        { label: 'request round trip', b: 487, a: 230, bText: '450–525 ms', aText: '230 ms' },
      ] });
      b.show(b.card({ x: 24, y: 500, w: 560, title: 'fix', kind: 'ok', lines: [
        'Keep the prepared runtime. Write the header (O_EXCL,',
        'fsync), then setSessionFile on the same manager.'] }), T3 + 1800);

      const T4 = T3 + 3600;
      b.beat(T4, 'Still on the table', `<ul><li>First turn: prompt to first token is 87 ms, against 12–13 ms on later turns.</li><li>Idle daemon CPU measured 2.3% of one core in the full perf run (1.65% in the investigation); the 25 ms ownership check is the daemon's main periodic timer.</li><li>Token → terminal is set by pi-tui's 16 ms frame cap, by design.</li></ul>`);
      b.show(b.card({ x: 616, y: 500, w: 560, title: 'not done yet', kind: 'io', lines: [
        'first turn: 87 ms to first token (later: 12–13 ms)',
        '25 ms ownership timer: main idle wake-up'] }), T4 + 200);
    },
  });

  // 11 ─────────────────────────────────────────────────────────────── remote
  S.push({
    id: 'remote', title: 'Remote clients', sub: 'Through the Felan platform', modes: [{ id: 'today', label: 'Today' }, { id: 'proposed', label: 'Proposed' }],
    build(b, mode) {
      const today = mode === 'today';
      b.note(today ? 'apps/daemon/src/remote · static reading' : 'proposal · not built');
      b.zone({ x: 24, y: 100, w: 272, h: 460, label: 'Daemon · your machine' });
      b.zone({ x: 344, y: 100, w: 512, h: 460, label: today ? 'Felan platform (Supabase)' : 'Cloud' });
      b.zone({ x: 904, y: 100, w: 272, h: 460, label: today ? 'Platform clients' : 'Web · mobile · desktop' });
      const web = b.box({ x: 924, y: 160, w: 232, h: 56, title: 'Web', sub: today ? 'subscribe + fetch' : 'same reducer as the TUI' });
      const mobile = b.box({ x: 924, y: 300, w: 232, h: 56, title: 'Mobile', sub: today ? 'not built · same path' : 'same reducer' });
      const desktop = b.box({ x: 924, y: 440, w: 232, h: 56, title: 'Desktop', sub: today ? 'not built · same path' : 'same reducer' });

      if (today) {
        b.line([[160, 192], [160, 224]]); b.line([[160, 280], [160, 312]]);
        b.line([[276, 340], [368, 340]], { color: C.io }); b.line([[568, 340], [632, 340]], { color: C.io });
        b.line([[732, 312], [732, 280], [600, 280], [600, 236]], { color: C.evt, dash: '4,3' });
        b.line([[700, 208], [924, 188]], { color: C.evt });
        b.line([[276, 428], [320, 428], [320, 208], [500, 208]], { color: C.accent });
        b.line([[924, 516], [700, 516]], { color: C.link }); b.line([[500, 516], [276, 516]], { color: C.link });
        const proj = b.box({ x: 44, y: 136, w: 232, h: 56, title: 'Projection', sub: 'events + text deltas' });
        const filter = b.box({ x: 44, y: 224, w: 232, h: 56, title: 'Share filter + sanitizer', sub: 'secrets withheld' });
        const outbox = b.box({ x: 44, y: 312, w: 232, h: 56, title: 'Outbox', sub: 'control SQLite', tone: 'store' });
        const textbuf = b.box({ x: 44, y: 400, w: 232, h: 56, title: 'Live text buffer', sub: 'per stream' });
        const journal = b.box({ x: 44, y: 488, w: 232, h: 56, title: 'Command journal', sub: 'claim → admission' });
        const bcast = b.box({ x: 500, y: 180, w: 200, h: 56, title: 'Realtime Broadcast', sub: 'private channels' });
        const rpc = b.box({ x: 368, y: 312, w: 200, h: 56, title: 'publish RPC', sub: 'batch per wake-up' });
        const rows = b.box({ x: 632, y: 312, w: 200, h: 56, title: 'Event rows', sub: 'seq per session', tone: 'store' });
        const cmds = b.box({ x: 500, y: 488, w: 200, h: 56, title: 'Command rows', tone: 'store' });

        b.beat(0, 'Today: two lanes and a command queue', `<p>Web clients do not connect to the daemon's socket. The daemon's remote connector talks to the Felan platform in two ways: a durable outbox for history and state, and a best-effort lane for live text. Commands come back as rows. The <a href="../../shared-session-daemon/remote-connector.md">remote connector design</a> has the full contract.</p>`);
        const T2 = 1600;
        b.beat(T2, 'Durable lane: outbox, rows, fetch', `<p>Shared session changes are filtered, sanitized and appended to an outbox in the control SQLite database. A publisher drains it by RPC (<code>publish_session_events</code>) into platform rows with a per-session <code>seq</code>; changes that arrive while an RPC is in flight go out in the next batch. A Broadcast notification then says only “new rows up to seq N”, and the client fetches the rows.</p>`);
        let t = b.route(b.pkt({ kind: 'evt', label: 'tool.updated' }), [[160, 164], { x: 160, y: 252, pulse: filter }, { x: 160, y: 340, pulse: outbox }], T2 + 200, { speed: 0.35 });
        b.pulse(proj, T2 + 100);
        t = b.route(b.pkt({ kind: 'io', label: 'batch' }), [[276, 340], { x: 468, y: 340, pulse: rpc, dwell: 400 }, { x: 732, y: 340, pulse: rows }], t + 300, { speed: 0.35 });
        t = b.route(b.pkt({ kind: 'evt', label: 'events {seq: 18}' }), [[732, 312], [732, 280], [600, 280], { x: 600, y: 208, pulse: bcast }, { x: 1040, y: 188, pulse: web }], t + 100, { speed: 0.4 });
        const fetch = b.pkt({ kind: 'req', label: 'fetch rows after seq 17' });
        t = b.route(fetch, [[1040, 216], [1040, 260], { x: 732, y: 260 }, { x: 732, y: 312, pulse: rows }], t + 200, { speed: 0.4 });
        t = b.route(b.pkt({ kind: 'res', label: 'rows 18' }), [[732, 312], [732, 260], [1040, 260], { x: 1040, y: 216, pulse: web }], t + 200, { speed: 0.4 });

        const T3 = t + 800;
        b.beat(T3, 'Live text lane: Broadcast, at most every 250 ms', `<p>Assistant and thinking deltas are sanitized and sent over the session's private Broadcast channel, best effort: a stream's first chunk at once, then at most one chunk per 250 ms. There is no replay and no snapshot for this lane: a client that joins mid-answer, or misses a message, cannot recover the partial text; it sees the answer only when the completed message arrives through the durable lane.</p>`);
        ['"The"', '" queue"', '" over"'].forEach((label, i) => {
          b.route(b.pkt({ kind: 'dlt', label }), [[160, 164], [300, 164], { x: 300, y: 428 }], T3 + 200 + i * 200, { speed: 0.6 });
        });
        b.pulse(textbuf, T3 + 900, 900);
        const batch = b.pkt({ kind: 'dlt', label: 'text · 250 ms batch' });
        t = b.route(batch, [[276, 428], [320, 428], [320, 208], { x: 600, y: 208, pulse: bcast }, { x: 1040, y: 188, pulse: web }], T3 + 1500, { speed: 0.4 });
        const lost = b.pkt({ kind: 'bad', label: 'joined late: no partial text' });
        b.set(lost, t + 300, { x: 1040, y: 380 });
        b.show(lost, t + 300, 200);

        const T4 = t + 1800;
        b.beat(T4, 'Commands: rows, hints, claims', `<p>Web commands (create session, prompt, steer, follow-up, cancel, answer an interaction) are inserted as rows. The daemon gets a hint, claims them by RPC, journals them and runs them through normal admission. The outcome returns the same way.</p>`);
        t = b.route(b.pkt({ kind: 'req', label: 'insert prompt' }), [[1040, 468], [1040, 516], { x: 600, y: 516, pulse: cmds }], T4 + 200, { speed: 0.4 });
        t = b.route(b.pkt({ kind: 'req', label: 'claim → admission' }), [[500, 516], { x: 160, y: 516, pulse: journal }], t + 300, { speed: 0.4 });
        b.show(b.card({ x: 344, y: 576, w: 832, kind: 'io', lines: [{ text: 'Live text: up to 250 ms of batching per chunk, best effort, no resume. State: outbox + RPC + notification + fetch.', size: 12 }] }), t + 300);
      } else {
        b.line([[276, 268], [480, 268]], { color: C.link });
        b.line([[720, 268], [924, 188]], { color: C.link }); b.line([[720, 276], [924, 328]], { color: C.link }); b.line([[720, 284], [924, 468]], { color: C.link });
        b.line([[160, 436], [160, 496], [480, 496]], { color: C.io, dash: '4,3' });
        const proj = b.box({ x: 44, y: 136, w: 232, h: 56, title: 'Projection', sub: 'deltas + events' });
        const server = b.box({ x: 44, y: 232, w: 232, h: 72, title: 'Server + fan-out', sub: 'merge · batch · ordering', tone: 'focal' });
        const outbox = b.box({ x: 44, y: 380, w: 232, h: 56, title: 'Outbox', sub: 'history + sharing (kept)', tone: 'store' });
        const relay = b.box({ x: 480, y: 232, w: 240, h: 72, title: 'Authenticated relay', sub: 'WebSocket · forwards frames', tone: 'focal' });
        const hist = b.box({ x: 480, y: 468, w: 240, h: 56, title: 'History / sharing', sub: 'platform rows', tone: 'store' });
        b.line([[160, 192], [160, 232]]);

        b.beat(0, 'Proposed: one relay, the same frames', `<p>A performance analysis of the connector suggested keeping the outbox for history and sharing, and adding an authenticated WebSocket relay that carries the frames the TUI already receives. In this sketch the daemon connects out to the relay, so nothing new listens on your machine; direct connections can stay optional.</p>`);
        b.pulse(server, 400); b.pulse(relay, 800);
        const T2 = 1800;
        b.beat(T2, 'Attach works the same remotely', `<p>A web, mobile or desktop client says <code>hello</code>, attaches, gets a snapshot, then follows events and deltas, with the same ordering rules and the same reducer as the TUI. Reconnecting is just attaching again.</p>`);
        let t = b.route(b.pkt({ kind: 'req', label: 'hello · attach s1' }), [[1040, 188], { x: 600, y: 268, pulse: relay }, { x: 160, y: 268, pulse: server }], T2 + 200, { speed: 0.45 });
        t = b.route(b.pkt({ kind: 'snap', label: 'snapshot (rev 42)' }), [[160, 268], { x: 600, y: 268, pulse: relay }, { x: 1040, y: 188, pulse: web }], t + 200, { speed: 0.45 });

        const T3 = t + 600;
        b.beat(T3, 'Live text keeps its batching', `<p>The fan-out already merges contiguous deltas and writes once per loop turn. Over WebSocket, batching was 2.9× faster than one write per delta in the local bench. What remains is the network round trip itself.</p>`);
        const targets = [[1040, 188, web], [1040, 328, mobile], [1040, 468, desktop]];
        for (let i = 0; i < 3; i++) {
          b.pulse(proj, T3 + 100 + i * 700, 500);
          for (const [x, y, box] of targets) {
            b.route(b.pkt({ kind: i === 1 ? 'evt' : 'dlt', label: ['@0 "The queue"', 'rev 43', '@14 "flows."'][i] }), [[160, 268], { x: 600, y: 268, pulse: relay }, { x, y, pulse: box }], T3 + 300 + i * 700, { speed: 0.5 });
          }
        }
        b.route(b.pkt({ kind: 'io', label: 'history batch' }), [[160, 436], [160, 496], { x: 600, y: 496, pulse: hist }], T3 + 600, { speed: 0.35 });
        b.pulse(outbox, T3 + 500);

        const T4 = T3 + 4200;
        b.beat(T4, 'Status', `<p>This is an unadopted proposal with no ADR; nothing in this chapter is built. The local numbers show what the protocol itself costs. A remote client adds the network round trip on top.</p>`);
        b.show(b.card({ x: 344, y: 576, w: 832, kind: 'ok', lines: [{ text: 'Same frames, same merging, same snapshot recovery as the TUI. Latency ≈ local path + network round trips.', size: 12 }] }), T4 + 200);
      }
    },
  });
})();
