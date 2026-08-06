import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { positiveInteger, positiveNumber, type WebAccessConfig } from './config.js';
import { extractGitHubRepository, parseGitHubUrl } from './github.js';
import { combinedSignal, readResponseBytes } from './http.js';
import { fetchRemoteUrl, ssrfSettings, validateRemoteUrl } from './ssrf.js';
import type { ExtractedContent } from './types.js';

const MAX_HTTP_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 750_000;
const DEFAULT_PDF_MAX_SIZE_MB = 20;
const MAX_PDF_MAX_SIZE_MB = 50;
const DEFAULT_PDF_MAX_PAGES = 100;
const HTTP_TIMEOUT_MS = 30_000;

export interface ExtractOptions {
  mode?: 'readable' | 'raw';
  forceClone?: boolean;
  allowGitHub?: boolean;
}

export async function extractContent(
  rawUrl: string,
  runtime: AgentRuntime,
  config: WebAccessConfig,
  signal?: AbortSignal,
  options: ExtractOptions = {},
): Promise<ExtractedContent> {
  const settings = ssrfSettings(config);
  const url = await validateRemoteUrl(rawUrl, settings);
  const github = options.allowGitHub === false ? undefined : parseGitHubUrl(url.toString());
  if (github && options.mode !== 'raw') {
    return extractGitHubRepository(url.toString(), github, runtime, config, signal, options.forceClone);
  }

  const response = await fetchRemoteUrl(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json,text/plain,application/pdf,image/*;q=0.8,*/*;q=0.5',
      'User-Agent': 'Felan-Web-Access/0.1',
    },
    signal: combinedSignal(signal, HTTP_TIMEOUT_MS),
  }, settings);
  if (!response.ok) {
    return { url: url.toString(), title: url.hostname, content: '', error: `HTTP ${response.status}` };
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const contentLength = Number(response.headers.get('content-length'));
  if (contentType.startsWith('image/') && Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }
  const pdfMaximumBytes = positiveNumber(config.pdf?.maxSizeMB, DEFAULT_PDF_MAX_SIZE_MB, MAX_PDF_MAX_SIZE_MB) * 1024 * 1024;
  if (isPdf(url, contentType) && Number.isFinite(contentLength) && contentLength > pdfMaximumBytes) {
    throw new Error(`PDF exceeds the configured ${pdfMaximumBytes}-byte limit`);
  }
  const maximumBytes = contentType.startsWith('image/')
    ? MAX_IMAGE_BYTES
    : isPdf(url, contentType) ? pdfMaximumBytes : MAX_HTTP_RESPONSE_BYTES;
  const bytes = await readResponseBytes(response, maximumBytes);

  if (contentType.startsWith('image/')) {
    return {
      url: url.toString(),
      title: fileTitle(url, 'image'),
      content: `[Remote image: ${contentType}, ${bytes.byteLength} bytes]`,
      error: null,
      contentType,
      image: { data: Buffer.from(bytes).toString('base64'), mimeType: contentType },
    };
  }
  if (isPdf(url, contentType)) return extractPdf(bytes, url, config, contentType);

  const text = new TextDecoder().decode(bytes);
  if (options.mode === 'raw') {
    return { url: url.toString(), title: fileTitle(url, url.hostname), content: text, error: null, contentType };
  }
  if (contentType.includes('html') || looksLikeHtml(text)) return extractHtml(text, url, contentType);
  if (contentType.includes('json') || looksLikeJson(text)) return extractJson(text, url, contentType);
  return boundedExtracted({
    url: url.toString(),
    title: fileTitle(url, url.hostname),
    content: text,
    error: null,
    contentType: contentType || 'text/plain',
  });
}

export async function fetchWithConcurrency(
  urls: string[],
  concurrency: number,
  fetchOne: (url: string) => Promise<ExtractedContent>,
  captureErrors = true,
): Promise<ExtractedContent[]> {
  const results = new Array<ExtractedContent>(urls.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (next < urls.length) {
      const index = next;
      next += 1;
      const url = urls[index]!;
      try {
        results[index] = await fetchOne(url);
      } catch (error) {
        if (!captureErrors) throw error;
        results[index] = { url, title: '', content: '', error: errorMessage(error) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function extractHtml(html: string, url: URL, contentType: string): ExtractedContent {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document, { charThreshold: 20 }).parse();
  const turndown = new TurndownService({ codeBlockStyle: 'fenced', headingStyle: 'atx' });
  const title = article?.title?.trim() || document.title?.trim() || fileTitle(url, url.hostname);
  const content = article?.content ? turndown.turndown(article.content) : turndown.turndown(document.body?.innerHTML ?? html);
  return boundedExtracted({ url: url.toString(), title, content: content.trim(), error: null, contentType });
}

function extractJson(text: string, url: URL, contentType: string): ExtractedContent {
  let content = text;
  try {
    content = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Invalid JSON is still useful as exact text.
  }
  return boundedExtracted({ url: url.toString(), title: fileTitle(url, url.hostname), content, error: null, contentType });
}

async function extractPdf(bytes: Uint8Array, url: URL, config: WebAccessConfig, contentType: string): Promise<ExtractedContent> {
  if (typeof (Promise as PromiseConstructor & { try?: unknown }).try !== 'function') {
    const { default: promiseTry } = await import('promise.try');
    promiseTry.shim();
  }
  const [{ getDocumentProxy }, pdfjs] = await Promise.all([import('unpdf'), import('unpdf/pdfjs')]);
  const verbosity = (pdfjs as typeof pdfjs & { VerbosityLevel: { ERRORS: number } }).VerbosityLevel.ERRORS;
  const pdf = await getDocumentProxy(bytes, { verbosity });
  const metadata = await pdf.getMetadata();
  const info = metadata.info && typeof metadata.info === 'object' ? metadata.info as Record<string, unknown> : {};
  const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : fileTitle(url, 'document');
  const maximumPages = positiveInteger(config.pdf?.maxPages, DEFAULT_PDF_MAX_PAGES, 500);
  const pageCount = Math.min(pdf.numPages, maximumPages);
  const sections = [`# ${title}`, '', `Source: ${url.toString()}`, `Pages: ${pdf.numPages}`, ''];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: unknown) => typeof (item as { str?: unknown }).str === 'string' ? (item as { str: string }).str : '').join(' ').replace(/\s+/gu, ' ').trim();
    if (pageText) sections.push(`<!-- Page ${pageNumber} -->`, '', pageText, '');
  }
  return boundedExtracted({
    url: url.toString(),
    title,
    content: sections.join('\n').trim(),
    error: null,
    contentType,
    ...(pdf.numPages > maximumPages ? { truncated: true } : {}),
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

function isPdf(url: URL, contentType: string): boolean {
  return contentType === 'application/pdf' || url.pathname.toLowerCase().endsWith('.pdf');
}

function looksLikeHtml(text: string): boolean {
  return /<!doctype html|<html[\s>]|<body[\s>]/iu.test(text.slice(0, 2_000));
}

function looksLikeJson(text: string): boolean {
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
