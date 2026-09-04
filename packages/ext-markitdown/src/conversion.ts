import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import { getDocumentExtension } from './formats.js';
import type { MarkitdownInvocation } from './installer.js';
import { joinRuntimePath } from './runtime-path.js';

export const MAX_MARKITDOWN_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_MARKITDOWN_OUTPUT_BYTES = 10 * 1024 * 1024;
export const MAX_MARKITDOWN_PROCESS_OUTPUT_BYTES = 64 * 1024;
export const MARKITDOWN_CONVERSION_TIMEOUT_MS = 60_000;

const CACHE_DIRECTORY = 'markitdown/cache';
const STAGING_DIRECTORY = 'markitdown/staging';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface MarkitdownConversion {
  readonly cachePath: string;
  readonly cacheHit: boolean;
  readonly extension: string;
}

export interface MarkitdownDocumentConversion extends MarkitdownConversion {
  readonly markdown: string;
}

export type MarkitdownPdfConversion = MarkitdownDocumentConversion;

export interface MarkitdownConversionOptions {
  readonly signal?: AbortSignal;
}

export async function convertDocument(
  runtime: AgentRuntime,
  invocation: MarkitdownInvocation,
  sourcePath: string,
  options: MarkitdownConversionOptions = {},
): Promise<MarkitdownDocumentConversion> {
  const extension = getDocumentExtension(sourcePath);
  const source = await readBoundedInput(runtime, sourcePath);
  validateDocumentContent(source, extension);
  return convertBytes(
    runtime,
    invocation,
    source,
    extension,
    safePath(sourcePath),
    options,
  );
}

export async function convertPdfBytes(
  runtime: AgentRuntime,
  invocation: MarkitdownInvocation,
  source: Uint8Array,
  options: MarkitdownConversionOptions = {},
): Promise<MarkitdownPdfConversion> {
  validatePdfBytes(source);
  return convertBytes(runtime, invocation, source, '.pdf', 'PDF bytes', options);
}

export function validatePdfBytes(source: Uint8Array): void {
  if (!(source instanceof Uint8Array)) throw new TypeError('MarkItDown PDF conversion requires Uint8Array bytes');
  if (source.byteLength > MAX_MARKITDOWN_INPUT_BYTES) {
    throw new Error(`MarkItDown PDF input exceeds the ${formatMebibytes(MAX_MARKITDOWN_INPUT_BYTES)} input limit`);
  }
  validateDocumentContent(source, '.pdf');
}

