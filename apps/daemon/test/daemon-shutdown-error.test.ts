import { expect, it } from 'vitest';
import { HostBlockedSchema, parseSchema } from '@felan-ai/session-protocol';
import { shutdownMessage, shutdownText } from '../src/daemon/shutdown-error.js';

it('truncates diagnostics without splitting Unicode or leaking credentials', () => {
  const message = shutdownText(`${'x'.repeat(999)}😀`);
  expect(message).toBe('x'.repeat(999));
  expect(() => parseSchema(HostBlockedSchema, { recoverable: true, since: 1, message })).not.toThrow();
  const redacted = shutdownMessage(new AggregateError([new Error('api_key=sk-test-12345678\nfailed')], 'nested'));
  expect(redacted).toContain('Error: api_key=[redacted] failed'); expect(redacted).not.toContain('sk-test');
  expect(shutdownText('\ud800')).toBe('\ufffd');
});
