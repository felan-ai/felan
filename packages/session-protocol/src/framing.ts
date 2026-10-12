import { LIMITS, ProtocolValidationError } from './limits.js';
import { assertJson, type JsonValue } from './schema.js';

export function encodeFrame(value: unknown): Uint8Array {
  assertJson(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError('invalid_request', 'Frame must contain one JSON object');
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > LIMITS.frameBytes) throw new ProtocolValidationError('invalid_request', 'Frame byte limit exceeded');
  return bytes;
}

export class JsonLineDecoder {
  #buffer = new Uint8Array(1024);
  #length = 0;
  #failed = false;

  push(chunk: Uint8Array): JsonValue[] {
    if (this.#failed) throw new ProtocolValidationError('invalid_request', 'Decoder is closed after invalid input');
    try {
      const result: JsonValue[] = [];
      let start = 0;
      for (let end = 0; end < chunk.length; end++) {
        if (chunk[end] !== 10) continue;
        this.#append(chunk.subarray(start, end));
        result.push(this.#decode());
        start = end + 1;
      }
      this.#append(chunk.subarray(start));
      return result;
    } catch (error) {
      this.#length = 0;
      this.#failed = true;
      throw error;
    }
  }

  finish(): void {
    if (this.#failed || this.#length !== 0) {
      this.#length = 0;
      this.#failed = true;
      throw new ProtocolValidationError('invalid_request', 'Incomplete or invalid JSON frame');
    }
  }

  #append(bytes: Uint8Array): void {
    if (this.#length + bytes.length + 1 > LIMITS.frameBytes) throw new ProtocolValidationError('invalid_request', 'Frame byte limit exceeded');
    if (this.#length + bytes.length > this.#buffer.length) {
      const buffer = new Uint8Array(Math.min(LIMITS.frameBytes, Math.max(this.#length + bytes.length, this.#buffer.length * 2)));
      buffer.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = buffer;
    }
    this.#buffer.set(bytes, this.#length);
    this.#length += bytes.length;
  }

  #decode(): JsonValue {
    const bytes = this.#buffer.subarray(0, this.#length);
    this.#length = 0;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw new ProtocolValidationError('invalid_request', 'Invalid UTF-8 or JSON frame'); }
    assertJson(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError('invalid_request', 'Frame must contain one JSON object');
    return value;
  }
}
