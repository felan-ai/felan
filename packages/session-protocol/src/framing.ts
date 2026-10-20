import { ProtocolValidationError } from './limits.js';
import { assertJson, type JsonValue } from './schema.js';

const encoder = new TextEncoder();

export function encodeFrame(value: unknown): Uint8Array {
  assertJson(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError('invalid_request', 'Frame must contain one JSON object');
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

export class JsonLineDecoder {
  #buffer = new Uint8Array(1024);
  #length = 0;
  #failed = false;
  #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  push(chunk: Uint8Array): JsonValue[] {
    if (this.#failed) throw new ProtocolValidationError('invalid_request', 'Decoder is closed after invalid input');
    try {
      const result: JsonValue[] = [];
      let start = 0;
      if (this.#length === 0 && chunk[chunk.length - 1] === 10) {
        const text = this.#decodeText(chunk);
        for (let end = text.indexOf('\n', start); end !== -1; end = text.indexOf('\n', start)) {
          result.push(this.#parse(text.slice(start, end)));
          start = end + 1;
        }
        return result;
      }
      for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
        const line = chunk.subarray(start, end);
        if (this.#length === 0) result.push(this.#parse(this.#decodeText(line)));
        else {
          this.#append(line);
          const bytes = this.#buffer.subarray(0, this.#length);
          this.#length = 0;
          result.push(this.#parse(this.#decodeText(bytes)));
        }
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
    if (bytes.length === 0) return;
    if (this.#length + bytes.length > this.#buffer.length) {
      const buffer = new Uint8Array(Math.max(this.#length + bytes.length, this.#buffer.length * 2));
      buffer.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = buffer;
    }
    this.#buffer.set(bytes, this.#length);
    this.#length += bytes.length;
  }

  #decodeText(bytes: Uint8Array): string {
    try { return this.#decoder.decode(bytes); }
    catch { throw new ProtocolValidationError('invalid_request', 'Invalid UTF-8 or JSON frame'); }
  }

  #parse(text: string): JsonValue {
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new ProtocolValidationError('invalid_request', 'Invalid UTF-8 or JSON frame'); }
    assertJson(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError('invalid_request', 'Frame must contain one JSON object');
    return value;
  }
}
