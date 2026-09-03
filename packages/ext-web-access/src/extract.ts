import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { pdfSettings, type WebAccessConfig } from './config.js';
import { combinedSignal, readResponseBytes } from './http.js';
import {
  isPdfConversionResult,
  requestPdfConversion,
  sanitizedPdfConversionError,
  unavailablePdfConversionError,
  type PdfConversionEvents,
} from './pdf-service.js';
import { fetchRemoteUrl, ssrfSettings, validateRemoteUrl } from './ssrf.js';
import type { ExtractedContent } from './types.js';

const MAX_HTTP_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_LLMS_TXT_RESPONSE_BYTES = 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 750_000;
const HTTP_TIMEOUT_MS = 30_000;
const PDF_SIGNATURE = /^%PDF-[0-9]\.[0-9]/u;

export type LlmsTxtProbeMap = Map<string, Promise<ExtractedContent | undefined>>;

export interface ExtractContentOptions {
  ignoreLlmsTxt?: boolean;
  llmsTxtProbes?: LlmsTxtProbeMap;
}

export async function extractContent(
  rawUrl: string,
  config: WebAccessConfig,
  pdfEvents?: PdfConversionEvents,
  signal?: AbortSignal,
  timeoutMs = HTTP_TIMEOUT_MS,
  options: ExtractContentOptions = {},
): Promise<ExtractedContent> {
  const settings = ssrfSettings(config);
  const requestSignal = combinedSignal(signal, timeoutMs);
  const validatedUrl = await validateRemoteUrl(rawUrl, settings, { signal: requestSignal });
  const response = await fetchRemoteUrl(validatedUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json,application/pdf,text/plain;q=0.9,text/*;q=0.8',
      'User-Agent': 'Felan-Web-Access/0.1',
    },
    signal: requestSignal,
  }, settings);
  const responseUrl = response.url ? new URL(response.url) : validatedUrl;
  if (!response.ok) {
    await response.body?.cancel();
    return {
      url: responseUrl.toString(),
      title: responseUrl.hostname,
      content: '',
      error: `HTTP ${response.status}`,
    };
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!isSupportedContentType(contentType) && contentType !== 'application/octet-stream') {
    await response.body?.cancel();
    throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
  }
  const declaredPdf = contentType === 'application/pdf' || contentType === 'application/octet-stream';
  if (declaredPdf) {
    const limits = pdfSettings(config);
    try {
      return await extractDeclaredPdf(
        response,
        responseUrl,
        contentType,
        limits,
        pdfEvents,
        signal,
        requestSignal,
      );
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  }

  const maximumBytes = MAX_HTTP_RESPONSE_BYTES;
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader !== null && /^\d+$/u.test(contentLengthHeader)
    ? Number(contentLengthHeader)
    : undefined;
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength > maximumBytes)) {
    await response.body?.cancel();
    throw new Error(`Response exceeds the ${maximumBytes}-byte limit`);
  }
  const bytes = await readResponseBytes(response, maximumBytes, requestSignal);

  const pdfSignature = hasPdfSignature(bytes);
  if (pdfSignature) {
    throw new Error(`PDF file signature does not match content type: ${contentType || 'unknown'}`);
  }

  const text = new TextDecoder().decode(bytes);
  if (isHtml(contentType, text)) {
    if (!options.ignoreLlmsTxt
      && !isDirectLlmsTxt(validatedUrl)
      && !isDirectLlmsTxt(responseUrl)
      && shouldProbeLlmsTxt(responseUrl, contentType, text)) {
      const replacement = await getLlmsTxtReplacement(
        responseUrl,
        settings,
        options.llmsTxtProbes ?? new Map(),
        signal,
        timeoutMs,
      );
      if (replacement) return replacement;
    }
    if (signal?.aborted) throw signal.reason ?? new Error('Web content fetch was cancelled');
    return extractHtml(text, responseUrl, contentType || 'text/html');
  }
  if (isJson(contentType, text)) return extractJson(text, responseUrl, contentType || 'application/json');
  return boundedExtracted({
    url: responseUrl.toString(),
    title: fileTitle(responseUrl, responseUrl.hostname),
    content: text,
    error: null,
    contentType: contentType || 'text/plain',
  });
}

async function getLlmsTxtReplacement(
  responseUrl: URL,
  settings: ReturnType<typeof ssrfSettings>,
  probes: LlmsTxtProbeMap,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ExtractedContent | undefined> {
  const origin = responseUrl.origin;
  let probe = probes.get(origin);
  if (!probe) {
    probe = probeLlmsTxt(
      new URL('/llms.txt', responseUrl.origin),
      settings,
      callerSignal,
      combinedSignal(callerSignal, timeoutMs),
    );
    probes.set(origin, probe);
  }
  const replacement = await probe;
  if (callerSignal?.aborted) throw callerSignal.reason ?? new Error('Web content fetch was cancelled');
  return replacement;
}

async function probeLlmsTxt(
  llmsUrl: URL,
  settings: ReturnType<typeof ssrfSettings>,
  callerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal,
): Promise<ExtractedContent | undefined> {
  try {
    const validatedUrl = await validateRemoteUrl(llmsUrl, settings, { signal: requestSignal });
    const response = await fetchRemoteUrl(validatedUrl, {
      headers: {
        Accept: 'text/plain,text/markdown,text/*;q=0.9',
        'User-Agent': 'Felan-Web-Access/0.1',
      },
      signal: requestSignal,
    }, settings, { allowCrossOriginRedirects: false });
    const responseUrl = response.url ? new URL(response.url) : validatedUrl;
    if (responseUrl.origin !== llmsUrl.origin) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }

    const contentType = normalizedContentType(response);
    if (!isLlmsTxtContentType(contentType)) {
      await response.body?.cancel();
      return undefined;
    }
    const contentLength = declaredContentLength(response);
    if (contentLength !== undefined
      && (!Number.isSafeInteger(contentLength) || contentLength > MAX_LLMS_TXT_RESPONSE_BYTES)) {
      await response.body?.cancel();
      return undefined;
    }
    const bytes = await readResponseBytes(response, MAX_LLMS_TXT_RESPONSE_BYTES, requestSignal);
    if (isBinaryText(bytes)) return undefined;
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
    if (!content.trim() || isHtml(contentType, content)) return undefined;
    return boundedExtracted({
      url: responseUrl.toString(),
      title: fileTitle(responseUrl, 'llms.txt'),
      content,
      error: null,
      contentType: contentType || 'text/plain',
      llmsTxtReplacement: true,
    });
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? error;
    return undefined;
  }
}

async function extractDeclaredPdf(
  response: Response,
  responseUrl: URL,
  contentType: string,
  limits: ReturnType<typeof pdfSettings>,
  pdfEvents: PdfConversionEvents | undefined,
  callerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal,
): Promise<ExtractedContent> {
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader !== null && /^\d+$/u.test(contentLengthHeader)
    ? Number(contentLengthHeader)
    : undefined;
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength > limits.maximumBytes)) {
    await response.body?.cancel();
    throw new Error(`PDF exceeds the configured ${limits.maximumBytes}-byte limit`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytes(response, limits.maximumBytes, requestSignal);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Response exceeds the ')) {
      throw new Error(`PDF exceeds the configured ${limits.maximumBytes}-byte limit`);
    }
    throw error;
  }
  if (!hasPdfSignature(bytes)) {
    if (contentType === 'application/pdf') {
      throw new Error('PDF content type does not match the file signature');
    }
    throw new Error('Unsupported binary content: application/octet-stream');
  }
  if (callerSignal?.aborted) throw callerSignal.reason ?? new Error('PDF conversion was cancelled');
  const conversion = requestPdfConversion(pdfEvents, bytes, callerSignal);
  if (!conversion) throw new Error(unavailablePdfConversionError());
  try {
    const converted = await conversion;
    if (!isPdfConversionResult(converted)) throw new Error('invalid conversion result');
    return boundedExtracted({
      url: responseUrl.toString(),
      title: fileTitle(responseUrl, 'document.pdf'),
      content: converted.markdown,
      error: null,
      contentType,
      converter: 'MarkItDown',
    });
  } catch (error) {
    throw new Error(sanitizedPdfConversionError(error, callerSignal));
  }
}

export async function fetchWithConcurrency(
  urls: string[],
  concurrency: number,
  fetchOne: (url: string) => Promise<ExtractedContent>,
  signal?: AbortSignal,
): Promise<ExtractedContent[]> {
  const results = new Array<ExtractedContent>(urls.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (next < urls.length) {
      if (signal?.aborted) throw signal.reason ?? new Error('Web content fetch was cancelled');
      const index = next;
      next += 1;
      const url = urls[index]!;
      try {
        results[index] = await fetchOne(url);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        results[index] = { url, title: '', content: '', error: errorMessage(error) };
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

function extractHtml(html: string, url: URL, contentType: string): ExtractedContent {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document, { charThreshold: 20 }).parse();
  const turndown = new TurndownService({ codeBlockStyle: 'fenced', headingStyle: 'atx' });
  const title = article?.title?.trim() || document.title?.trim() || fileTitle(url, url.hostname);
  const content = article?.content
    ? turndown.turndown(article.content)
    : turndown.turndown(document.body?.innerHTML ?? html);
  return boundedExtracted({ url: url.toString(), title, content: content.trim(), error: null, contentType });
}

function extractJson(text: string, url: URL, contentType: string): ExtractedContent {
  let content = text;
  try {
    content = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Preserve malformed JSON as bounded text so callers can still match it.
  }
  return boundedExtracted({
    url: url.toString(),
    title: fileTitle(url, url.hostname),
    content,
    error: null,
    contentType,
  });
}

function boundedExtracted(value: ExtractedContent): ExtractedContent {
  if (value.content.length <= MAX_EXTRACTED_CHARACTERS) return value;
  return {
    ...value,
    content: value.content.slice(0, MAX_EXTRACTED_CHARACTERS),
    truncated: true,
  };
}

function isSupportedContentType(contentType: string): boolean {
  return contentType === ''
    || contentType.startsWith('text/')
    || contentType === 'application/pdf'
    || contentType === 'application/json'
    || contentType.endsWith('+json')
    || contentType === 'application/xhtml+xml';
}

function normalizedContentType(response: Response): string {
  return response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
}

function declaredContentLength(response: Response): number | undefined {
  const value = response.headers.get('content-length');
  return value !== null && /^\d+$/u.test(value) ? Number(value) : undefined;
}

function isDirectLlmsTxt(url: URL): boolean {
  return url.pathname.toLowerCase() === '/llms.txt';
}

function shouldProbeLlmsTxt(url: URL, contentType: string, text: string): boolean {
  if (isDirectLlmsTxt(url)) return false;
  if (contentType.includes('html')) return true;
  return contentType === '' && isHtml(contentType, text);
}

function isLlmsTxtContentType(contentType: string): boolean {
  return contentType === '' || (contentType.startsWith('text/') && !contentType.includes('html'));
}

function isBinaryText(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) return true;
  }
  return false;
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  return PDF_SIGNATURE.test(new TextDecoder('ascii').decode(bytes.subarray(0, 8)));
}

function isHtml(contentType: string, text: string): boolean {
  return contentType.includes('html') || /<!doctype html|<html[\s>]|<body[\s>]/iu.test(text.slice(0, 2_000));
}

function isJson(contentType: string, text: string): boolean {
  if (contentType.includes('json')) return true;
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function fileTitle(url: URL, fallback: string): string {
  const segment = url.pathname.split('/').filter(Boolean).at(-1);
  return segment ? decodeURIComponent(segment) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
