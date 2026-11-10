import { expect, it } from 'vitest';
import { safeMemoryText } from './backend.js';

import { sanitizeMemoryDiagnostic } from './backend.js';

it('preserves the previous diagnostic text without its redundant renderer dependency', () => {
  const samples: unknown[] = [null, undefined, new Error('  failed\noperation  '), 'a'.repeat(4500),
    '\u001b[31mcolored\u001b[0m', '\u001b]0;title\u0007', '\u001b_Gdata\u001b\\',
    'password="not-a-real-secret"', '  ordinary\ttext\r\n',
    Array.from({ length: 256 }, (_, code) => String.fromCharCode(code)).join('')];
  for (const sample of samples) {
    const sanitized = sanitizeMemoryDiagnostic(sample);
    expect(sanitized).not.toContain('\u001b');
    expect(safeMemoryText(sample)).toBe(sanitized.replace(/\s+/gu, ' ').trim().slice(0, 500));
  }
});
