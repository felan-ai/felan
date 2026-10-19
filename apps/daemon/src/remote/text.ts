import type { TextStreamEvent } from '@felan-ai/session-protocol';
import { redact } from '../logger.js';

const alphabet = /[A-Za-z0-9_-]/u;
const patterns = [
  { prefix: 'fln_pat_', minimum: 1 },
  { prefix: 'AIza', minimum: 20 },
  ...['sk-', 'pk-', 'rk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'AKIA'].map(prefix => ({ prefix, minimum: 8 })),
];
interface Stream {
  event: TextStreamEvent;
  pending: string;
  nextOffset: number;
  previous: string;
  mask?: RegExp | undefined;
  bearer?: boolean | undefined;
  dropped?: boolean;
  assignment: Assignment;
}
interface Assignment {
  key: string;
  sensitive: boolean;
  separated: boolean;
  query: boolean;
  header?: boolean;
  value?: 'waiting' | 'unquoted' | 'header' | '"' | "'";
}

export class RemoteTextSanitizer {
  private readonly streams = new Map<string, Stream>();
  push(event: TextStreamEvent): TextStreamEvent | undefined {
    const key = JSON.stringify([event.session, event.stream.id, event.stream.message, event.stream.kind]);
    let state = this.streams.get(key);
    if (!state) {
      if (event.stream.offset !== 0 || this.streams.size >= 64) return;
      state = { event: structuredClone(event), pending: '', nextOffset: 0, previous: '',
        assignment: { key: '', sensitive: false, separated: false, query: false } }; this.streams.set(key, state);
    }
    if (state.dropped) return;
    if (event.stream.offset !== state.nextOffset) { state.pending = ''; state.dropped = true; return; }
    state.nextOffset += Array.from(event.text).length;
    return this.drain(state, state.pending + this.maskAssignments(state.assignment, event.text));
  }
  private maskAssignments(state: Assignment, input: string): string {
    let output = '';
    for (const point of input) {
      if (state.value === 'waiting') {
        if (/\s/u.test(point)) { output += point; continue; }
        state.value = point === '"' || point === "'" ? point : state.header ? 'header' : 'unquoted';
        if (state.value === '"' || state.value === "'") { output += point; continue; }
      }
      if (state.value) {
        const terminator = state.value === 'header' ? /[\r\n,;}&]/u.test(point)
          : state.value === 'unquoted' ? /[\s,;}&]/u.test(point) : point === state.value;
        if (!terminator) { output += '*'; continue; }
        const quoted = state.value === '"' || state.value === "'";
        delete state.value;
        state.key = ''; state.sensitive = false; state.separated = false; state.query = false;
        if (quoted) { output += point; continue; }
      }
      if (/[\w-]/u.test(point)) {
        if (state.separated) { state.key = ''; state.sensitive = false; state.query = false; }
        state.separated = false;
        state.key = (state.key + point).slice(-32);
        state.sensitive ||= /api[_-]?key|token|secret|password|authorization|credential/iu.test(state.key);
      } else if (/\s/u.test(point) || point === '"' || point === "'") {
        state.separated = true;
      } else {
        if ((point === ':' || point === '=') && (state.sensitive || state.query && /^(?:code|state|key)$/iu.test(state.key))) {
          state.value = 'waiting'; state.header = /authorization/iu.test(state.key);
        }
        state.key = ''; state.sensitive = false; state.separated = false; state.query = point === '?' || point === '&';
      }
      output += point;
    }
    return output;
  }
  private drain(state: Stream, input: string, final = false): TextStreamEvent | undefined {
    state.pending = '';
    const previous = state.previous;
    let output = '';
    let index = 0;
    for (; index < input.length;) {
      const point = String.fromCodePoint(input.codePointAt(index)!);
      if (state.bearer && /\s/u.test(point)) { output += point; index += point.length; continue; }
      if (state.bearer) { state.bearer = false; state.mask = /[^\s,;]/u; }
      if (state.mask?.test(point)) { output += '*'; index += point.length; continue; }
      state.mask = undefined;
      const rest = input.slice(index);
      if (/\w/u.test(index ? input[index - 1]! : previous)) {
        output += point; index += point.length; continue;
      }
      if (/^bearer\s/iu.test(rest)) {
        const prefix = rest.slice(0, 7); output += prefix; index += prefix.length; state.bearer = true; continue;
      }
      const pattern = patterns.find(pattern => rest.startsWith(pattern.prefix));
      if (pattern) {
        let end = pattern.prefix.length;
        while (end < rest.length && end < pattern.prefix.length + pattern.minimum && alphabet.test(rest[end]!)) end++;
        if (end === pattern.prefix.length + pattern.minimum) {
          output += '*'.repeat(end); index += end; state.mask = alphabet; continue;
        }
        if (end === rest.length && !final) { state.pending = rest; break; }
        output += rest.slice(0, end); index += end; continue;
      }
      const jwt = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.exec(rest);
      if (jwt) { output += '*'.repeat(jwt[0].length); index += jwt[0].length; state.mask = alphabet; continue; }
      const possibleJwt = /^eyJ[A-Za-z0-9_-]*$/u.test(rest)
        || /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/u.test(rest)
        || /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.$/u.test(rest);
      if (!final && (possibleJwt || 'eyJ'.startsWith(rest) || patterns.some(pattern => pattern.prefix.startsWith(rest)) || 'bearer'.startsWith(rest.toLowerCase()))) {
        // Withhold possible credentials until their minimum length and shape can be decided.
        state.pending = rest; break;
      }
      output += point; index += point.length;
    }
    if (index) state.previous = input[index - 1]!;
    if (!output) return;
    // A carried word character must not gain a false boundary at the chunk start.
    const contextual = (/\w/u.test(previous) ? '_' : '') + previous + output;
    const result = { ...state.event, stream: { ...state.event.stream }, text: redact(contextual) === contextual ? output : '*'.repeat(Array.from(output).length) };
    state.event.stream.offset += Array.from(output).length;
    return result;
  }
  discard(session: string): void { for (const [key, state] of this.streams) if (state.event.session === session) this.streams.delete(key); }
  clear(): void { this.streams.clear(); }
  finish(session: string, message: string): TextStreamEvent[] {
    const result: TextStreamEvent[] = [];
    for (const [key, state] of this.streams) {
      if (state.event.session !== session || state.event.stream.message !== message) continue;
      const event = this.drain(state, state.pending, true);
      if (event) result.push(event);
      this.streams.delete(key);
    }
    return result;
  }
}
