import { expect, it } from 'vitest';
import { redact } from '../src/logger.js';
import { RemoteTextSanitizer } from '../src/remote/text.js';

it.each(['fln_pat_a_secret', 'eyJhbGciOiJIUzI1NiJ9.JWTPAYLOAD.SIGNATURE', 'Bearer opaque-token', 'sk-secretkeyhere'])('masks %s across every possible two-chunk split', secret => {
  expect(redact(secret)).not.toBe(secret);
  for (let split = 1; split < secret.length; split++) {
    const sanitizer = new RemoteTextSanitizer(); let offset = 0; let rendered = '';
    for (const text of [secret.slice(0, split), secret.slice(split), ' done']) {
      const result = sanitizer.push({ v: 1, session: 'session', stream: { id: 'stream', message: 'message', kind: 'text', offset }, text });
      if (result) { expect(result.stream.offset).toBe(rendered.length); rendered += result.text; }
      offset += text.length;
    }
    for (const event of sanitizer.finish('session', 'message')) rendered += event.text;
    expect(rendered).not.toContain(secret); expect(rendered).toHaveLength((secret + ' done').length);
  }
});

it('holds possible prefixes until completion, preserves nonsecrets and Unicode offsets, and rejects late continuation', () => {
  const sanitizer = new RemoteTextSanitizer();
  expect(redact('🦊fln_')).toBe('🦊fln_');
  expect(sanitizer.push({ v: 1, session: 's', stream: { id: 'a', message: 'm', kind: 'text', offset: 0 }, text: '🦊fln_' })).toMatchObject({ text: '🦊', stream: { offset: 0 } });
  expect(sanitizer.finish('s', 'm')).toMatchObject([{ text: 'fln_', stream: { offset: 1 } }]);
  expect(sanitizer.push({ v: 1, session: 's', stream: { id: 'a', message: 'm', kind: 'text', offset: 5 }, text: 'pat_secret' })).toBeUndefined();
});
