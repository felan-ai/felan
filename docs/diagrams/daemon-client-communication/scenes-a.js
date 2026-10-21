'use strict';
(() => {
  const { C, KINDS, MONO, el } = Felan;
  const S = window.FELAN_SCENES;
  const AB = [{ id: 'after', label: 'After' }, { id: 'before', label: 'Before', tone: 'before' }];
  const COLORS = { req: C.link, res: C.link, evt: C.evt, dlt: C.accent, snap: C.snap, bad: C.bad, ok: C.ok, io: C.io };

  // 01 ─────────────────────────────────────────────────────────────── overview
  S.push({
    id: 'overview', title: 'The big picture', sub: 'One daemon, many clients',
    build(b) {
      b.note('motion slowed ~1000× · real numbers in the cards');
      b.zone({ x: 176, y: 124, w: 440, h: 364, label: 'Daemon · one process per account' });
      b.zone({ x: 720, y: 124, w: 456, h: 364, label: 'Local client · TUI, ACP or headless' });
      b.rect({ x: 616, y: 206, w: 104, h: 68, fill: C.white, stroke: C.ink, rx: 4, layer: b.bg });
      b.staticText({ x: 668, y: 198, text: 'Unix socket', anchor: 'middle', size: 11, fill: C.ink, weight: 600 });
      b.staticText({ x: 668, y: 290, text: 'JSON lines', anchor: 'middle', size: 10, font: 'mono' });

      for (const [a, z] of [[152, 196], [316, 336], [456, 476], [596, 740], [860, 880], [1000, 1020]]) b.line([[a, 228], [z, 228]]);
      for (const [a, z] of [[1020, 1000], [880, 860], [740, 596]]) b.line([[a, 252], [z, 252]], { color: C.link });
      b.line([[536, 276], [536, 360]], { color: C.link });
      b.line([[476, 392], [456, 392]], { color: C.io });
      b.line([[396, 276], [396, 360]], { color: C.io });
      b.line([[536, 424], [536, 456], [256, 456], [256, 276]], { color: C.link });
      b.line([[1060, 276], [1060, 316], [940, 316], [940, 360]]);
      b.line([[1000, 392], [1020, 392]]);
      b.line([[1128, 360], [1128, 276]], { color: C.link });

      const provider = b.box({ x: 24, y: 204, w: 128, h: 72, title: 'LLM provider', sub: 'HTTPS · SSE', tone: 'ext' });
      const pi = b.box({ x: 196, y: 204, w: 120, h: 72, title: 'Pi session', sub: 'agent loop' });
      const proj = b.box({ x: 336, y: 204, w: 120, h: 72, title: 'Projection', sub: 'deltas · events' });
      const server = b.box({ x: 476, y: 204, w: 120, h: 72, title: 'Server', sub: 'fan-out / client' });
      const adm = b.box({ x: 476, y: 360, w: 120, h: 64, title: 'Admission', sub: 'commands' });
      const store = b.box({ x: 336, y: 360, w: 120, h: 64, title: 'Control store', sub: 'SQLite · WAL', tone: 'store' });
      const tr = b.box({ x: 740, y: 204, w: 120, h: 72, title: 'Transport', sub: 'line decoder' });
      const dc = b.box({ x: 880, y: 204, w: 120, h: 72, title: 'SessionClient', sub: 'reducer → state' });
      const tui = b.box({ x: 1020, y: 204, w: 136, h: 72, title: 'TUI controller', sub: 'stream markdown' });
      const rend = b.box({ x: 880, y: 360, w: 120, h: 64, title: 'pi-tui', sub: 'diff · 16 ms' });
      const term = b.box({ x: 1020, y: 360, w: 136, h: 64, title: 'Terminal', sub: 'PTY', tone: 'input' });

      b.beat(0, 'One daemon owns every session', `<p>The daemon is one long-lived process per account. It runs the Pi agent sessions, admits commands, keeps control state in SQLite and owns child processes.</p><p>The TUI is a thin client. It connects over an owner-only Unix socket, receives one <b>snapshot</b> of the session, then follows a stream of small JSON frames. ACP and headless clients speak the same protocol over the same socket. Web clients reach the daemon through its cloud connector instead (chapter 11).</p>`);
      [pi, proj, server, adm, store, tr, dc, tui, rend, term].forEach((box, i) => b.pulse(box, 500 + i * 260, 700));

      const T2 = 4000;
      b.beat(T2, 'You press Enter', `<p>The keystroke stays local: the TUI draws your prompt immediately (<b>prompt echo</b>), then sends a <code>prompt</code> request. The server admits it and commits it to the control store, starts the run, commits the outcome and replies <code>accepted</code> with the run id.</p><p>Acknowledgement went from <span class="was">17–29 ms</span> to <span class="num">4.2 ms</span>, mostly because a commit no longer waits for the disk (chapter 8).</p>`);
      const key = b.pkt({ kind: 'req', label: '⏎' });
      let t = b.route(key, [[1128, 392], { x: 1128, y: 240, pulse: tui }], T2 + 300, { speed: 0.3 });
      b.set(term, t, { sub: 'you › fix the test' });
      const echo = b.txt({ x: 1156, y: 448, text: 'echo drawn locally, before any reply', anchor: 'end', size: 10, font: 'mono', fill: C.ok, op: 0 });
      b.show(echo, t, 300);
      const prompt = b.pkt({ kind: 'req', label: 'prompt' });
      t = b.route(prompt, [[1088, 252], { x: 940, y: 252, pulse: dc }, { x: 800, y: 252, pulse: tr }, { x: 536, y: 252, pulse: server }, { x: 536, y: 392, pulse: adm }], t + 200);
      const commit = b.pkt({ kind: 'io', label: 'COMMIT' });
      const tc = b.route(commit, [[536, 392], { x: 396, y: 392, pulse: store }], t, { speed: 0.3 });
      const run = b.pkt({ kind: 'req', label: 'start run' });
      const tRun = b.route(run, [[536, 424], [536, 456], [256, 456], { x: 256, y: 240, pulse: pi }], tc, { speed: 0.5 });
      const ack = b.pkt({ kind: 'res', label: 'accepted' });
      const tAck = b.route(ack, [[536, 228], { x: 800, y: 228, pulse: tr }, { x: 940, y: 228, pulse: dc }], tRun);
      const cardAck = b.card({ x: 728, y: 30, w: 210, title: 'prompt acknowledged', kind: 'ok', lines: [{ text: '17–29 ms → 4.2 ms', mono: true, color: C.ok }, 'commits now take µs'] });
      b.show(cardAck, tAck);

      const T3 = Math.max(tRun, tAck) + 700;
      b.beat(T3, 'Tokens stream back', `<p>The provider streams tokens over SSE. Pi turns each chunk into a text delta, the projection stamps it with a code-point <code>offset</code>, and the server writes it to every attached client. The client's reducer appends it to the active stream, and the TUI re-renders only the open markdown block.</p><p>Provider → client state: <span class="num">p50 0.16–0.19 ms</span>. Provider → terminal: <span class="num">p50 ≈ 13 ms</span>, set by pi-tui's 16 ms minimum between frames.</p>`);
      const path = [[88, 228], { x: 256, y: 228, pulse: pi }, { x: 396, y: 228, pulse: proj }, { x: 536, y: 228, pulse: server }, { x: 800, y: 228, pulse: tr },
        { x: 940, y: 228, pulse: dc }, { x: 1060, y: 228, pulse: tui }, [1060, 316], [940, 316], { x: 940, y: 392, pulse: rend }, { x: 1088, y: 392, pulse: term }];
      let shown = '';
      let lastToken = T3;
      ['The', ' queue', ' over', 'flows', '.'].forEach((word, i) => {
        const token = b.pkt({ kind: 'dlt', label: JSON.stringify(word) });
        b.pulse(provider, T3 + 100 + i * 450, 500);
        lastToken = b.route(token, path, T3 + 300 + i * 450, { speed: 0.6 });
        shown += word;
        b.set(term, lastToken, { sub: shown });
      });
      const cardTok = b.card({ x: 176, y: 30, w: 260, title: 'token → client state', kind: 'ok', lines: [{ text: 'p50 0.16–0.19 ms', mono: true, color: C.ok }, 'provider chunk to reducer state'] });
      const cardTerm = b.card({ x: 452, y: 30, w: 260, title: 'token → terminal', kind: 'ok', lines: [{ text: 'p50 ≈ 13 ms', mono: true, color: C.ok }, 'paced by pi-tui’s 16 ms frames'] });
      b.show(cardTok, T3 + 1700);
      b.show(cardTerm, lastToken);

      const T4 = lastToken + 600;
      b.beat(T4, 'State changes travel as numbered events', `<p>Everything else (tools, run state, queue, model, title, completed messages) is a <b>session change</b> with a revision number. The projection coalesces most of them for 25 ms, then commits and publishes one event per changed item as <code>rev n+1</code>, <code>n+2</code>, …; run transitions go out at once. Text deltas carry no revision. Clients apply revisions strictly in order; a gap makes them attach again for a fresh snapshot.</p>`);
      ['tool.updated · rev 42', 'run.updated · rev 43'].forEach((label, i) => {
        const start = T4 + 400 + i * 1000;
        b.pulse(proj, start - 200, 600);
        b.route(b.pkt({ kind: 'evt', label }), [[396, 228], { x: 536, y: 228, pulse: server }, { x: 800, y: 228, pulse: tr }, { x: 940, y: 228, pulse: dc }, { x: 1060, y: 228, pulse: tui }], start);
        b.route(b.pkt({ kind: 'io', label: 'COMMIT' }), [[396, 280], { x: 396, y: 392, pulse: store }], start, { speed: 0.3 });
      });

      const T5 = T4 + 4400;
      b.beat(T5, 'What it adds up to', `<p>In the full perf run: a Unix socket round trip takes <span class="num">≈ 18 µs</span>, a <code>host.status</code> request <span class="num">≈ 0.7 ms</span>, a prompt acknowledgement <span class="num">4.2 ms</span>, and a token reaches client state in <span class="num">≈ 0.2 ms</span>. The next chapters open up each step.</p>`);
      const cardConn = b.card({ x: 954, y: 30, w: 222, title: 'host.status round trip', kind: 'ok', lines: [{ text: '≈ 0.7 ms', mono: true, color: C.ok }, 'warm connection'] });
      b.show(cardConn, T5 + 200);
      [provider, pi, proj, server, tr, dc, tui, rend, term].forEach((box, i) => b.pulse(box, T5 + 400 + i * 120, 600));
      b.legend(['req', 'res', 'evt', 'dlt', 'io']);
    },
  });

  // 02 ─────────────────────────────────────────────────────────────── connect
  S.push({
    id: 'connect', title: 'Connecting', sub: 'Event-driven accept, then hello', modes: AB,
    build(b, mode) {
      const before = mode === 'before';
      b.note(`${mode} · 1 ms shown as 200 ms`);
      b.zone({ x: 264, y: 172, w: 272, h: 220, label: 'Kernel' });
      b.zone({ x: 592, y: 140, w: 584, h: 336, label: 'Daemon · event loop' });
      b.line([[208, 296], [248, 296], [248, 236], [288, 236]], { color: C.link });
      b.line([[476, 268], [476, 300]]);
      b.line([[512, 332], [616, 332]]);
      b.line([[704, 252], [704, 300]], { color: before ? C.bad : C.ok, dash: '4,3', arrow: false });
      b.line([[792, 332], [824, 332]]);
      b.line([[984, 332], [1008, 332]]);
      b.line([[1084, 364], [1084, 396]]);
      b.line([[124, 332], [124, 500], [1084, 500], [1084, 456]], { color: C.link, dash: '5,4', arrow: false });

      const client = b.box({ x: 40, y: 260, w: 168, h: 72, title: 'felan TUI', sub: 'connect()', tone: 'input' });
      const listen = b.box({ x: 288, y: 204, w: 224, h: 64, title: 'Listening socket', sub: 'owner-only · backlog 64', tone: 'store' });
      const queue = b.box({ x: 288, y: 300, w: 224, h: 64, title: 'Accept queue', sub: 'waits here', tone: 'ghost' });
      const waker = b.box({ x: 616, y: 180, w: 176, h: 72, title: before ? 'setInterval' : 'libuv watcher', sub: before ? 'poll every 5 ms' : "'connection' event", tone: before ? 'bad' : 'ok' });
      const accept = b.box({ x: 616, y: 300, w: 176, h: 64, title: 'accept()', sub: 'socket handed over' });
      const peer = b.box({ x: 824, y: 300, w: 160, h: 64, title: 'Peer check', sub: 'same uid · fail closed' });
      const cap = b.box({ x: 1008, y: 300, w: 152, h: 64, title: 'Cap', sub: '≤ 64 connections' });
      const hello = b.box({ x: 1008, y: 396, w: 152, h: 60, title: 'hello', sub: 'within 2 s' });

      const wakeups = b.txt({ x: 812, y: 210, text: before ? 'wake-ups: 0' : 'wake-ups while idle: none', size: 12, font: 'mono', fill: before ? C.bad : C.ok });
      b.staticText({ x: 812, y: 230, text: before ? '200 per second, with or without clients' : 'the kernel signals libuv when a client waits', size: 11 });
      const wait = b.txt({ x: 400, y: 384, text: '', anchor: 'middle', size: 10.5, font: 'mono', fill: before ? C.bad : C.ok, op: 0 });

      const cost = b.card({ x: 24, y: 36, w: 470, title: 'cost', kind: before ? 'bad' : 'ok', lines: before
        ? [{ text: 'up to 5 ms per connection (≈ 2.5 ms average)', mono: true, color: C.bad }, 'every connection waits for the next poll']
        : [{ text: 'accepted in the same event-loop turn', mono: true, color: C.ok }, 'no polling; same checks as before'] });
      const json = b.card({ x: 24, y: 524, w: 1152, title: 'hello request → and reply ←', kind: 'req', lines: [
        { text: '→ {"v":1,"id":"h1","op":"hello","params":{"clientVersion":"…","protocol":1,"kind":"tui","interactionKinds":[…],"capabilities":[…],"target":{…}}}\\n', mono: true, color: C.link },
        { text: '← {"v":1,"re":"h1","outcome":"accepted","result":{"attachmentId":"…","principal":"…","daemonVersion":"…","protocol":1,"identity":{…},"operations":[…],…}}\\n', mono: true, color: C.link }] });

      if (before) {
        b.beat(0, 'Before: the daemon polled for connections', `<p>The listening socket was checked by a <code>setInterval</code> every 5 ms: 200 wake-ups a second, with or without clients.</p>`);
        for (let k = 0; k < 13; k++) {
          const tick = 600 + k * 1000;
          b.pulse(waker, tick, 350);
          b.set(wakeups, tick, { text: `wake-ups: ${k + 1}` });
        }
      } else {
        b.beat(0, 'After: the kernel wakes the daemon', `<p>The listening socket is handed to libuv with <code>server.listen({ fd })</code>, so Node gets a <code>'connection'</code> event the moment a client is waiting. No timer runs while idle.</p>`);
      }

      const T2 = before ? 2900 : 1600;
      b.beat(T2, before ? 'A client connects between two polls' : 'A client connects', before
        ? `<p>The kernel completes the connection and parks it in the accept queue. Nothing happens until the next poll, so every connection, and the hello right behind it, waited 0–5 ms (about 2.5 ms on average).</p>`
        : `<p>The connection is accepted as soon as it lands in the queue. The <code>'connection'</code> event fires in the same turn of the event loop.</p>`);
      const conn = b.pkt({ kind: 'req', label: 'connect' });
      b.pulse(client, T2, 600);
      const arrive = b.route(conn, [[208, 296], [248, 296], [248, 236], { x: 400, y: 236, pulse: listen }, [476, 236], { x: 476, y: 332, pulse: queue }], before ? 2850 : T2 + 200, { speed: 0.5, hide: false });
      const acceptAt = before ? 4600 : arrive + 120;
      b.show(wait, arrive, 100);
      if (before) b.count(wait, arrive, acceptAt - arrive, 0, (acceptAt - arrive) / 200, v => `waiting ${v.toFixed(1)} ms for the next poll`);
      else { b.set(wait, arrive, { text: 'accepted at once' }); b.pulse(waker, arrive - 60, 500); }

      const T3 = acceptAt;
      b.beat(T3, 'Accept, check, hello', `<p>The daemon accepts the socket, checks that the peer runs as the same user (if it can't tell, the socket is destroyed), enforces the 64-connection cap, and expects a <code>hello</code> within 2 seconds; any other request before it is rejected. The reply carries the attachment id, daemon version, protocol version and the operations this daemon supports.</p>`);
      const checked = b.route(conn, [[476, 332], { x: 704, y: 332, pulse: accept }, { x: 904, y: 332, pulse: peer }, { x: 1084, y: 332, pulse: cap }], acceptAt, { speed: 0.5 });
      const req = b.pkt({ kind: 'req', label: 'hello' });
      const atHello = b.route(req, [[124, 332], [124, 500], [1084, 500], { x: 1084, y: 426, pulse: hello }], checked + 100, { speed: 0.9 });
      const res = b.pkt({ kind: 'res', label: 'accepted' });
      const back = b.route(res, [[1084, 456], [1084, 500], [124, 500], { x: 124, y: 300, pulse: client }], atHello + 150, { speed: 0.9 });
      b.show(json, checked + 100);

      b.beat(back + 200, 'Cost', before
        ? `<p>Every connection, and the hello right behind it, waited <span class="was">up to 5 ms</span> (about 2.5 ms on average) before the daemon even saw it, and the poll cost 200 wake-ups a second while idle.</p>`
        : `<p>The connection is accepted as soon as it is queued, with no polling delay and no idle wake-ups. The owner-only socket, uid check, 64-connection cap and 2 s hello deadline are unchanged.</p>`);
      b.show(cost, back + 200);
    },
  });

  // 03 ─────────────────────────────────────────────────────────────── wire
  S.push({
    id: 'wire', title: 'Wire format', sub: 'JSON lines, framing, decoding',
    build(b) {
      b.note('one frame = one JSON object + \\n');
      b.staticText({ x: 24, y: 44, text: 'Every frame is one JSON object followed by \\n', font: 'serif', size: 22, fill: C.ink });
      const rows = [
        ['req', 'request', '{"v":1,"id":"0190f3c2…","op":"prompt","session":"s1","params":{"text":"fix the flaky test"}}'],
        ['res', 'response', '{"v":1,"re":"0190f3c2…","outcome":"accepted","result":{…}}'],
        ['evt', 'event', '{"v":1,"session":"s1","rev":42,"change":{"type":"tool.updated","tool":{…}}}'],
        ['dlt', 'text delta', '{"v":1,"session":"s1","stream":{"id":"m7:0","message":"m7","kind":"assistant","offset":9},"text":"ld"}'],
        ['snap', 'attach reply', '{"v":1,"re":"a1","outcome":"accepted","result":{"attachmentId":"…","snapshot":{"revision":42,…}}}'],
      ];
      b.beat(0, 'One JSON object per line', `<p>Client and daemon exchange newline-delimited JSON. Every frame carries <code>"v":1</code>. Clients send <b>requests</b> (<code>id</code>, <code>op</code>, <code>params</code>); the daemon sends <b>responses</b> (<code>re</code> = request id, <code>outcome</code>), numbered <b>events</b> (<code>rev</code>), <b>text deltas</b> (stream id + code-point <code>offset</code>), and interaction notifications.</p><p>Mutating requests use UUIDv7 ids so a retried request is recognised instead of run twice.</p>`);
      rows.forEach(([kind, name, json], i) => {
        const y = 80 + i * 34;
        const chip = b.pkt({ kind, label: name, minW: 96 });
        b.set(chip, 300 + i * 350, { x: 76, y });
        b.show(chip, 300 + i * 350, 300);
        b.show(b.txt({ x: 136, y: y + 4, text: `${json}\\n`, font: 'mono', size: 11.5, fill: KINDS[kind].text, op: 0 }), 420 + i * 350, 300);
      });

      const dec = b.box({ x: 24, y: 268, w: 184, h: 72, title: 'JsonLineDecoder', sub: 'split at \\n · parse' });
      b.rect({ x: 24, y: 350, w: 184, h: 16, fill: C.white, stroke: C.soft, layer: b.bg });
      const buf = b.rect({ x: 26, y: 352, w: 0, h: 12, fill: KINDS.snap.fill, stroke: KINDS.snap.stroke, rx: 2 });
      b.staticText({ x: 24, y: 382, text: 'buffer: unfinished frame', font: 'mono', size: 10 });
      b.staticText({ x: 916, y: 308, text: '← bytes from the socket', font: 'mono', size: 10.5 });
      b.staticText({ x: 24, y: 432, text: 'parsed →', font: 'mono', size: 10.5 });

      const chunk = (x, frames, label) => {
        const g = b.grp({ x, y: 291, op: 0 });
        let cx = 0;
        for (const f of frames) {
          const k = KINDS[f.kind];
          el('rect', { x: cx, y: 0, width: f.w, height: 26, rx: 3, fill: k.fill, stroke: k.stroke, 'stroke-width': 1.2, 'stroke-dasharray': f.partial ? '4,3' : undefined }, g.g);
          const t = el('text', { x: cx + f.w / 2, y: 17, 'text-anchor': 'middle', 'font-size': 10.5, 'font-family': MONO, fill: k.text }, g.g);
          t.textContent = f.label;
          cx += f.w;
          if (f.nl) {
            el('rect', { x: cx + 1, y: 3, width: 14, height: 20, rx: 2, fill: C.ink }, g.g);
            const n = el('text', { x: cx + 8, y: 17, 'text-anchor': 'middle', 'font-size': 10, 'font-family': MONO, fill: '#fff' }, g.g);
            n.textContent = '↵';
            cx += 16;
          }
        }
        const t = el('text', { x: 0, y: -7, 'font-size': 10, 'font-family': MONO, fill: C.muted }, g.g);
        t.textContent = label;
        el('line', { x1: cx + 7, y1: -4, x2: cx + 7, y2: 30, stroke: C.muted, 'stroke-dasharray': '2,3' }, g.g);
        return g;
      };
      const c1 = chunk(248, [{ kind: 'evt', label: 'rev 42 · tool', w: 118, nl: true }, { kind: 'dlt', label: '"Hel"', w: 64, nl: true }], 'read 1');
      const c2 = chunk(478, [{ kind: 'dlt', label: '"lo"', w: 56, nl: true }, { kind: 'snap', label: '{"v":1,"re":"a1",…', w: 150, partial: true }], 'read 2');
      const c3 = chunk(716, [{ kind: 'snap', label: '…}}', w: 64, nl: true }, { kind: 'dlt', label: '" wor"', w: 70, nl: true }], 'read 3');

      const T2 = 2600;
      b.beat(T2, 'The socket delivers chunks, not frames', `<p>A socket is a byte stream. Each read returns whatever has arrived: several frames, the middle of one, or both. A raw newline never appears inside a frame, because JSON escapes newlines in strings, so <code>\\n</code> is a safe separator.</p>`);
      [c1, c2, c3].forEach((c, i) => b.show(c, T2 + 200 + i * 300, 300));

      const absorb = (c, x0, t) => {
        const d = (x0 - 120) / 0.4;
        b.tw(t, d, p => { c.m.x = x0 + (120 - x0) * p; }, 'in');
        b.hide(c, t + d - 260, 260);
        b.pulse(dec, t + d - 260, 600);
        return t + d;
      };
      const out = (label, kind, t, slot) => b.route(b.pkt({ kind, label }), [[116, 340], [116, 428], [300 + slot * 160, 428]], t, { speed: 0.5, hide: false });

      const T3 = 4800;
      b.beat(T3, 'Fast path: the read ends on a frame boundary', `<p>If nothing is buffered and the chunk ends with <code>\\n</code>, the decoder converts the whole chunk to text once and splits it at each newline. That is the common case for small frames.</p>`);
      b.set(dec, T3, { sub: 'fast path: decode once' });
      let t = absorb(c1, 248, T3 + 300);
      out('rev 42 · tool.updated', 'evt', t, 0);
      out('"Hel"', 'dlt', t + 350, 1);

      const T4 = t + 2200;
      b.beat(T4, 'A frame split across two reads', `<p>Complete lines are parsed straight from the chunk. The unfinished tail is copied into the decoder's buffer and waits for the rest.</p>`);
      b.set(dec, T4, { sub: 'line, then keep the tail' });
      t = absorb(c2, 478, T4 + 300);
      out('"lo"', 'dlt', t, 2);
      b.tw(t + 200, 500, p => { buf.m.w = 120 * p; });

      const T5 = t + 2400;
      b.beat(T5, 'The next read completes it', `<p>The next read finishes the buffered frame: buffer and first line are joined, decoded and parsed, and the rest of the chunk takes the normal path. Invalid UTF-8 or JSON closes the decoder for good. On the client, a connection that ends inside a frame counts as lost, not corrupt (chapter 6).</p>`);
      b.set(dec, T5, { sub: 'buffer + line → parse' });
      t = absorb(c3, 716, T5 + 300);
      b.tw(t - 200, 400, p => { buf.m.w = 120 * (1 - p); });
      out('attach reply + snapshot', 'snap', t, 3);
      out('" wor"', 'dlt', t + 350, 4);

      const T6 = t + 2400;
      b.beat(T6, 'Cheaper encoding and decoding', `<ul><li>Module-level <code>TextEncoder</code>s, and one fatal <code>TextDecoder</code> per decoder, instead of new ones per call.</li><li>UTF-8 sizes are counted with <code>encodeInto</code> into a reused 16 KiB buffer, without allocating; well-formed text is checked with native <code>isWellFormed</code> instead of a regex.</li><li>The client validates an attach snapshot once instead of twice (chapter 7).</li></ul><p>On this fixture, encoding is ≈ 1.5× plain <code>JSON.stringify</code> and decoding ≈ 1.3× plain <code>JSON.parse</code>. Before numbers come from the investigation scripts, after numbers from the <code>perf/</code> suite.</p>`);
      const title = b.txt({ x: 24, y: 476, text: '5 MiB attach snapshot, one call', size: 13, weight: 600, fill: C.ink, op: 0 });
      b.show(title, T6 + 100);
      b.bars({ x: 24, y: 500, w: 1152, t: T6 + 300, labelW: 230, valueW: 320, rows: [
        { label: 'encodeFrame', b: 23, a: 14.5, bText: '23 ms', aText: '14.5 ms  (JSON.stringify alone 9.5 ms)' },
        { label: 'JsonLineDecoder', b: 23, a: 9.4, bText: '23 ms', aText: '9.4 ms  (JSON.parse alone 7.0 ms)' },
        { label: 'attach validation', b: 72, a: 4.6, bText: '72 ms', aText: '4.6 ms' },
      ] });
    },
  });

  // 04 ─────────────────────────────────────────────────────────────── projection
  S.push({
    id: 'projection', title: 'Projection', sub: 'Agent events → deltas and events', modes: AB,
    build(b, mode) {
      const before = mode === 'before';
      b.note(`${mode} · motion slowed`);
      b.zone({ x: 240, y: 112, w: 560, h: 424, label: 'Projection · one per session' });
      b.line([[208, 252], [236, 252], [236, 186], [264, 186]], { color: C.accent });
      b.line([[496, 186], [544, 186]], { color: C.accent });
      b.line([[776, 186], [812, 186], [812, 256], [848, 256]], { color: C.accent });
      b.line([[208, 284], [236, 284], [236, 366], [264, 366]]);
      b.line([[496, 366], [544, 366]]);
      b.line([[776, 356], [824, 356], [824, 280], [848, 280]]);
      b.line([[776, 384], [824, 384], [824, 440], [848, 440]], { color: C.io });

      const pi = b.box({ x: 24, y: 232, w: 184, h: 72, title: 'Pi agent session', sub: 'agent events' });
      const text = b.box({ x: 264, y: 150, w: 232, h: 72, title: 'Text lane', sub: 'publish now · code-point offset' });
      const guard = b.box({ x: 544, y: 150, w: 232, h: 72, title: 'Surrogate guard', sub: before ? '(did not exist)' : 'never emit half a character', tone: before ? 'ghost' : 'node' });
      const state = b.box({ x: 264, y: 330, w: 232, h: 72, title: 'State lane', sub: 'schedule, wait 25 ms' });
      const refresh = b.box({ x: 544, y: 330, w: 232, h: 72, title: 'refresh()', sub: 'diff → rev n+1' });
      const fan = b.box({ x: 848, y: 232, w: 152, h: 72, title: 'Fan-out', sub: 'every client' });
      const store = b.box({ x: 848, y: 408, w: 152, h: 64, title: 'Control store', sub: 'commit if changed', tone: 'store' });

      const offTxt = b.txt({ x: 264, y: 248, text: 'offset 0', font: 'mono', size: 11.5 });
      b.staticText({ x: 264, y: 268, text: before ? 'per delta: Buffer.byteLength(whole stream) + Σ all streams' : 'per delta: total += bytes of this delta', font: 'mono', size: 10.5, fill: before ? C.bad : C.ok });
      b.staticText({ x: 264, y: 300, text: 'bytes measured for this delta', font: 'mono', size: 9.5 });
      const scan = b.rect({ x: 264, y: 278, w: 0, h: 8, fill: before ? C.bad : C.ok, rx: 2 });
      b.rect({ x: 264, y: 414, w: 232, h: 10, fill: C.white, stroke: C.soft, layer: b.bg });
      const timer = b.rect({ x: 265, y: 415, w: 0, h: 8, fill: C.evt, rx: 2 });
      b.staticText({ x: 264, y: 442, text: '25 ms coalescing window', font: 'mono', size: 10 });

      b.staticText({ x: 1024, y: 128, text: 'WORK PER DELTA', font: 'mono', size: 10, spacing: '0.12em' });
      b.line([[1032, 300], [1032, 140]], { color: C.muted, width: 1 });
      b.line([[1032, 300], [1172, 300]], { color: C.muted, width: 1 });
      b.staticText({ x: 1100, y: 318, text: 'answer length →', anchor: 'middle', font: 'mono', size: 9.5 });
      const curveB = b.line([[1036, 294], [1166, 156]], { color: C.bad, arrow: false, op: 0, width: 2 });
      const curveA = b.line([[1036, 290], [1166, 290]], { color: C.ok, arrow: false, op: 0, width: 2 });
      const labB = b.txt({ x: 1040, y: 160, text: 'before: O(length)', font: 'mono', size: 10, fill: C.bad, op: 0 });
      const labA = b.txt({ x: 1066, y: 282, text: 'after: O(delta)', font: 'mono', size: 10, fill: C.ok, op: 0 });

      b.beat(0, 'Two lanes out of every session', `<p>Pi emits agent events. The projection turns them into the session protocol: <b>text deltas</b> for streaming assistant and thinking text, and <b>session changes</b> for everything else. Text is latency-critical, so it never waits; most state changes come in bursts, so they are coalesced. Run transitions are published at once.</p>`);
      b.pulse(text, 600); b.pulse(state, 1000);

      const T2 = 2000;
      b.beat(T2, before ? 'Every delta re-measured everything' : 'Text deltas go straight out', before
        ? `<p>Each delta was stamped with an offset and published, but the size check ran <code>Buffer.byteLength</code> on the whole stream so far and on every other active stream. Each token cost more than the last: quadratic work over a long answer.</p>`
        : `<p>Each delta is stamped with the stream's offset in code points and published at once. Running byte totals per stream and across streams enforce the limits (1 MiB per stream, 4 MiB in total, 8 streams) by adding only the new delta's bytes. A stream that would cross a byte limit switches to completion only (reason <code>limit</code>).</p>`);
      const textPath = [[116, 252], [236, 252], [236, 186], { x: 380, y: 186, pulse: text }, { x: 660, y: 186, pulse: before ? undefined : guard }, [812, 186], [812, 256], { x: 924, y: 256, pulse: fan }];
      const deltas = [['"The"', 0, 3], ['" queue"', 3, 9], ['" over"', 9, 14]];
      deltas.forEach(([label, from, to], i) => {
        b.route(b.pkt({ kind: 'dlt', label: `@${from} ${label}` }), textPath, T2 + 300 + i * 800, {
          at: (stop, time) => {
            if (stop !== 3) return;
            b.set(offTxt, time, { text: `offset ${from} → ${to}` });
            const w = before ? 52 * (i + 1) : 18 + 6 * (to - from);
            b.tw(time, 300, p => { scan.m.w = w * p; }, 'out');
          },
        });
      });
      b.draw(curveB, T2 + 400, 2000); b.show(labB, T2 + 1600);
      b.draw(curveA, T2 + 400, 2000); b.show(labA, T2 + 1600);

      const T3 = T2 + 4200;
      if (before) {
        b.beat(T3, 'Half a character reached the wire', `<p>An emoji is two UTF-16 code units. When a provider chunk ended between them, the half character went straight into a frame. The fan-out's JSON validation rejected it and the connection had to resync; offsets also drifted.</p>`);
        const half = b.pkt({ kind: 'dlt', label: '@14 "wave \\uD83D"' });
        const atFan = b.route(half, textPath, T3 + 300);
        b.glow(fan, atFan, 200, C.bad);
        b.set(fan, atFan, { sub: 'encode failed', stroke: C.bad });
        b.route(b.pkt({ kind: 'bad', label: 'resync_required' }), [[924, 300], [924, 340]], atFan + 300, { speed: 0.1, hide: false });
      } else {
        b.beat(T3, 'Surrogate pairs stay whole', `<p>An emoji is two UTF-16 code units. If a chunk ends between them, the guard holds the first half and joins it to the next chunk, so neither the offset nor the frame ever contains half a character.</p><p>A truly malformed delta now only switches its stream to completion only, announced as a revisioned <code>stream.completion_only</code> event with reason <code>lost</code>; other streams and sessions carry on. Still open: a <em>completed</em> message that contains such text fails validation, and the registry then stops every session.</p>`);
        const toGuard = [[116, 252], [236, 252], [236, 186], { x: 380, y: 186, pulse: text }, { x: 660, y: 186, pulse: guard }];
        const fromGuard = [[660, 186], [812, 186], [812, 256], { x: 924, y: 256, pulse: fan }];
        let at = b.route(b.pkt({ kind: 'dlt', label: '"wave \\uD83D"' }), toGuard, T3 + 300);
        b.set(guard, at, { sub: 'holding \\uD83D' });
        b.route(b.pkt({ kind: 'dlt', label: '@14 "wave "' }), fromGuard, at + 100);
        at = b.route(b.pkt({ kind: 'dlt', label: '"\\uDC4B!"' }), toGuard, at + 700);
        b.set(guard, at, { sub: 'never emit half a character' });
        b.route(b.pkt({ kind: 'dlt', label: '@19 "👋!"' }), fromGuard, at + 100);
        at = b.route(b.pkt({ kind: 'bad', label: '"\\uDC4B" alone' }), toGuard, at + 900);
        b.glow(guard, at, 200, C.bad); b.unglow(guard, at + 900);
        b.route(b.pkt({ kind: 'bad', label: 'completion_only · lost' }), fromGuard, at + 100);
      }

      const T4 = T3 + (before ? 3800 : 6800);
      b.beat(T4, 'State changes are coalesced into numbered events', `<p>Tool, queue, title, model, catalog and completed-message changes only schedule a refresh. One refresh runs 25 ms after the first change; later changes do not push it back. It diffs the current state against the last published one and publishes one event per changed item, each committed with the next revision (<code>n+1, n+2, …</code>). If nothing changed, nothing is committed. Run transitions skip the wait.</p>`);
      let first = 0;
      ['tool start', 'tool output', 'queue'].forEach((label, i) => {
        const at = b.route(b.pkt({ kind: 'evt', label }), [[116, 284], [236, 284], [236, 366], { x: 380, y: 366, pulse: state }], T4 + 300 + i * 260, { speed: 0.5 });
        b.set(state, at, { sub: `changes × ${i + 1}` });
        if (i === 0) first = at;
      });
      b.tw(first, 1500, p => { timer.m.w = 230 * p; }, 'lin');
      const fire = first + 1500;
      b.set(timer, fire + 200, { w: 0 });
      b.set(state, fire, { sub: 'schedule, wait 25 ms' });
      b.pulse(refresh, fire, 700);
      ['rev 42 · tool.updated', 'rev 43 · queue.updated'].forEach((label, i) => {
        b.route(b.pkt({ kind: 'io', label: 'COMMIT' }), [[660, 384], [824, 384], [824, 440], { x: 924, y: 440, pulse: store }], fire + 300 + i * 500, { speed: 0.4 });
        b.route(b.pkt({ kind: 'evt', label }), [[660, 356], [824, 356], [824, 280], { x: 924, y: 280, pulse: fan }], fire + 300 + i * 500, { speed: 0.4 });
      });

      const T5 = fire + 2600;
      const chips = before
        ? [['re-validate command catalog', 'bad'], ['rescan transcript', 'bad'], ['validate full snapshot', 'bad']]
        : [['catalog: reused if unchanged', 'ok'], ['transcript: incremental', 'ok'], ['snapshot check: on attach', 'ok']];
      b.beat(T5, before ? 'Every refresh redid it all' : 'Less work on every refresh', before
        ? `<p>Each refresh rebuilt and re-validated the command catalog, rescanned the transcript and validated a full snapshot, even when a single tool line had changed. <code>session.history</code>, <code>session.tree</code> and <code>command.invoke</code> also built a full snapshot.</p>`
        : `<ul><li>The command catalog is still rebuilt, but its validated copy is reused while the serialized form is unchanged.</li><li>The transcript is scanned incrementally.</li><li>The full snapshot is validated when a client attaches, not on every refresh.</li><li><code>session.history</code>, <code>session.tree</code> and <code>command.invoke</code> no longer build a full snapshot.</li></ul>`);
      chips.forEach(([label, kind], i) => {
        const chip = b.pkt({ kind, label, minW: 180 });
        b.set(chip, T5 + 200 + i * 300, { x: 660, y: 432 + i * 30 });
        b.show(chip, T5 + 200 + i * 300, 300);
      });
      b.pulse(refresh, T5 + 200, 900);
      b.legend(['dlt', 'evt', 'io', 'bad']);
    },
  });

  // 05 ─────────────────────────────────────────────────────────────── fan-out
  S.push({
    id: 'fanout', title: 'Fan-out & batching', sub: 'Merging, backpressure, limits', modes: AB,
    build(b, mode) {
      const before = mode === 'before';
      b.note(`${mode} · motion slowed`);
      b.rect({ x: 24, y: 48, w: 1152, h: 44, fill: C.white, stroke: C.rule, rx: 6, layer: b.bg });
      b.staticText({ x: 24, y: 40, text: 'DAEMON EVENT LOOP · ONE TURN AT A TIME', font: 'mono', size: 10, spacing: '0.12em' });
      let segX = 32;
      const seg = (t, label, kind, w) => {
        const r = b.rect({ x: segX, y: 56, w: 0, h: 28, fill: KINDS[kind].fill, stroke: KINDS[kind].stroke, rx: 4 });
        const tx = b.txt({ x: segX + 8, y: 74, text: label, font: 'mono', size: 10.5, fill: KINDS[kind].text, op: 0 });
        b.tw(t, 400, p => { r.m.w = w * p; }, 'out');
        b.show(tx, t + 200, 200);
        segX += w + 6;
      };

      const proj = b.box({ x: 24, y: 200, w: 144, h: 72, title: 'Projection', sub: 'deltas + events' });
      b.zone({ x: 196, y: 140, w: 528, h: 268, label: 'SessionFanout · one per connection' });
      b.rect({ x: 216, y: 200, w: 488, h: 72, fill: 'rgba(255,255,255,0.6)', stroke: C.soft, dash: '4,3', rx: 6, layer: b.bg });
      b.staticText({ x: 224, y: 194, text: 'queue: frames not yet written', font: 'mono', size: 10 });
      b.staticText({ x: 224, y: 304, text: 'queued frames', size: 12 });
      b.staticText({ x: 224, y: 326, text: 'unsent bytes', size: 12 });
      b.staticText({ x: 224, y: 348, text: 'socket', size: 12 });
      b.staticText({ x: 520, y: 304, text: 'limit 1,024', font: 'mono', size: 10.5, fill: C.soft });
      b.staticText({ x: 520, y: 326, text: 'limit 32 MiB', font: 'mono', size: 10.5, fill: C.soft });
      const fr = b.txt({ x: 340, y: 304, text: '0', font: 'mono', size: 12 });
      const by = b.txt({ x: 340, y: 326, text: '0 B', font: 'mono', size: 12 });
      const sock = b.txt({ x: 340, y: 348, text: 'writable', font: 'mono', size: 12, fill: C.ok });
      b.staticText({ x: 224, y: 386, text: before ? 'every delta is its own frame, written at once' : 'merge if same stream and offset == tail.offset + tail.length', font: 'mono', size: 10.5, fill: before ? C.bad : C.ok });
      const tank = b.tank({ x: 764, y: 150, w: 112, h: 210, label: 'Kernel socket buffer', sub: 'full → write() false' });
      const client = b.box({ x: 920, y: 200, w: 240, h: 72, title: 'Client', sub: 'decode → reducer → render', tone: 'input' });
      const screen = b.txt({ x: 920, y: 300, text: 'screen: ', font: 'mono', size: 11.5 });
      const cstat = b.txt({ x: 920, y: 322, text: 'reading', font: 'mono', size: 11.5, fill: C.ok });
      b.line([[168, 236], [216, 236]], { color: C.accent });
      b.line([[704, 236], [764, 236]]);
      b.line([[876, 236], [920, 236]]);
      const FROM = [96, 236];

      b.beat(0, 'One queue per connection', `<p>Every client connection has its own <code>SessionFanout</code>. Frames for that client (responses, events, text deltas) wait in its queue until the socket takes them. All sessions attached over one connection share its queue and limits. The kernel socket buffer between daemon and client is small: when it is full, <code>socket.write()</code> returns <code>false</code> until a <code>'drain'</code> event.</p>`);
      b.pulse(proj, 400); b.pulse(client, 900);

      const fillTank = (T4, labels) => {
        labels.forEach(([label, kind], i) => {
          const t = T4 + 400 + i * 450;
          b.route(b.pkt({ kind, label }), [FROM, [290, 236], { x: 820, y: 236 }], t, { speed: 0.9 });
          b.tw(t + 800, 300, p => { tank.m.level = (i + p) / labels.length; });
        });
        const full = T4 + 400 + (labels.length - 1) * 450 + 1100;
        b.set(sock, full, { text: 'blocked: write() → false', fill: C.bad });
        b.set(tank, full, { fill: KINDS.bad.fill, stroke: C.bad });
        return full;
      };
      const throughput = T => {
        b.beat(T, 'Batching matters more off-machine', `<p>In a local transport bench, sending 50,000 deltas in ~64 KiB batches instead of one write each was 1.2× faster over a Unix socket, 2× over TCP and 2.9× over WebSocket. Local clients use the Unix socket today; a TCP or WebSocket transport, such as the relay proposed in chapter 11, would gain the most from merging and batching.</p>`);
        b.show(b.txt({ x: 580, y: 452, text: 'throughput, 50k deltas, local transport bench', font: 'mono', size: 10.5, fill: C.muted, op: 0 }), T);
        b.bars({ x: 580, y: 476, w: 596, t: T + 200, labelW: 104, valueW: 120, beforeLabel: 'write per delta', afterLabel: 'batched', rows: [
          { label: 'Unix socket', b: 765, a: 892, bText: '765k/s', aText: '892k/s' },
          { label: 'TCP', b: 539, a: 1088, bText: '539k/s', aText: '1.09M/s' },
          { label: 'WebSocket', b: 432, a: 1269, bText: '432k/s', aText: '1.27M/s' },
        ] });
      };

      if (!before) {
        const T2 = 2200;
        b.beat(T2, 'Deltas from one read become one frame', `<p>One network read from the provider can carry several SSE chunks, so the projection publishes several deltas in the same turn of the event loop. A delta that continues the queued tail frame (same session, message and stream; offset = tail offset + tail length in code points; merged text within 1 MiB) is appended to it instead of becoming a new frame. Only the text bytes grow.</p>`);
        seg(T2, 'I/O · 3 deltas → merged', 'dlt', 220);
        const A = b.pkt({ kind: 'dlt', label: '@0 "The"' });
        const tA = b.route(A, [FROM, [290, 236]], T2 + 400, { speed: 0.4, hide: false });
        b.set(fr, tA, { text: '1' }); b.set(by, tA, { text: '98 B' });
        [['@3 " queue"', '@0 "The queue"', '104 B'], ['@9 " over"', '@0 "The queue over"', '109 B']].forEach(([label, merged, bytes], i) => {
          const t = b.route(b.pkt({ kind: 'dlt', label }), [FROM, [290, 236]], T2 + 750 + i * 350, { speed: 0.4 });
          b.set(A, t, { label: merged }); b.set(by, t, { text: bytes });
          b.tw(t, 300, p => { A.m.s = 1 + 0.15 * Math.sin(Math.PI * p); }, 'lin');
        });

        const T3 = T2 + 2300;
        b.beat(T3, 'One write per turn of the loop', `<p>Flushing is scheduled with <code>setImmediate</code>, which runs after the current turn's I/O callbacks. Everything queued is concatenated and handed to the socket in one <code>write()</code>.</p>`);
        seg(T3, 'setImmediate · 1 write', 'ok', 190);
        const w1 = T3 + 400;
        b.move(A, [290, 236], [820, 236], w1, 700);
        b.set(fr, w1 + 700, { text: '0' }); b.set(by, w1 + 700, { text: '0 B' });
        b.tw(w1 + 600, 300, p => { tank.m.level = 0.12 * p; });
        b.move(A, [820, 236], [1040, 236], w1 + 1000, 500);
        b.hide(A, w1 + 1500, 200);
        b.tw(w1 + 1000, 400, p => { tank.m.level = 0.12 * (1 - p); });
        b.set(screen, w1 + 1500, { text: 'screen: The queue over' });

        const T4 = T3 + 2700;
        b.beat(T4, 'The client falls behind', `<p>If the client is busy, the kernel buffer fills and <code>write()</code> returns <code>false</code>. The fan-out stops writing and waits for <code>'drain'</code>.</p>`);
        seg(T4, 'client busy · write() false', 'bad', 220);
        b.set(cstat, T4 + 200, { text: 'busy (long render)', fill: C.bad });
        const full = fillTank(T4, [['@14 "flows."', 'dlt'], ['rev 42', 'evt'], ['@20 " Each"', 'dlt']]);

        const T5 = full + 700;
        b.beat(T5, 'Blocked? Keep merging into the tail', `<p>While blocked, contiguous deltas keep merging into the last queued frame, so the queue grows in bytes, not frames. An event in between ends the merge, keeping order, and the next deltas start a new tail.</p>`);
        seg(T5, 'I/O · 8 deltas → 1 frame', 'dlt', 210);
        const B = b.pkt({ kind: 'dlt', label: '@25 " delta"' });
        let t = b.route(B, [FROM, [290, 236]], T5 + 300, { speed: 0.6, hide: false });
        b.set(fr, t, { text: '1' }); b.set(by, t, { text: '104 B' });
        let bytes = 104;
        [' became', ' its', ' own', ' frame', ' and', ' a', ' write'].forEach((word, i) => {
          const at = b.route(b.pkt({ kind: 'dlt', label: JSON.stringify(word) }), [FROM, [290, 236]], T5 + 600 + i * 240, { speed: 0.6 });
          bytes += word.length;
          b.set(B, at, { label: `@25 · ${i + 2} deltas, 1 frame` }); b.set(by, at, { text: `${bytes} B` });
        });
        const tE = T5 + 600 + 7 * 240 + 400;
        const E = b.pkt({ kind: 'evt', label: 'rev 43' });
        t = b.route(E, [FROM, [440, 236]], tE, { speed: 0.6, hide: false });
        b.set(fr, t, { text: '2' }); b.set(by, t, { text: `${bytes + 128} B` });
        const D = b.pkt({ kind: 'dlt', label: '@64 "."' });
        t = b.route(D, [FROM, [600, 236]], t + 200, { speed: 0.6, hide: false });
        b.set(fr, t, { text: '3' }); b.set(by, t, { text: `${bytes + 128 + 96} B` });
        const t2 = b.route(b.pkt({ kind: 'dlt', label: '" Now"' }), [FROM, [600, 236]], t + 250, { speed: 0.6 });
        b.set(D, t2, { label: '@64 · 2 deltas, 1 frame' }); b.set(by, t2, { text: `${bytes + 128 + 100} B` });

        const T6 = t2 + 900;
        b.beat(T6, "Drain, then one write", `<p>After <code>'drain'</code>, the next flush writes the whole queue at once. The client gets fewer, larger frames carrying exactly the same text. In the <code>fanout</code> bench, a burst of 3,000 deltas now arrives intact over one open connection.</p>`);
        seg(T6, "'drain' · 1 write", 'ok', 150);
        b.set(cstat, T6, { text: 'reading again', fill: C.ok });
        b.tw(T6, 900, p => { tank.m.level = 1 - p; });
        b.set(screen, T6 + 450, { text: 'screen: The queue overflows. Each' });
        b.set(tank, T6 + 900, { fill: C.accentTint, stroke: C.accent });
        b.set(sock, T6 + 900, { text: "writable ('drain')", fill: C.ok });
        const tw = T6 + 1000;
        for (const [p, x] of [[B, 290], [E, 440], [D, 600]]) { b.move(p, [x, 236], [820, 236], tw, 700); b.hide(p, tw + 700, 200); }
        b.set(fr, tw + 700, { text: '0' }); b.set(by, tw + 700, { text: '0 B' });
        b.tw(tw + 600, 300, p => { tank.m.level = 0.3 * p; });
        const flow = b.pkt({ kind: 'dlt', label: '1 write · 3 frames' });
        b.move(flow, [820, 236], [1040, 236], tw + 1000, 600);
        b.hide(flow, tw + 1600, 200);
        b.tw(tw + 1000, 500, p => { tank.m.level = 0.3 * (1 - p); });
        b.set(screen, tw + 1600, { text: 'screen: …and a write. Now' });

        const T7 = tw + 2400;
        b.beat(T7, 'Still too far behind? Close cleanly', `<p>The limits are unchanged: 1,024 frames or 32 MiB that the socket has not yet confirmed as written. If a client still crosses one, the fan-out discards its queue and closes with the internal reason <code>resync_required</code> using <code>socket.end()</code>, so the client only ever receives whole frames; the socket is destroyed after 1 s if needed, or at once on a transport error. The client sees a lost connection, reconnects and takes a fresh snapshot.</p>`);
        const card = b.card({ x: 24, y: 432, w: 528, title: 'only if a client stays far behind', kind: 'ok', lines: [
          'Limit: 1,024 frames or 32 MiB not yet written.',
          { text: "close('resync_required') → socket.end()", mono: true },
          'destroy() only after 1 s, or on a transport error.',
          'Client: connection lost → reconnect → snapshot.'] });
        b.show(card, T7 + 200);
        b.set(fr, T7 + 600, { text: '1,024 (limit)', fill: C.bad });
        b.set(sock, T7 + 900, { text: 'end() after whole frames', fill: C.ok });
        const fin = b.pkt({ kind: 'ok', label: 'last whole frame + FIN' });
        b.move(fin, [700, 236], [1040, 236], T7 + 900, 900);
        b.hide(fin, T7 + 1800, 200);
        b.set(cstat, T7 + 1800, { text: 'lost → reconnect → snapshot', fill: C.io });
        b.set(cstat, T7 + 3200, { text: 'live again', fill: C.ok });
        b.set(fr, T7 + 3200, { text: '0', fill: C.ink });
        b.set(sock, T7 + 3200, { text: 'new connection', fill: C.ok });
        throughput(T7 + 4200);
      } else {
        const T2 = 2200;
        b.beat(T2, 'Every delta was its own frame and its own write', `<p>Each delta became a frame and was written immediately: three deltas from one network read meant three <code>write()</code> calls and three frames for the client to parse.</p>`);
        seg(T2, 'I/O · 3 deltas → 3 frames → 3 writes', 'dlt', 290);
        let text = 'screen: ';
        [['"The"', 0], ['" queue"', 3], ['" over"', 9]].forEach(([label, offset], i) => {
          const word = JSON.parse(label);
          b.route(b.pkt({ kind: 'dlt', label: `@${offset} ${label}` }), [FROM, { x: 262, y: 236, dwell: 150 }, { x: 820, y: 236 }, { x: 1040, y: 236 }], T2 + 400 + i * 500, {
            speed: 0.7,
            at: (stop, time) => {
              if (stop === 1) { b.set(fr, time, { text: '1' }); b.set(by, time, { text: '98 B' }); b.set(fr, time + 150, { text: '0' }); b.set(by, time + 150, { text: '0 B' }); }
              if (stop === 3) { text += word; b.set(screen, time, { text }); }
            },
          });
        });

        const T3 = T2 + 3200;
        b.beat(T3, 'The client falls behind', `<p>If the client is busy, the kernel buffer fills and <code>write()</code> returns <code>false</code>. The fan-out stops writing and waits for <code>'drain'</code>.</p>`);
        seg(T3, 'client busy · write() false', 'bad', 220);
        b.set(cstat, T3 + 200, { text: 'busy (long render)', fill: C.bad });
        const full = fillTank(T3, [['@14 "flows."', 'dlt'], ['rev 42', 'evt'], ['@20 " Each"', 'dlt']]);

        const T4 = full + 700;
        b.beat(T4, 'Blocked: one more frame per delta', `<p>While the socket was blocked, every new delta added a frame to the queue. A fast answer could reach the 1,024-frame limit within about a thousand tokens.</p>`);
        seg(T4, 'I/O · each delta → a new frame', 'bad', 250);
        const words = [' delta', ' became', ' its', ' own', ' frame', ' and'];
        let offset = 25;
        const queued = [];
        words.forEach((word, i) => {
          const p = b.pkt({ kind: 'dlt', label: `@${offset}` });
          offset += word.length;
          const at = b.route(p, [FROM, [262 + i * 74, 236]], T4 + 300 + i * 300, { speed: 0.8, hide: false });
          b.set(fr, at, { text: `${i + 1}` }); b.set(by, at, { text: `${(i + 1) * 99} B` });
          queued.push(p);
        });
        const tCount = T4 + 300 + 6 * 300 + 500;
        b.count(fr, tCount, 2400, 6, 1024);
        b.count(by, tCount, 2400, 6 * 99, 1024 * 99, v => Felan.fmt.bytes(v));
        const more = b.txt({ x: 460, y: 182, text: '+1,018 more frames', anchor: 'middle', font: 'mono', size: 10.5, fill: C.bad, op: 0 });
        b.show(more, tCount + 600);

        const T5 = tCount + 2800;
        b.beat(T5, 'Limit hit: socket destroyed mid-frame', `<p>The fan-out called <code>socket.destroy()</code>, which can cut a frame in half. The client's decoder saw an unfinished JSON line, reported <code>invalid_frame</code>, and the attachment went to a blocked state with no automatic reconnect. In the bench, a burst of 1,025 deltas ended this way.</p>`);
        seg(T5, 'limit → destroy()', 'bad', 170);
        b.set(fr, T5, { text: '1,024 → close', fill: C.bad });
        b.set(sock, T5 + 300, { text: 'destroy()', fill: C.bad });
        for (const p of queued) b.hide(p, T5 + 300, 300);
        b.hide(more, T5 + 300, 300);
        const cut = b.pkt({ kind: 'bad', label: '{"v":1,…,"text":"wo' });
        b.move(cut, [820, 236], [1040, 236], T5 + 600, 800);
        b.set(cstat, T5 + 1400, { text: 'invalid_frame → blocked', fill: C.bad });
        b.set(client, T5 + 1400, { stroke: C.bad, fill: KINDS.bad.fill });
        const card = b.card({ x: 24, y: 432, w: 528, title: 'what users saw', kind: 'bad', lines: [
          'The session stopped updating during a fast answer.',
          'A cut frame looked like corrupt data, not a lost',
          'connection, so the client did not reconnect.'] });
        b.show(card, T5 + 1600);
        throughput(T5 + 3600);
      }
      b.legend(['dlt', 'evt', 'ok', 'bad']);
    },
  });

  // 06 ─────────────────────────────────────────────────────────────── attach
  S.push({
    id: 'attach', title: 'Attach & recovery', sub: 'Snapshot, ordering, reconnect', modes: AB,
    build(b, mode) {
      const before = mode === 'before';
      b.note(`${mode} · sequence, time flows down`);
      const X = { client: 220, server: 660, proj: 1040 };
      b.box({ x: 140, y: 40, w: 160, h: 52, title: 'Client', sub: 'SessionClient' });
      b.box({ x: 580, y: 40, w: 160, h: 52, title: 'Server', sub: 'connection fan-out' });
      b.box({ x: 960, y: 40, w: 160, h: 52, title: 'Projection', sub: 'session s1' });
      for (const x of Object.values(X)) b.line([[x, 92], [x, 628]], { color: C.soft, dash: '3,4', arrow: false });
      const held = b.rect({ x: 330, y: 212, w: 300, h: 98, fill: 'rgba(255,255,255,0.7)', stroke: C.soft, dash: '4,3', rx: 6, op: 0 });
      const heldLabel = b.txt({ x: 340, y: 228, text: 'HELD WHILE ATTACHING', font: 'mono', size: 9.5, fill: C.muted, op: 0 });

      const msg = (t, from, to, y, label, kind, o = {}) => {
        const x1 = X[from]; const x2 = X[to];
        const dir = Math.sign(x2 - x1);
        const ln = b.line([[x1, y], [x2 - dir * 4, y]], { color: COLORS[kind], op: 0, dash: o.dash });
        b.draw(ln, t, Math.abs(x2 - x1) / 0.7);
        if (o.caption !== false) b.show(b.txt({ x: (x1 + x2) / 2, y: y - 7, text: o.caption || label, anchor: 'middle', font: 'mono', size: 10, fill: COLORS[kind], op: 0 }), t + Math.abs(x2 - x1) / 0.7, 250);
        const p = b.pkt({ kind, label });
        const end = b.route(p, [[x1, y], [x2, y]], t, { speed: 0.7, hide: !o.keep });
        return o.keep ? { end, p } : end;
      };
      const note = (t, y, text, color = C.muted) => b.show(b.txt({ x: 24, y, text, font: 'mono', size: 10, fill: color, op: 0 }), t, 250);

      b.beat(0, 'Attach: subscribe first, then take the snapshot', `<p>The client sends <code>attach</code>. The server first subscribes to the session's projection and holds whatever it emits, then asks for a snapshot. Because the subscription starts before the snapshot, nothing can fall into the gap between them; taking the snapshot can itself publish pending changes.</p>`);
      let t = msg(400, 'client', 'server', 132, 'attach s1', 'req');
      t = msg(t + 100, 'server', 'proj', 164, 'subscribe()', 'req');
      t = msg(t + 100, 'server', 'proj', 194, 'snapshot()', 'req');
      b.show(held, t, 300); b.show(heldLabel, t, 300);
      const heldItems = [];
      [['rev 42', 'evt', 244], ['@5 "wor"', 'dlt', 268], ['@9 "ld"', 'dlt', 292]].forEach(([label, kind, y], i) => {
        const { end, p } = msg(t + 200 + i * 450, 'proj', 'server', y, label, kind, { keep: true });
        b.move(p, [X.server, y], [410, y], end, 500);
        heldItems.push({ p, y, at: end + 500 });
      });
      const snapAt = msg(t + 200 + 3 * 450 + 300, 'proj', 'server', 336, 'snapshot · rev 42 · m7 "Hello wor"', 'snap');

      const T2 = snapAt + 300;
      b.beat(T2, 'Drop what the snapshot already has', `<p>Held events at or below the snapshot's revision are dropped; the next must be exactly <code>revision + 1</code>, or the connection is resynchronised. For each stream, the first held delta is compared with the snapshot's copy: text the snapshot already contains is dropped, a delta that starts where the stream ends is kept along with the rest of that stream, and anything else forces a resync. Deltas for streams the snapshot already shows as finished are dropped.</p>`);
      const verdicts = [['drop · rev ≤ 42', C.bad, true], ['drop · duplicate', C.bad, true], ['send · append', C.ok, false]];
      heldItems.forEach(({ p, y }, i) => {
        const [text, color, drop] = verdicts[i];
        const at = T2 + 300 + i * 500;
        b.show(b.txt({ x: 466, y: y + 4, text, font: 'mono', size: 10, fill: color, op: 0 }), at, 250);
        if (drop) { b.set(p, at, { strike: 1 }); b.tw(at, 300, q => { p.m.op = 1 - 0.6 * q; }); }
      });

      const T3 = T2 + 2200;
      b.beat(T3, 'Snapshot first, then the rest, in order', `<p>The attach reply carries the snapshot. The client validates it once, and the reducer copies it with <code>structuredClone</code> (≈ 3 ms for 5 MiB, instead of ≈ 37 ms for a second validation). Then the kept frames follow, then live traffic. From here the client ignores events at or below its revision, applies exactly <code>rev + 1</code>, and appends deltas that continue their stream. A gap makes it attach again for a fresh snapshot; after three recoveries in quick succession it marks the session blocked.</p>`);
      t = msg(T3 + 200, 'server', 'client', 372, 'attach ✓ + snapshot (rev 42)', 'snap');
      note(t, 366, 'validate once,');
      note(t, 380, 'structuredClone');
      b.hide(heldItems[2].p, t + 100, 250);
      t = msg(t + 200, 'server', 'client', 404, '@9 "ld"', 'dlt');
      note(t, 408, 'append → "Hello world"', C.ok);
      t = msg(t + 200, 'proj', 'client', 436, 'rev 43', 'evt');
      note(t, 440, 'live', C.ok);

      const T4 = t + 700;
      const cut = b.line([[120, 470], [1120, 470]], { color: C.bad, dash: '6,4', arrow: false, op: 0 });
      b.show(cut, T4, 300);
      b.show(b.txt({ x: 660, y: 464, text: 'connection drops in the middle of a frame', anchor: 'middle', font: 'mono', size: 10.5, fill: C.bad, op: 0 }), T4, 300);
      if (before) {
        b.beat(T4, 'Before: a cut frame meant "blocked"', `<p>The decoder saw an unfinished JSON line and reported <code>invalid_frame</code>. The client treated that as corrupt data rather than a dropped connection, so the attachment was marked blocked and did not reconnect on its own. A fast token burst could cause exactly this (chapter 5).</p>`);
        t = msg(T4 + 300, 'server', 'client', 500, '{"v":1,…,"text":"wo', 'bad');
        note(t, 504, 'invalid_frame', C.bad);
        note(t + 300, 520, '→ blocked', C.bad);
        const card = b.card({ x: 330, y: 520, w: 600, title: 'result', kind: 'bad', lines: ['The session view froze. No reconnect, no new snapshot.'] });
        b.show(card, t + 600);
      } else {
        b.beat(T4, 'A connection drops mid-frame', `<p>If the socket ends inside a frame, the client treats it as a lost connection, not corrupt data. It reconnects after about 250 ms (±10% jitter, doubling up to 10 s), says hello, attaches again and continues from a fresh snapshot. Partial text is part of the snapshot's active streams, so nothing is lost or repeated.</p>`);
        t = msg(T4 + 300, 'server', 'client', 500, '{"v":1,…,"text":"wo', 'bad');
        note(t, 504, 'transport_lost', C.io);
        note(t + 200, 518, 'retry in 250 ms', C.io);
        t = msg(t + 900, 'client', 'server', 540, 'hello', 'req');
        t = msg(t + 100, 'server', 'client', 564, 'accepted', 'res');
        t = msg(t + 100, 'client', 'server', 588, 'attach s1', 'req');
        t = msg(t + 100, 'server', 'client', 612, 'snapshot (rev 57)', 'snap');
        note(t, 616, 'live again', C.ok);
      }
    },
  });
})();
