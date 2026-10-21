import { describe, expect, it } from 'vitest';
import type { TextStreamEvent } from '@felan-ai/session-protocol';
import { RemoteTextSanitizer } from '../src/remote/text.js';

const session = '0199e5f0-0000-7000-8000-000000000001';
function delta(text: string, offset = 0): TextStreamEvent {
  return { v: 1, session, stream: { id: 'stream', message: 'message', kind: 'assistant', offset }, text };
}
function sanitize(chunks: string[]): TextStreamEvent[] {
  const sanitizer = new RemoteTextSanitizer();
  const result: TextStreamEvent[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const event = sanitizer.push(delta(chunk, offset));
    if (event) result.push(event);
    offset += Array.from(chunk).length;
  }
  result.push(...sanitizer.finish(session, 'message'));
  let nextOffset = 0;
  for (const event of result) {
    expect(event.stream.offset).toBe(nextOffset);
    nextOffset += Array.from(event.text).length;
  }
  expect(nextOffset).toBe(offset);
  return result;
}
const tokens = [
  'fln_pat_a', 'bzy_team_a', 'sk-12345678', 'pk-12345678', 'rk-12345678',
  'ghp_12345678', 'gho_12345678', 'ghu_12345678', 'ghs_12345678', 'ghr_12345678',
  'github_pat_12345678', 'xoxb-12345678', 'xoxa-12345678', 'xoxp-12345678', 'xoxr-12345678',
  'AKIA12345678', 'AIza12345678901234567890', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature',
  'fln_pat_synthetic_0123456789abcdefghijklmnopqrstuvwxyz',
  'sk-proj-synthetic_0123456789abcdefghijklmnopqrstuvwxyz',
  'ghp_0123456789abcdefghijklmnopqrstuvwxyzABCD',
  'xox' + 'b-1234567890-1234567890-syntheticabcdefghijklmnop',
];

describe('RemoteTextSanitizer', () => {
  it('preserves ordinary hyphenated words, including across every chunk boundary', () => {
    const text = 'The network-level task-based fork-join risk-free design.';
    for (let index = 0; index <= text.length; index++) {
      expect(sanitize([text.slice(0, index), text.slice(index)]).map(event => event.text).join('')).toBe(text);
    }
    expect(sanitize(Array.from(text)).map(event => event.text).join('')).toBe(text);
  });

  it.each(tokens)('masks %s across every split while preserving Unicode offsets', token => {
    for (let index = 0; index <= token.length; index++) {
      const chunks = [`🦊 é ${token.slice(0, index)}`, `${token.slice(index)} 😀 done`];
      expect(sanitize(chunks).map(event => event.text).join('')).toBe(`🦊 é ${'*'.repeat(token.length)} 😀 done`);
    }
    expect(sanitize(Array.from(`🦊 ${token} 😀`)).map(event => event.text).join('')).toBe(`🦊 ${'*'.repeat(token.length)} 😀`);
  });

  it('does not emit a possible token before enough characters arrive to classify it', () => {
    const sanitizer = new RemoteTextSanitizer();
    expect(sanitizer.push(delta('sk-1234567'))).toBeUndefined();
    expect(sanitizer.push(delta('8', 10))).toMatchObject({ text: '***********', stream: { offset: 0 } });
    expect(sanitizer.push(delta('more!', 11))).toMatchObject({ text: '****!', stream: { offset: 11 } });
  });

  it.each(['fln_pat_', 'bzy_team_', 'sk-1234567', 'pk-1234567', 'rk-1234567', 'ghp_1234567', 'github_pat_1234567', 'xoxb-1234567', 'AKIA1234567', 'AIza1234567890123456789', 'eyJ1234567.a.b', 'eyJ12345678.a', 'eyJ12345678.a.'])('preserves incomplete nonsecrets: %s', text => {
    expect(sanitize(Array.from(text)).map(event => event.text).join('')).toBe(text);
    expect(sanitize(Array.from(`${text}!`)).map(event => event.text).join('')).toBe(`${text}!`);
  });

  it.each(tokens)('requires a word boundary before %s even across chunks', token => {
    expect(sanitize(['word', token]).map(event => event.text).join('')).toBe(`word${token}`);
    expect(sanitize([`_${token.slice(0, 1)}`, token.slice(1)]).map(event => event.text).join('')).toBe(`_${token}`);
  });

  it('masks split Bearer credentials without masking embedded words', () => {
    expect(sanitize(['🦊 Be', 'arer ', 'abc', '123! done']).map(event => event.text).join('')).toBe('🦊 Bearer ******* done');
    expect(sanitize(['word', 'Bearer abc']).map(event => event.text).join('')).toBe('wordBearer abc');
  });

  it('drops gapped streams and clears withheld text when discarded', () => {
    const sanitizer = new RemoteTextSanitizer();
    expect(sanitizer.push(delta('sk-'))).toBeUndefined();
    expect(sanitizer.push(delta('12345678', 9))).toBeUndefined();
    expect(sanitizer.finish(session, 'message')).toEqual([]);
    sanitizer.push(delta('sk-'));
    sanitizer.discard(session);
    expect(sanitizer.finish(session, 'message')).toEqual([]);
    sanitizer.push(delta('sk-'));
    sanitizer.clear();
    expect(sanitizer.finish(session, 'message')).toEqual([]);
  });
});

it.each([
  ['password=hunt', 'er2secret end'], ['password: hunt', 'er2secret end'],
  ['api_', 'key=', 'abcdef', 'ghi end'], ['my_pass', 'word', ' = ', 'hunt', 'er2secret end'],
  ['"client_secret": "long ', 'secret', ' value" end'], ["'credential': 'long ", 'secret', " value' end"],
  ['Authorization: Bear', 'er abc.def.ghi end'], ['?access_token=abc', 'def&next=1'],
  ['?code=abc', 'def&state=next', 'value end'],
])('masks secret assignments split into chunks: %j', (...chunks) => {
  const result = sanitize(chunks).map(event => event.text).join('');
  for (const secret of ['hunt', 'er2secret', 'abcdef', 'ghi', 'secret value', 'abc.def.ghi', 'nextvalue']) expect(result).not.toContain(secret);
});

it('masks assignments across every split, retaining Unicode offsets', () => {
  for (const assignment of ['password=hunter2secret', 'api-key: "héllo 🦊 secret"', "'client_secret' = 'private value'"]) {
    const input = `${assignment}; safe text.`;
    for (let split = 0; split < input.length; split++) {
      const result = sanitize([input.slice(0, split), input.slice(split)]).map(event => event.text).join('');
      expect(result).not.toContain('hunter2secret'); expect(result).not.toContain('héllo'); expect(result).not.toContain('private');
    }
  }
});