async function convertBytes(
  runtime: AgentRuntime,
  invocation: MarkitdownInvocation,
  source: Uint8Array,
  extension: string,
  sourceDescription: string,
  options: MarkitdownConversionOptions,
): Promise<MarkitdownPdfConversion> {
  throwIfAborted(options.signal);
  const hash = createHash('sha256')
    .update(`markitdown:${invocation.version}\0${extension}\0`)
    .update(source)
    .digest('hex');
  const storage = runtime.storage('session');
  const cacheRelativePath = `${CACHE_DIRECTORY}/${hash}.md`;
  const cachePath = joinRuntimePath(storage.root, cacheRelativePath);
  const cachedMarkdown = await readUsableCache(runtime, storage, cachePath, cacheRelativePath);
  if (cachedMarkdown !== undefined) {
    throwIfAborted(options.signal);
    return { cachePath, cacheHit: true, extension, markdown: cachedMarkdown };
  }

  await Promise.all([
    storage.mkdir(CACHE_DIRECTORY, { recursive: true }),
    storage.mkdir(STAGING_DIRECTORY, { recursive: true }),
  ]);
  const nonce = randomUUID();
  const inputRelativePath = `${STAGING_DIRECTORY}/${hash}.${nonce}${extension}`;
  const outputRelativePath = `${STAGING_DIRECTORY}/${hash}.${nonce}.md`;
  const inputPath = joinRuntimePath(storage.root, inputRelativePath);
  const outputPath = joinRuntimePath(storage.root, outputRelativePath);

  try {
    await storage.writeFile(inputRelativePath, source);
    throwIfAborted(options.signal);
    const result = await runtime.exec(
      invocation.command,
      [...invocation.args, '-o', outputPath, inputPath],
      {
        cwd: runtime.cwd,
        timeout: MARKITDOWN_CONVERSION_TIMEOUT_MS,
        maxOutputBytes: MAX_MARKITDOWN_PROCESS_OUTPUT_BYTES,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    throwIfAborted(options.signal);
    if (result.killed) throw new Error(`conversion exceeded the ${MARKITDOWN_CONVERSION_TIMEOUT_MS / 1_000}-second limit`);
    if (result.code !== 0) {
      throw new Error(`converter exited with code ${result.code}: ${commandDiagnostic(result.stderr || result.stdout)}`);
    }

    let output: Uint8Array;
    try {
      output = await runtime.readFile(outputPath, { maxBytes: MAX_MARKITDOWN_OUTPUT_BYTES });
    } catch (error) {
      throw new Error(`conversion output is missing or exceeds ${formatMebibytes(MAX_MARKITDOWN_OUTPUT_BYTES)}: ${errorMessage(error)}`);
    }
    const markdown = sanitizeMarkdown(decoder.decode(output)).trim();
    if (!markdown) throw new Error('converter returned no document text');
    const cached = encoder.encode(`${markdown}\n`);
    if (cached.byteLength > MAX_MARKITDOWN_OUTPUT_BYTES) {
      throw new Error(`conversion output exceeds ${formatMebibytes(MAX_MARKITDOWN_OUTPUT_BYTES)} after sanitization`);
    }
    await storage.writeFile(cacheRelativePath, cached);
    return { cachePath, cacheHit: false, extension, markdown };
  } catch (error) {
    if (options.signal?.aborted) throw new Error('MarkItDown conversion was cancelled');
    throw new Error(`MarkItDown could not convert ${sourceDescription}: ${commandDiagnostic(errorMessage(error))}`);
  } finally {
    await Promise.allSettled([
      removeIfPresent(storage, inputRelativePath),
      removeIfPresent(storage, outputRelativePath),
    ]);
  }
}

export function getMarkitdownCacheDirectory(runtime: AgentRuntime): string {
  return joinRuntimePath(runtime.storage('session').root, CACHE_DIRECTORY);
}

async function readBoundedInput(runtime: AgentRuntime, path: string): Promise<Uint8Array> {
  try {
    return await runtime.readFile(path, { maxBytes: MAX_MARKITDOWN_INPUT_BYTES });
  } catch (error) {
    throw new Error(
      `MarkItDown cannot read ${safePath(path)} within the ${formatMebibytes(MAX_MARKITDOWN_INPUT_BYTES)} input limit: ${commandDiagnostic(errorMessage(error))}`,
    );
  }
}

async function readUsableCache(
  runtime: AgentRuntime,
  storage: AgentRuntimeStorage,
  cachePath: string,
  cacheRelativePath: string,
): Promise<string | undefined> {
  try {
    const cached = await runtime.readFile(cachePath, { maxBytes: MAX_MARKITDOWN_OUTPUT_BYTES });
    const markdown = sanitizeMarkdown(decoder.decode(cached)).trim();
    if (!markdown) {
      await removeIfPresent(storage, cacheRelativePath);
      return undefined;
    }
    const normalized = encoder.encode(`${markdown}\n`);
    if (!bytesEqual(cached, normalized)) await storage.writeFile(cacheRelativePath, normalized);
    return markdown;
  } catch {
    await removeIfPresent(storage, cacheRelativePath);
    return undefined;
  }
}

async function removeIfPresent(storage: AgentRuntimeStorage, path: string): Promise<void> {
  try {
    await storage.remove(path);
  } catch {
    // Missing staging and cache files are already clean.
  }
}

function sanitizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/gu, '\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function validateDocumentContent(content: Uint8Array, extension: string): void {
  const pdf = hasPdfSignature(content);
  if (extension === '.pdf' && !pdf) {
    throw new Error('MarkItDown PDF input does not contain a valid %PDF- signature within the first 1024 bytes');
  }
  if (extension !== '.pdf' && pdf) {
    throw new Error('MarkItDown refuses PDF content with a non-PDF extension');
  }
  const imageType = detectImageType(content);
  if (imageType) {
    throw new Error(`MarkItDown intentionally does not handle ${imageType}; use Felan's existing image workflow instead`);
  }
}

function hasPdfSignature(content: Uint8Array): boolean {
  const header = content.subarray(0, 1_024);
  return /%PDF-[0-9]\.[0-9]/u.test(ascii(header, 0, header.byteLength));
}

function detectImageType(content: Uint8Array): string | undefined {
  if (startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'PNG image content';
  if (startsWith(content, [0xff, 0xd8, 0xff])) return 'JPEG image content';
  if (ascii(content, 0, 6) === 'GIF87a' || ascii(content, 0, 6) === 'GIF89a') return 'GIF image content';
  if (ascii(content, 0, 4) === 'RIFF' && ascii(content, 8, 4) === 'WEBP') return 'WebP image content';
  if (ascii(content, 0, 2) === 'BM') return 'BMP image content';
  if (
    startsWith(content, [0x49, 0x49, 0x2a, 0x00])
    || startsWith(content, [0x49, 0x49, 0x2b, 0x00])
    || startsWith(content, [0x4d, 0x4d, 0x00, 0x2a])
    || startsWith(content, [0x4d, 0x4d, 0x00, 0x2b])
  ) return 'TIFF image content';
  return undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('MarkItDown conversion was cancelled');
}

function startsWith(content: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => content[index] === value);
}

function ascii(content: Uint8Array, offset: number, length: number): string {
  if (content.byteLength < offset + length) return '';
  return String.fromCharCode(...content.subarray(offset, offset + length));
}

function commandDiagnostic(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000) || 'no diagnostic output';
}

function safePath(path: string): string {
  return JSON.stringify(path).replace(/[<>&\u2028\u2029]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMebibytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}
