export async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) {
      await reader.cancel(signal.reason).catch(() => undefined);
      throw signal.reason ?? new Error('Response read was cancelled');
    }
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new Error('Response read was cancelled');
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds the ${maximumBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readResponseText(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  return new TextDecoder().decode(await readResponseBytes(response, maximumBytes, signal));
}

export async function readJsonResponse<T>(
  response: Response,
  maximumBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  const text = await readResponseText(response, maximumBytes, signal);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
