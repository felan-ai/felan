import { describe, expect, it } from 'vitest';
import { sessionShared, setSessionSharing, webCreatedSession } from '../src/remote/sharing.js';
import type { RemoteSessionRecord } from '../src/remote/state.js';

const local = (shared: boolean, backfilled = false): RemoteSessionRecord => ({ shared, origin: 'local', backfilled, unsharedPending: false });

describe('remote sharing', () => {
  it('never shares without configured credentials, including web-created sessions', () => {
    for (const share of ['all', 'on-request'] as const) for (const record of [undefined, local(true), webCreatedSession()]) expect(sessionShared({ configured: false, share, record })).toBe(false);
  });
  it('shares all by default, on-request by opt-in, and respects explicit off in either mode', () => {
    expect(sessionShared({ configured: true, share: 'all' })).toBe(true);
    expect(sessionShared({ configured: true, share: 'on-request' })).toBe(false);
    for (const share of ['all', 'on-request'] as const) {
      expect(sessionShared({ configured: true, share, record: local(true) })).toBe(true);
      expect(sessionShared({ configured: true, share, record: local(false) })).toBe(false);
    }
  });
  it('backfills on first on, sends unshared once, and never backfills the off/on gap', () => {
    const input = { configured: true, share: 'on-request' as const };
    const first = setSessionSharing(input, true); expect(first.needsBackfill).toBe(true); expect(first.record.shared).toBe(true);
    const backfilled = { ...first.record, backfilled: true };
    const off = setSessionSharing({ ...input, record: backfilled }, false);
    expect(off.record).toMatchObject({ shared: false, unsharedPending: true });
    const repeated = setSessionSharing({ ...input, record: off.record }, false); expect(repeated.changed).toBe(false);
    const sent = { ...off.record, unsharedPending: false };
    expect(setSessionSharing({ ...input, record: sent }, false).record.unsharedPending).toBe(false);
    const on = setSessionSharing({ ...input, record: sent }, true); expect(on.needsBackfill).toBe(false); expect(on.record.unsharedPending).toBe(false);
    expect(setSessionSharing({ ...input, record: on.record }, true).changed).toBe(false);
  });
  it('marks a default-all session unshared and does not mark a never-shared on-request session', () => {
    expect(setSessionSharing({ configured: true, share: 'all' }, false).record.unsharedPending).toBe(true);
    expect(setSessionSharing({ configured: true, share: 'on-request' }, false).record.unsharedPending).toBe(false);
  });
  it('does not schedule an index upload for a session that was disabled before pairing', () => {
    expect(setSessionSharing({ configured: false, share: 'all' }, false).record.unsharedPending).toBe(false);
    expect(setSessionSharing({ configured: false, share: 'on-request', record: local(true) }, false).record.unsharedPending).toBe(false);
    expect(setSessionSharing({ configured: false, share: 'on-request', record: local(true, true) }, false).record.unsharedPending).toBe(true);
  });
  it('always shares web-created sessions and refuses off', () => {
    const record = webCreatedSession(); const input = { configured: true, share: 'on-request' as const, record };
    expect(sessionShared(input)).toBe(true); expect(setSessionSharing(input, true).needsBackfill).toBe(true);
    expect(() => setSessionSharing(input, false)).toThrow(/always shared/u);
  });
  it('children follow root selection and cannot override it', () => {
    expect(sessionShared({ configured: true, share: 'all', record: local(true), rootRecord: local(false) })).toBe(false);
    expect(sessionShared({ configured: true, share: 'on-request', record: local(false), rootRecord: local(true) })).toBe(true);
    expect(sessionShared({ configured: true, share: 'on-request', record: local(false), rootRecord: webCreatedSession() })).toBe(true);
  });
  it('terminal session or root never publishes and cannot be enabled', () => {
    for (const terminal of ['deleted', 'forbidden'] as const) {
      const record = { ...webCreatedSession(), terminal };
      expect(sessionShared({ configured: true, share: 'all', record })).toBe(false);
      expect(sessionShared({ configured: true, share: 'all', record: local(true), rootRecord: record })).toBe(false);
      expect(() => setSessionSharing({ configured: true, share: 'all', record }, true)).toThrow(/Terminal/u);
    }
  });
});
