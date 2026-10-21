'use strict';
// Tiny deterministic timeline engine: every frame rebuilds actor state from the tween list,
// so scrubbing to any time renders exactly what playing to that time would.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
  const SANS = "'Geist', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
  const SERIF = "'Instrument Serif', Georgia, serif";
  const C = {
    paper: '#f6f5f1', paper2: '#efede7', white: '#ffffff', ink: '#23262f', muted: '#5b6475', soft: '#9aa2b3',
    rule: 'rgba(35,38,47,0.16)', accent: '#e4602a', accentTint: '#fdece3', link: '#2e5aa8', linkTint: '#e7eefa',
    snap: '#7b4fb5', snapTint: '#f2ecfa', ok: '#2d7a57', okTint: '#e4f2ea', bad: '#c0392b', badTint: '#fbe7e4',
    io: '#9a6b00', ioTint: '#fff4d6', evt: '#3c4150', evtTint: '#e9ebf1',
  };
  const KINDS = {
    req: { fill: C.linkTint, stroke: C.link, text: C.link, name: 'request' },
    res: { fill: C.white, stroke: C.link, text: C.link, name: 'response' },
    evt: { fill: C.evtTint, stroke: C.evt, text: C.evt, name: 'event (rev)' },
    dlt: { fill: C.accentTint, stroke: C.accent, text: '#a8401a', name: 'text delta (offset)' },
    snap: { fill: C.snapTint, stroke: C.snap, text: C.snap, name: 'snapshot' },
    ok: { fill: C.okTint, stroke: C.ok, text: C.ok, name: 'ok' },
    bad: { fill: C.badTint, stroke: C.bad, text: C.bad, name: 'failure' },
    io: { fill: C.ioTint, stroke: C.io, text: C.io, name: 'commit / disk' },
    plain: { fill: C.white, stroke: C.muted, text: C.ink, name: '' },
  };
  const TONES = {
    node: { fill: C.white, stroke: C.ink },
    store: { fill: '#ecebe6', stroke: C.muted },
    ext: { fill: '#f1f0ec', stroke: 'rgba(35,38,47,0.38)' },
    input: { fill: '#e9ecf2', stroke: C.soft },
    focal: { fill: C.accentTint, stroke: C.accent },
    ok: { fill: C.okTint, stroke: C.ok },
    bad: { fill: C.badTint, stroke: C.bad },
    ghost: { fill: 'rgba(255,255,255,0.5)', stroke: C.rule, dash: '4,4' },
  };
  const EASE = {
    lin: p => p,
    io: p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
    out: p => 1 - Math.pow(1 - p, 3),
    in: p => p * p * p,
  };

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    if (attrs) for (const key in attrs) if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
  }
  function syncer(node) {
    const cache = new Map();
    return (name, value) => {
      if (cache.get(name) === value) return;
      cache.set(name, value);
      if (name === 'text') node.textContent = value;
      else node.setAttribute(name, value);
    };
  }
  const fmt = {
    int: v => Math.round(v).toLocaleString('en-US'),
    ms: (v, d = 1) => `${v.toFixed(d)} ms`,
    bytes: v => (v >= 1048576 ? `${(v / 1048576).toFixed(1)} MiB` : v >= 1024 ? `${(v / 1024).toFixed(1)} KiB` : `${Math.round(v)} B`),
  };

  class Builder {
    constructor(svg) {
      this.root = el('g', { class: 'scene' }, svg);
      this.bg = el('g', {}, this.root);
      this.lines = el('g', {}, this.root);
      this.mid = el('g', {}, this.root);
      this.fg = el('g', {}, this.root);
      // Box labels sit above moving packets so text stays readable while packets pass through.
      this.labels = el('g', {}, this.root);
      this.top = el('g', {}, this.root);
      this.actors = [];
      this.tweens = [];
      this.beats = [];
      this.duration = 0;
    }

    actor(init, sync, extra = {}) {
      const actor = Object.assign({ init, m: { ...init }, sync }, extra);
      this.actors.push(actor);
      return actor;
    }

    // ---------- static decoration ----------
    zone(o) {
      el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx: 8, fill: o.fill || 'rgba(255,255,255,0.35)', stroke: o.stroke || C.rule,
        'stroke-dasharray': o.dash === false ? undefined : '5,4', 'stroke-width': 1 }, this.bg);
      if (o.label) {
        const t = el('text', { x: o.x + 12, y: o.y + 18, fill: o.labelColor || C.muted, 'font-size': 10, 'font-family': MONO, 'letter-spacing': '0.12em' }, this.bg);
        t.textContent = o.label.toUpperCase();
      }
    }
    staticText(o) {
      const t = el('text', { x: o.x, y: o.y, fill: o.fill || C.muted, 'font-size': o.size || 12, 'font-weight': o.weight,
        'font-family': o.font === 'mono' ? MONO : o.font === 'serif' ? SERIF : SANS, 'text-anchor': o.anchor || 'start',
        'letter-spacing': o.spacing, 'font-style': o.italic ? 'italic' : undefined }, o.layer || this.bg);
      t.textContent = o.text;
      return t;
    }
    note(text) { this.staticText({ x: 1176, y: 24, text, anchor: 'end', font: 'mono', size: 10, fill: C.soft }); }
    legend(kinds, y = 624) {
      el('line', { x1: 24, y1: y - 18, x2: 1176, y2: y - 18, stroke: C.rule, 'stroke-width': 0.8 }, this.bg);
      this.staticText({ x: 24, y, text: 'LEGEND', font: 'mono', size: 9, fill: C.muted, spacing: '0.14em' });
      let x = 96;
      for (const kind of kinds) {
        const k = KINDS[kind];
        el('rect', { x, y: y - 10, width: 22, height: 12, rx: 3, fill: k.fill, stroke: k.stroke, 'stroke-width': 1.2 }, this.bg);
        this.staticText({ x: x + 30, y, text: k.name, size: 11, fill: C.muted });
        x += 52 + k.name.length * 6.4;
      }
    }

    // ---------- actors ----------
    line(pts, o = {}) {
      const color = o.color || C.soft;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const marker = o.arrow === false ? undefined : `url(#arrow-${o.marker || markerFor(color)})`;
      const path = el('path', { d, fill: 'none', stroke: color, 'stroke-width': o.width || 1.2, 'marker-end': marker,
        'stroke-dasharray': o.dash, 'stroke-linejoin': 'round' }, o.layer || this.lines);
      const s = syncer(path);
      const animated = !o.dash;
      return this.actor({ op: o.op ?? 1, draw: 1, color }, m => {
        s('opacity', m.op); s('stroke', m.color);
        if (animated && m.draw < 1) { s('stroke-dasharray', `${length}`); s('stroke-dashoffset', `${length * (1 - m.draw)}`); }
        else if (animated) { s('stroke-dasharray', 'none'); s('stroke-dashoffset', '0'); }
      }, { length });
    }

    box(o) {
      const tone = TONES[o.tone || 'node'];
      const g = el('g', {}, o.layer || this.mid);
      el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx: 6, fill: C.paper }, g);
      const body = el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx: 6, fill: tone.fill, stroke: tone.stroke, 'stroke-width': 1,
        'stroke-dasharray': tone.dash }, g);
      const glow = el('rect', { x: o.x - 4, y: o.y - 4, width: o.w + 8, height: o.h + 8, rx: 9, fill: 'none', stroke: C.accent, 'stroke-width': 2.4, opacity: 0 }, g);
      const lg = el('g', {}, o.layer ? g : this.labels);
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      if (o.tag) {
        const tw = o.tag.length * 6 + 10;
        el('rect', { x: o.x + 8, y: o.y + 7, width: tw, height: 13, rx: 2, fill: 'none', stroke: tone.stroke, 'stroke-opacity': 0.45, 'stroke-width': 0.8 }, lg);
        const tag = el('text', { x: o.x + 8 + tw / 2, y: o.y + 16.5, fill: tone.stroke, 'font-size': 8, 'font-family': MONO, 'text-anchor': 'middle', 'letter-spacing': '0.08em' }, lg);
        tag.textContent = o.tag.toUpperCase();
      }
      const tOff = o.tag ? 6 : 0;
      const title = el('text', { x: cx, y: (o.sub ? cy - 3 : cy + 4) + tOff, fill: C.ink, 'font-size': o.size || 13, 'font-weight': 600, 'font-family': SANS, 'text-anchor': 'middle' }, lg);
      const sub = el('text', { x: cx, y: cy + 14 + tOff, fill: C.muted, 'font-size': 10, 'font-family': MONO, 'text-anchor': 'middle' }, lg);
      const sg = syncer(g); const slg = syncer(lg); const sb = syncer(body); const sgl = syncer(glow); const st = syncer(title); const ss = syncer(sub);
      return this.actor({ op: o.op ?? 1, hi: 0, title: o.title, sub: o.sub || '', fill: tone.fill, stroke: tone.stroke, glow: C.accent }, m => {
        sg('opacity', m.op); slg('opacity', m.op); sb('fill', m.fill); sb('stroke', m.stroke); sgl('opacity', m.hi); sgl('stroke', m.glow);
        st('text', m.title); ss('text', m.sub);
      }, { x: o.x, y: o.y, w: o.w, h: o.h, cx, cy });
    }

    pkt(o = {}) {
      const g = el('g', { opacity: 0 }, o.layer || this.fg);
      const rect = el('rect', { y: -10, height: 20, rx: 4, 'stroke-width': 1.3 }, g);
      const text = el('text', { x: 0, y: 3.5, 'text-anchor': 'middle', 'font-size': 10.5, 'font-family': MONO }, g);
      const sg = syncer(g); const sr = syncer(rect); const st = syncer(text);
      return this.actor({ x: o.x ?? -200, y: o.y ?? -200, op: 0, label: o.label || '', kind: o.kind || 'dlt', s: 1, strike: 0 }, m => {
        const k = KINDS[m.kind];
        const w = Math.max(o.minW || 22, m.label.length * 6.3 + 14);
        sg('transform', `translate(${m.x.toFixed(1)},${m.y.toFixed(1)}) scale(${m.s.toFixed(3)})`);
        sg('opacity', m.op);
        sr('x', -w / 2); sr('width', w); sr('fill', k.fill); sr('stroke', k.stroke);
        st('text', m.label); st('fill', k.text);
        st('text-decoration', m.strike ? 'line-through' : 'none');
      });
    }

    txt(o) {
      const t = el('text', { 'font-size': o.size || 12, 'font-weight': o.weight, 'font-family': o.font === 'mono' ? MONO : o.font === 'serif' ? SERIF : SANS,
        'text-anchor': o.anchor || 'start', 'letter-spacing': o.spacing, 'font-style': o.italic ? 'italic' : undefined }, o.layer || this.fg);
      const s = syncer(t);
      return this.actor({ x: o.x, y: o.y, text: o.text || '', op: o.op ?? 1, fill: o.fill || C.ink }, m => {
        s('x', m.x); s('y', m.y); s('text', m.text); s('opacity', m.op); s('fill', m.fill);
      });
    }

    rect(o) {
      const r = el('rect', { rx: o.rx ?? 3, 'stroke-width': o.sw ?? 1, 'stroke-dasharray': o.dash }, o.layer || this.mid);
      const s = syncer(r);
      return this.actor({ x: o.x, y: o.y, w: o.w, h: o.h, fill: o.fill || 'none', stroke: o.stroke || 'none', op: o.op ?? 1 }, m => {
        s('x', m.x); s('y', m.y); s('width', Math.max(0, m.w)); s('height', Math.max(0, m.h)); s('fill', m.fill); s('stroke', m.stroke); s('opacity', m.op);
      });
    }

    grp(o = {}) {
      const g = el('g', {}, o.layer || this.fg);
      const s = syncer(g);
      const actor = this.actor({ x: o.x || 0, y: o.y || 0, op: o.op ?? 1, s: 1 }, m => {
        s('transform', `translate(${m.x.toFixed(1)},${m.y.toFixed(1)}) scale(${m.s})`); s('opacity', m.op);
      });
      actor.g = g;
      return actor;
    }

    card(o) {
      const g = el('g', {}, o.layer || this.top);
      const k = KINDS[o.kind || 'plain'];
      const lines = o.lines.map(line => (typeof line === 'string' ? { text: line } : line));
      const lh = o.lh || 17;
      const h = 12 + (o.title ? 18 : 0) + lines.length * lh + 4;
      el('rect', { x: o.x, y: o.y, width: o.w, height: h, rx: 6, fill: o.fill || C.white, stroke: k.stroke, 'stroke-opacity': 0.6, 'stroke-width': 1 }, g);
      el('rect', { x: o.x, y: o.y + 6, width: 3, height: h - 12, rx: 1.5, fill: k.stroke }, g);
      let y = o.y + 18;
      if (o.title) {
        const t = el('text', { x: o.x + 14, y, fill: k.stroke, 'font-size': 9.5, 'font-family': MONO, 'letter-spacing': '0.12em' }, g);
        t.textContent = o.title.toUpperCase();
        y += 18;
      }
      for (const line of lines) {
        const t = el('text', { x: o.x + 14, y, fill: line.color || C.ink, 'font-size': line.size || (line.mono ? 11 : 12.5), 'font-weight': line.weight,
          'font-family': line.mono ? MONO : SANS }, g);
        t.textContent = line.text;
        y += lh;
      }
      const s = syncer(g);
      return this.actor({ op: o.op ?? 0, dy: 0 }, m => { s('opacity', m.op); s('transform', `translate(0,${m.dy.toFixed(1)})`); }, { h });
    }

    tank(o) {
      const g = el('g', {}, o.layer || this.mid);
      el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx: 6, fill: C.white, stroke: C.ink, 'stroke-width': 1 }, g);
      const fill = el('rect', { x: o.x + 3, width: o.w - 6, rx: 4 }, g);
      const label = el('text', { x: o.x + o.w / 2, y: o.y + o.h + 18, fill: C.ink, 'font-size': 12.5, 'font-weight': 600, 'font-family': SANS, 'text-anchor': 'middle' }, g);
      label.textContent = o.label;
      if (o.sub) {
        const sub = el('text', { x: o.x + o.w / 2, y: o.y + o.h + 33, fill: C.muted, 'font-size': 10, 'font-family': MONO, 'text-anchor': 'middle' }, g);
        sub.textContent = o.sub;
      }
      const s = syncer(fill);
      const inner = o.h - 6;
      return this.actor({ level: 0, fill: C.accentTint, stroke: C.accent }, m => {
        const h = inner * Math.max(0, Math.min(1, m.level));
        s('y', o.y + 3 + inner - h); s('height', h); s('fill', m.fill); s('stroke', m.stroke);
      }, { x: o.x, y: o.y, w: o.w, h: o.h, cx: o.x + o.w / 2, cy: o.y + o.h / 2 });
    }

    bars(o) {
      const rowH = o.rowH || 40;
      const labelW = o.labelW || 220;
      const valueW = o.valueW || 120;
      const max = o.w - labelW - valueW;
      const end = [];
      o.rows.forEach((row, i) => {
        const y = o.y + i * rowH;
        const label = this.txt({ x: o.x, y: y + 15, text: row.label, size: 12.5, fill: C.ink, op: 0 });
        const top = Math.max(row.b, row.a);
        const wb = Math.max(2, max * row.b / top);
        const wa = Math.max(2, max * row.a / top);
        const rb = this.rect({ x: o.x + labelW, y: y + 3, w: 0, h: 12, fill: '#c9cdd6', rx: 2 });
        const ra = this.rect({ x: o.x + labelW, y: y + 19, w: 0, h: 12, fill: o.afterColor || C.ok, rx: 2 });
        const tb = this.txt({ x: o.x + labelW + wb + 8, y: y + 13.5, text: row.bText, size: 10.5, font: 'mono', fill: C.muted, op: 0 });
        const ta = this.txt({ x: o.x + labelW + wa + 8, y: y + 29.5, text: row.aText, size: 10.5, font: 'mono', fill: o.afterColor || C.ok, op: 0 });
        const t0 = o.t + i * (o.stagger ?? 220);
        this.show(label, t0, 200);
        this.tw(t0, 600, p => { rb.m.w = wb * p; }, 'out');
        this.show(tb, t0 + 500, 200);
        this.tw(t0 + 700, 600, p => { ra.m.w = wa * p; }, 'out');
        this.show(ta, t0 + 1200, 200);
        end.push(t0 + 1400);
      });
      if (o.key !== false) {
        const ky = o.y - 14;
        const before = o.beforeLabel || 'before';
        const kx = o.x + o.w - 60 - (before.length + (o.afterLabel || 'after').length) * 6.2;
        const keys = [
          this.rect({ x: kx, y: ky - 9, w: 12, h: 9, fill: '#c9cdd6', rx: 2, op: 0 }),
          this.txt({ x: kx + 17, y: ky, text: before, size: 10, font: 'mono', fill: C.muted, op: 0 }),
          this.rect({ x: kx + 30 + before.length * 6.2, y: ky - 9, w: 12, h: 9, fill: o.afterColor || C.ok, rx: 2, op: 0 }),
          this.txt({ x: kx + 47 + before.length * 6.2, y: ky, text: o.afterLabel || 'after', size: 10, font: 'mono', fill: C.muted, op: 0 }),
        ];
        for (const key of keys) this.show(key, o.t, 300);
      }
      return Math.max(...end);
    }

    // ---------- timeline ----------
    tw(t, d, fn, e = 'io') { this.tweens.push({ t, d, fn, e: EASE[e] || e }); return t + d; }
    at(t, fn) { this.tweens.push({ t, d: 0, fn, e: EASE.lin }); return t; }
    set(a, t, props) { return this.at(t, () => Object.assign(a.m, props)); }
    show(a, t, d = 300) { return this.tw(t, d, p => { a.m.op = Math.max(a.m.op, p); }); }
    hide(a, t, d = 300) { return this.tw(t, d, p => { a.m.op = Math.min(a.m.op, 1 - p); }); }
    pulse(a, t, d = 700) { return this.tw(t, d, p => { a.m.hi = Math.max(a.m.hi, Math.sin(Math.PI * p)); }, 'lin'); }
    glow(a, t, d = 300, color) { if (color) this.set(a, t, { glow: color }); return this.tw(t, d, p => { a.m.hi = Math.max(a.m.hi, p); }); }
    unglow(a, t, d = 300) { return this.tw(t, d, p => { a.m.hi = Math.min(a.m.hi, 1 - p); }); }
    draw(a, t, d = 500) { this.set(a, t, { op: 1 }); return this.tw(t, d, p => { a.m.draw = p; }, 'out'); }
    count(a, t, d, from, to, f = fmt.int, key = 'text') { return this.tw(t, d, p => { a.m[key] = f(from + (to - from) * p); }, 'lin'); }
    move(a, from, to, t, d, e = 'io') {
      this.set(a, t, { x: from[0], y: from[1], op: 1 });
      return this.tw(t, d, p => { a.m.x = from[0] + (to[0] - from[0]) * p; a.m.y = from[1] + (to[1] - from[1]) * p; }, e);
    }
    route(a, stops, t, o = {}) {
      const speed = o.speed ?? 0.45;
      const pts = stops.map(s => (Array.isArray(s) ? { x: s[0], y: s[1] } : s));
      let time = t;
      this.set(a, t, { x: pts[0].x, y: pts[0].y, op: 1, ...(o.label ? { label: o.label } : {}) });
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1]; const p1 = pts[i];
        const d = Math.hypot(p1.x - p0.x, p1.y - p0.y) / speed;
        this.tw(time, d, p => { a.m.x = p0.x + (p1.x - p0.x) * p; a.m.y = p0.y + (p1.y - p0.y) * p; }, 'lin');
        time += d;
        if (o.at) o.at(i, time);
        if (p1.pulse) this.pulse(p1.pulse, time - 120, 650);
        if (p1.dwell) time += p1.dwell;
      }
      if (o.hide !== false) this.hide(a, time, 220);
      return time;
    }
    beat(t, title, body) { this.beats.push({ t, title, body }); return t; }

    finish() {
      this.tweens.forEach((tween, index) => { tween.i = index; });
      this.tweens.sort((a, b) => a.t - b.t || a.i - b.i);
      const last = this.tweens.reduce((max, tween) => Math.max(max, tween.t + tween.d), 0);
      const lastBeat = this.beats.reduce((max, beat) => Math.max(max, beat.t), 0);
      this.duration = Math.max(last + 600, lastBeat + 2500);
      this.beats.sort((a, b) => a.t - b.t);
    }

    render(t) {
      for (const a of this.actors) a.m = Object.assign({}, a.init);
      for (const tween of this.tweens) {
        if (t < tween.t) break;
        const raw = tween.d > 0 ? Math.min(1, (t - tween.t) / tween.d) : 1;
        tween.fn(tween.e(raw), raw);
      }
      for (const a of this.actors) a.sync(a.m);
    }
  }

  const MARKERS = { muted: C.soft, ink: C.ink, accent: C.accent, link: C.link, bad: C.bad, ok: C.ok, snap: C.snap, io: C.io };
  function markerFor(color) {
    for (const [name, value] of Object.entries(MARKERS)) if (value === color) return name;
    return 'muted';
  }
  function installMarkers(svg) {
    const defs = el('defs', {}, svg);
    for (const [name, color] of Object.entries(MARKERS)) {
      const marker = el('marker', { id: `arrow-${name}`, markerWidth: 8, markerHeight: 6, refX: 7, refY: 3, orient: 'auto', markerUnits: 'userSpaceOnUse' }, defs);
      el('polygon', { points: '0 0, 8 3, 0 6', fill: color }, marker);
    }
  }

  class Player {
    constructor(scenes) {
      this.scenes = scenes;
      this.svg = document.getElementById('stage');
      installMarkers(this.svg);
      this.speed = 1;
      this.playing = false;
      this.t = 0;
      this.last = 0;
      this.ui = {
        chapters: document.getElementById('chapters'), play: document.getElementById('play'), prev: document.getElementById('prev'),
        next: document.getElementById('next'), track: document.getElementById('track'), fill: document.getElementById('fill'),
        ticks: document.getElementById('ticks'), clock: document.getElementById('clock'), modes: document.getElementById('modes'),
        speed: document.getElementById('speed'), beatNo: document.getElementById('beat-no'), beatTitle: document.getElementById('beat-title'),
        beatBody: document.getElementById('beat-body'), beats: document.getElementById('beats'), chapterTitle: document.getElementById('chapter-title'),
        nextChapter: document.getElementById('next-chapter'),
      };
      this.renderChapters();
      this.bind();
      const [id, mode] = decodeURIComponent(location.hash.slice(1)).split(':');
      const index = Math.max(0, this.scenes.findIndex(scene => scene.id === id));
      this.load(index, mode);
      this.play();
      requestAnimationFrame(now => this.frame(now));
    }

    renderChapters() {
      this.ui.chapters.innerHTML = '';
      this.scenes.forEach((scene, index) => {
        const button = document.createElement('button');
        button.className = 'chapter';
        button.innerHTML = `<span class="n">${String(index + 1).padStart(2, '0')}</span><span class="t">${scene.title}</span><span class="s">${scene.sub}</span>`;
        button.addEventListener('click', () => { this.load(index); this.play(); });
        this.ui.chapters.appendChild(button);
      });
    }

    load(index, modeId) {
      this.index = index;
      const scene = this.scenes[index];
      const modes = scene.modes || [];
      this.mode = modes.find(mode => mode.id === modeId)?.id || modes[0]?.id;
      if (this.builder) this.builder.root.remove();
      this.builder = new Builder(this.svg);
      scene.build(this.builder, this.mode);
      this.builder.finish();
      this.t = 0;
      [...this.ui.chapters.children].forEach((node, i) => node.classList.toggle('active', i === index));
      this.ui.chapterTitle.textContent = `${String(index + 1).padStart(2, '0')} · ${scene.title}`;
      this.ui.modes.innerHTML = '';
      for (const mode of modes) {
        const button = document.createElement('button');
        button.textContent = mode.label;
        button.className = `mode ${mode.id === this.mode ? 'active' : ''} ${mode.tone || ''}`;
        button.title = 'Toggle with the B key';
        button.addEventListener('click', () => { this.load(this.index, mode.id); this.play(); });
        this.ui.modes.appendChild(button);
      }
      this.ui.ticks.innerHTML = '';
      this.ui.beats.innerHTML = '';
      this.builder.beats.forEach((beat, i) => {
        const tick = document.createElement('span');
        tick.style.left = `${(beat.t / this.builder.duration) * 100}%`;
        tick.title = beat.title;
        this.ui.ticks.appendChild(tick);
        const item = document.createElement('li');
        item.innerHTML = `<span>${i + 1}</span>${beat.title}`;
        item.addEventListener('click', () => { this.seek(beat.t + 1); });
        this.ui.beats.appendChild(item);
      });
      history.replaceState(null, '', `#${scene.id}${this.mode ? `:${this.mode}` : ''}`);
      this.currentBeat = -2;
      this.render();
    }

    bind() {
      this.ui.play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
      this.ui.prev.addEventListener('click', () => this.stepBeat(-1));
      this.ui.next.addEventListener('click', () => this.stepBeat(1));
      this.ui.speed.addEventListener('change', () => { this.speed = Number(this.ui.speed.value); });
      this.ui.nextChapter.addEventListener('click', () => { if (this.index < this.scenes.length - 1) { this.load(this.index + 1); this.play(); } });
      const seekFromPointer = event => {
        const rect = this.ui.track.getBoundingClientRect();
        this.seek(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * this.builder.duration);
      };
      this.ui.track.addEventListener('pointerdown', event => {
        this.ui.track.setPointerCapture(event.pointerId);
        seekFromPointer(event);
        const move = e => seekFromPointer(e);
        const up = () => { this.ui.track.removeEventListener('pointermove', move); this.ui.track.removeEventListener('pointerup', up); };
        this.ui.track.addEventListener('pointermove', move);
        this.ui.track.addEventListener('pointerup', up);
      });
      document.addEventListener('keydown', event => {
        if (event.target instanceof HTMLSelectElement) return;
        if (event.key === ' ') { event.preventDefault(); this.playing ? this.pause() : this.play(); }
        else if (event.key === 'ArrowRight') this.stepBeat(1);
        else if (event.key === 'ArrowLeft') this.stepBeat(-1);
        else if (event.key === 'ArrowDown' || event.key === ']') { if (this.index < this.scenes.length - 1) { this.load(this.index + 1); this.play(); } }
        else if (event.key === 'ArrowUp' || event.key === '[') { if (this.index > 0) { this.load(this.index - 1); this.play(); } }
        else if (event.key === 'b' || event.key === 'B') {
          const modes = this.scenes[this.index].modes || [];
          if (modes.length > 1) {
            const next = modes[(modes.findIndex(mode => mode.id === this.mode) + 1) % modes.length];
            this.load(this.index, next.id); this.play();
          }
        }
      });
    }

    play() {
      if (this.t >= this.builder.duration) this.t = 0;
      this.playing = true;
      this.ui.play.textContent = '❚❚';
      this.ui.play.setAttribute('aria-label', 'Pause');
    }
    pause() {
      this.playing = false;
      this.ui.play.textContent = '▶';
      this.ui.play.setAttribute('aria-label', 'Play');
    }
    seek(t) { this.t = Math.max(0, Math.min(this.builder.duration, t)); this.render(); }
    stepBeat(direction) {
      const beats = this.builder.beats;
      const current = this.beatIndex();
      if (direction < 0 && current >= 0 && this.t - beats[current].t > 900) { this.seek(beats[current].t + 1); return; }
      const target = Math.max(0, Math.min(beats.length - 1, current + direction));
      this.seek(beats[target].t + 1);
    }
    beatIndex() {
      let index = -1;
      this.builder.beats.forEach((beat, i) => { if (beat.t <= this.t) index = i; });
      return index;
    }

    frame(now) {
      const dt = Math.min(100, now - (this.last || now));
      this.last = now;
      if (this.playing) {
        this.t += dt * this.speed;
        if (this.t >= this.builder.duration) { this.t = this.builder.duration; this.pause(); }
        this.render();
      }
      requestAnimationFrame(next => this.frame(next));
    }

    render() {
      this.builder.render(this.t);
      const duration = this.builder.duration;
      this.ui.fill.style.width = `${(this.t / duration) * 100}%`;
      this.ui.clock.textContent = `${(this.t / 1000).toFixed(1)} / ${(duration / 1000).toFixed(0)} s`;
      const index = this.beatIndex();
      if (index !== this.currentBeat) {
        this.currentBeat = index;
        const beat = this.builder.beats[Math.max(0, index)];
        this.ui.beatNo.textContent = `Step ${Math.max(0, index) + 1} of ${this.builder.beats.length}`;
        this.ui.beatTitle.textContent = beat.title;
        this.ui.beatBody.innerHTML = beat.body;
        [...this.ui.beats.children].forEach((node, i) => node.classList.toggle('active', i === index));
      }
      const atEnd = this.t >= duration && this.index < this.scenes.length - 1;
      this.ui.nextChapter.hidden = !atEnd;
    }
  }

  window.Felan = { Player, C, KINDS, fmt, MONO, SANS, SERIF, el };
})();
