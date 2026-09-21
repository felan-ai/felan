import { normalizeBatch } from './normalize.js';

export function parseEnvelope(envelope) {
  return normalizeBatch(envelope.items ?? []);
}
