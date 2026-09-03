export const MARKITDOWN_PDF_EVENT = 'felan:markitdown:pdf-convert:v1';

export interface MarkitdownPdfConversionResult {
  readonly markdown: string;
  readonly converter: 'MarkItDown';
  readonly version: string;
  readonly cacheHit: boolean;
}

export interface MarkitdownPdfConversionRequest {
  readonly version: 1;
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
  claim(): boolean;
  respond(result: Promise<MarkitdownPdfConversionResult>): void;
}

export interface PdfConversionEvents {
  emit(channel: string, data: unknown): void;
}

export function requestPdfConversion(
  events: PdfConversionEvents | undefined,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<MarkitdownPdfConversionResult> | undefined {
  if (!events || signal?.aborted) return undefined;

  let claimed = false;
  let response: Promise<MarkitdownPdfConversionResult> | undefined;
  const request: MarkitdownPdfConversionRequest = {
    version: 1,
    bytes: Uint8Array.from(bytes),
    ...(signal ? { signal } : {}),
    claim() {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    respond(result) {
      if (!claimed || response !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        return;
      }
      response = result;
    },
  };

  try {
    events.emit(MARKITDOWN_PDF_EVENT, request);
  } catch {
    return response;
  }
  return response;
}

export function unavailablePdfConversionError(): string {
  return 'PDF conversion unavailable: MarkItDown did not accept the document. Run /markitdown install to enable PDF support.';
}

export function sanitizedPdfConversionError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return 'PDF conversion was cancelled';
  let message = '';
  try {
    message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  } catch {
    return 'PDF conversion failed';
  }
  if (message.includes('cancel') || message.includes('abort')) return 'PDF conversion was cancelled';
  if (message.includes('disabled') || message.includes('unavailable') || message.includes('not available')) {
    return 'PDF conversion unavailable: MarkItDown is disabled or unavailable. Run /markitdown install to enable PDF support.';
  }
  return 'PDF conversion failed';
}

export function isPdfConversionResult(value: unknown): value is MarkitdownPdfConversionResult {
  return typeof value === 'object'
    && value !== null
    && Reflect.get(value, 'converter') === 'MarkItDown'
    && typeof Reflect.get(value, 'markdown') === 'string'
    && typeof Reflect.get(value, 'version') === 'string'
    && typeof Reflect.get(value, 'cacheHit') === 'boolean';
}
