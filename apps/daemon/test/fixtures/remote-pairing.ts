import { vi } from 'vitest';
import type { HostPairingPollResponse, HostPairingStartResponse } from '@felan-ai/session-protocol';
import type { ConnectorPairing } from '../../src/remote/connector.js';
import { HostPairingFailure } from '../../src/remote/pairing.js';
import { now } from './server.js';

const host = '019a0000-0000-7000-8000-000000000001';
const user = '019a0000-0000-7000-8000-000000000003';

export function pairingStart(expiresAt = now + 600_000): HostPairingStartResponse {
  return {
    deviceCode: 'device-code-secret', userCode: 'BCDF-GHJK', verificationUri: 'https://app.felan.ai/pair',
    verificationUriComplete: 'https://app.felan.ai/pair?code=BCDF-GHJK', interval: 1, expiresAt,
  };
}

export class FakePairing implements ConnectorPairing {
  readonly start = vi.fn(async (): Promise<HostPairingStartResponse> => this.response);
  readonly wait = vi.fn((_start: HostPairingStartResponse) => new Promise<HostPairingPollResponse>((resolve, reject) => {
    this.settle = { resolve, reject };
  }));
  readonly cancel = vi.fn(() => this.settle?.reject(new HostPairingFailure('cancelled', 'Browser pairing was cancelled.')));
  private settle: { resolve(value: HostPairingPollResponse): void; reject(error: unknown): void } | undefined;

  constructor(private readonly response: HostPairingStartResponse = pairingStart()) {}

  approve(credential = 'fln_pat_approved'): void {
    this.settle?.resolve({ credential, host: { id: host, teamId: user, userId: user } });
  }
  deny(): void { this.settle?.reject(new HostPairingFailure('denied', 'Browser pairing was denied.')); }
  expire(): void { this.settle?.reject(new HostPairingFailure('expired', 'Browser pairing expired before it was approved.')); }
}
