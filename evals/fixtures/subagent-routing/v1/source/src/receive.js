import { parseEnvelope } from './parse.js';

export function receiveBatch(payload) {
  return parseEnvelope(JSON.parse(payload));
}
