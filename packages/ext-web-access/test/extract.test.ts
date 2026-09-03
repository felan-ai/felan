import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractContent, fetchWithConcurrency } from '../src/extract.js';
import {
  MARKITDOWN_PDF_EVENT,
  requestPdfConversion,
  type MarkitdownPdfConversionRequest,
  type PdfConversionEvents,
} from '../src/pdf-service.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));

describe('content extraction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stops dequeuing URLs when the caller cancels', async () => {
    const controller = new AbortController();
    const fetchOne = vi.fn(async (url: string) => {
      controller.abort(new Error('request cancelled'));
      throw new Error(`cancelled while fetching ${url}`);
    });

    await expect(fetchWithConcurrency(
      ['https://pages.example/first', 'https://pages.example/second'],
      1,
      fetchOne,
      controller.signal,
    )).rejects.toThrow('request cancelled');
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  it('waits for active cleanup before a concurrent cancellation settles', async () => {
    const controller = new AbortController();
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const started: string[] = [];
    const fetchOne = vi.fn(async (url: string) => {
      started.push(url);
      if (url.endsWith('/first')) {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await cleanup;
        throw new Error('active fetch cancelled after cleanup');
      }
      controller.abort(new Error('request cancelled'));
      throw new Error('queued fetch cancelled');
    });
    const request = fetchWithConcurrency(
      [
        'https://pages.example/first',
        'https://pages.example/second',
        'https://pages.example/never-started',
      ],
      2,
      fetchOne,
      controller.signal,
    );
    let settled = false;
    void request.catch(() => undefined).finally(() => { settled = true; });

    await vi.waitFor(() => expect(started).toHaveLength(2));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(started).not.toContain('https://pages.example/never-started');

    finishCleanup();
    await expect(request).rejects.toThrow(/request cancelled|active fetch cancelled/iu);
  });

  it('converts readable HTML to Markdown', async () => {
    mockResponse(`<!doctype html><html><head><title>Docs</title></head><body><article><h1>Guide</h1><p>Hello <a href="https://docs.example/link">reader</a>. This paragraph contains enough useful prose for readable article extraction.</p></article></body></html>`, 'text/html; charset=utf-8');

    const result = await extractContent('https://docs.example/guide', {});

    expect(result).toMatchObject({ error: null, contentType: 'text/html' });
    expect(result.title).toMatch(/Guide|Docs/u);
    expect(result.content).toContain('# Guide');
    expect(result.content).toContain('[reader](https://docs.example/link)');
  });

  it('replaces HTML with a valid origin-root llms.txt and its final provenance', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/nested/guide') {
        return new Response('<html><body>REQUESTED_HTML_ONLY</body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.pathname === '/llms.txt') {
        return new Response(null, {
          status: 302,
          headers: { location: '/reference.txt' },
        });
      }
      return responseWithUrl('# Documentation\nLLMS_ONLY_TERM', {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      }, 'https://docs.example:8443/reference.txt');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractContent('https://docs.example:8443/nested/guide?view=full', {});

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://docs.example:8443/nested/guide?view=full',
      'https://docs.example:8443/llms.txt',
      'https://docs.example:8443/reference.txt',
    ]);
    expect(result).toMatchObject({
      url: 'https://docs.example:8443/reference.txt',
      title: 'reference.txt',
      content: '# Documentation\nLLMS_ONLY_TERM',
      contentType: 'text/markdown',
      error: null,
      llmsTxtReplacement: true,
    });
    expect(result.content).not.toContain('REQUESTED_HTML_ONLY');
  });

  it('falls back to fetched HTML when llms.txt redirects cross-origin', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/llms.txt') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example/attacker-controlled.txt' },
        });
      }
      return new Response('<html><body>CROSS ORIGIN FALLBACK TERM</body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractContent('https://docs.example/guide', {});

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://docs.example/guide',
      'https://docs.example/llms.txt',
    ]);
    expect(result.url).toBe('https://docs.example/guide');
    expect(result.content).toContain('CROSS ORIGIN FALLBACK TERM');
    expect(result.content).not.toContain('attacker-controlled');
    expect(result).not.toMatchObject({ llmsTxtReplacement: true });
  });

  it('uses requested HTML when ignoreLlmsTxt is true', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '<html><head><title>Requested</title></head><body><p>REQUESTED TERM</p></body></html>',
      { headers: { 'content-type': 'text/html' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractContent(
      'https://docs.example/guide',
      {},
      undefined,
      undefined,
      undefined,
      { ignoreLlmsTxt: true },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.url).toBe('https://docs.example/guide');
    expect(result.content).toContain('REQUESTED TERM');
  });

  it('does not probe direct llms.txt, JSON, declared text, or PDF resources', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.toLowerCase() === '/llms.txt') {
        return new Response('DIRECT_LLMS', { headers: { 'content-type': 'text/plain' } });
      }
      if (url.pathname.endsWith('.json')) {
        return new Response('{"kind":"JSON_TERM"}', { headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('.pdf')) {
        return new Response(pdfBytes('PDF_TERM'), { headers: { 'content-type': 'application/pdf' } });
      }
      return new Response('<html><body>DECLARED_TEXT_TERM</body></html>', {
        headers: { 'content-type': 'text/plain' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await extractContent('https://docs.example/LLMS.TXT?direct=true', {});
    await extractContent('https://docs.example/data.json', {});
    await extractContent('https://docs.example/declared.txt', {});
    await extractContent('https://docs.example/report.pdf', {}, mockPdfEvents('PDF_TERM'));

    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/LLMS.TXT',
      '/data.json',
      '/declared.txt',
      '/report.pdf',
    ]);
  });

  it('does not probe again when requested HTML redirects to llms.txt', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/guide') {
        return new Response(null, { status: 302, headers: { location: '/llms.txt' } });
      }
      return responseWithUrl('<html><body>FINAL DIRECT LLMS PAGE</body></html>', {
        headers: { 'content-type': 'text/html' },
      }, 'https://docs.example/llms.txt');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractContent('https://docs.example/guide', {});

    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/guide',
      '/llms.txt',
    ]);
    expect(result.url).toBe('https://docs.example/llms.txt');
    expect(result.content).toContain('FINAL DIRECT LLMS PAGE');
  });

  it.each([
    ['404', () => new Response('PRIVATE_404_BODY', { status: 404, headers: { 'content-type': 'text/plain' } })],
    ['empty', () => new Response('   \n', { headers: { 'content-type': 'text/plain' } })],
    ['HTML', () => new Response('<html><body>PRIVATE_HTML_ERROR</body></html>', { headers: { 'content-type': 'text/html' } })],
    ['binary', () => new Response(new Uint8Array([76, 76, 77, 83, 0, 1]), { headers: { 'content-type': 'text/plain' } })],
    ['unsupported', () => new Response('{"PRIVATE":"JSON"}', { headers: { 'content-type': 'application/json' } })],
    ['oversized', () => new Response('PRIVATE_OVERSIZED_BODY', {
      headers: { 'content-type': 'text/plain', 'content-length': String(1024 * 1024 + 1) },
    })],
    ['streamed oversized', () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600 * 1024));
        controller.enqueue(new Uint8Array(600 * 1024));
      },
    }), { headers: { 'content-type': 'text/plain' } })],
  ])('falls back to fetched HTML for an invalid %s llms.txt response', async (_label, companion) => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname === '/llms.txt'
        ? companion()
        : new Response('<html><body>HTML FALLBACK TERM</body></html>', {
          headers: { 'content-type': 'text/html' },
        });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractContent('https://docs.example/guide', {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.url).toBe('https://docs.example/guide');
    expect(result.content).toContain('HTML FALLBACK TERM');
    expect(result.content).not.toMatch(/PRIVATE_/u);
  });

  it('falls back to fetched HTML when the llms.txt request times out', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== '/llms.txt') {
        return new Response('<html><body>TIMEOUT FALLBACK TERM</body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractContent('https://docs.example/guide', {}, undefined, undefined, 10);

    expect(result.content).toContain('TIMEOUT FALLBACK TERM');
  });

  it('falls back to fetched HTML when the llms.txt request fails on the network', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/llms.txt') throw new Error('PRIVATE_NETWORK_DETAIL');
      return new Response('<html><body>NETWORK FALLBACK TERM</body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractContent('https://docs.example/guide', {});

    expect(result.content).toContain('NETWORK FALLBACK TERM');
    expect(result.content).not.toContain('PRIVATE_NETWORK_DETAIL');
  });

  it('falls back to fetched HTML when llms.txt redirects to a private target', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/llms.txt') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
      }
      return new Response('<html><body>PRIVATE REDIRECT FALLBACK</body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractContent('https://docs.example/guide', {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('PRIVATE REDIRECT FALLBACK');
  });

  it('propagates caller cancellation during the llms.txt request', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled llms lookup');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== '/llms.txt') {
        return new Response('<html><body>requested</body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const extraction = extractContent('https://docs.example/guide', {}, undefined, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort(reason);

    await expect(extraction).rejects.toBe(reason);
  });

  it('returns plain text unchanged', async () => {
    mockResponse('plain text evidence\nsecond line', 'text/plain; charset=utf-8');

    const result = await extractContent('https://docs.example/notes.txt', {});

    expect(result).toMatchObject({
      title: 'notes.txt',
      content: 'plain text evidence\nsecond line',
      error: null,
      contentType: 'text/plain',
    });
  });

  it('rejects oversized text responses before retaining their bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not retained', {
      headers: {
        'content-type': 'text/plain',
        'content-length': String(5 * 1024 * 1024 + 1),
      },
    })));

    await expect(extractContent('https://docs.example/oversized.txt', {}))
      .rejects.toThrow('Response exceeds the 5242880-byte limit');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3 * 1024 * 1024));
        controller.enqueue(new Uint8Array(3 * 1024 * 1024));
      },
    }), { headers: { 'content-type': 'text/plain' } })));
    await expect(extractContent('https://docs.example/streamed.txt', {}))
      .rejects.toThrow('Response exceeds the 5242880-byte limit');
  });

  it('cancels a stalled response body when the caller aborts mid-flight', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled body read');
    let bodyCancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('partial'));
      },
      cancel(value) {
        bodyCancelled = value === reason;
      },
    }), { headers: { 'content-type': 'text/plain' } })));

    const extraction = extractContent('https://docs.example/stalled.txt', {}, undefined, controller.signal);
    await vi.waitFor(() => expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(extraction).rejects.toBe(reason);
    expect(bodyCancelled).toBe(true);
  });

  it('rejects unsupported binary content', async () => {
    mockResponse('binary payload', 'application/octet-stream');

    await expect(extractContent('https://docs.example/archive.bin', {}))
      .rejects.toThrow('Unsupported binary content: application/octet-stream');
  });

  it('returns the exact conversion Promise accepted synchronously by the event listener', () => {
    const accepted = Promise.resolve(markitdownResult('accepted'));
    const events = respondingPdfEvents(accepted);

    const returned = requestPdfConversion(events, new Uint8Array([1, 2, 3]));

    expect(returned).toBe(accepted);
  });

  it('emits owned PDF bytes through the versioned event contract and awaits conversion', async () => {
    const source = pdfBytes('source bytes');
    mockResponse(source, 'application/pdf');
    const controller = new AbortController();
    const conversion = deferredPdfConversion();
    const events = respondingPdfEvents(conversion.promise);

    const extraction = extractContent('https://docs.example/report.pdf', {}, events, controller.signal);
    let settled = false;
    void extraction.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(events.emit).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    const [channel, value] = events.emit.mock.calls[0]!;
    const request = value as MarkitdownPdfConversionRequest;
    expect(channel).toBe(MARKITDOWN_PDF_EVENT);
    expect(Object.keys(request as object).sort()).toEqual(['bytes', 'claim', 'respond', 'signal', 'version']);
    expect(request).toMatchObject({
      version: 1,
      signal: controller.signal,
      claim: expect.any(Function),
      respond: expect.any(Function),
    });
    expect(request.bytes).toBeInstanceOf(Uint8Array);
    expect(request.bytes.buffer).not.toBe(source);
    expect(new TextDecoder().decode(request.bytes)).toBe(new TextDecoder().decode(source));

    conversion.resolve(markitdownResult('[Page 1]\nFirst page evidence'));
    const result = await extraction;
    expect(result).toMatchObject({
      title: 'report.pdf',
      contentType: 'application/pdf',
      content: '[Page 1]\nFirst page evidence',
      converter: 'MarkItDown',
      error: null,
    });
  });

  it('accepts a valid PDF mislabeled as application/octet-stream', async () => {
    mockResponse(pdfBytes('mislabeled'), 'application/octet-stream');
    const events = mockPdfEvents('Mislabeled PDF evidence');

    const result = await extractContent('https://docs.example/download', {}, events);

    expect(result.contentType).toBe('application/octet-stream');
    expect(result.converter).toBe('MarkItDown');
    expect(result.content).toContain('Mislabeled PDF evidence');
  });

  it('requires synchronous event acceptance and sanitizes conversion failures without a fallback', async () => {
    mockResponse(pdfBytes('missing'), 'application/pdf');
    await expect(extractContent('https://docs.example/missing.pdf', {}, { emit: vi.fn() }))
      .rejects.toThrow('Run /markitdown install to enable PDF support');

    for (const [message, expected] of [
      ['MarkItDown PDF conversion is disabled: PRIVATE_TOKEN', 'PDF conversion unavailable: MarkItDown is disabled or unavailable'],
      ['MarkItDown PDF conversion was cancelled: PRIVATE_TOKEN', 'PDF conversion was cancelled'],
      ['converter exploded: PRIVATE_TOKEN', 'PDF conversion failed'],
    ] as const) {
      mockResponse(pdfBytes(message), 'application/pdf');
      const conversion = extractContent(
        `https://docs.example/${encodeURIComponent(expected)}.pdf`,
        {},
        mockPdfFailure(message),
      );
      await expect(conversion).rejects.toThrow(expected);
      await expect(conversion).rejects.not.toThrow('PRIVATE_TOKEN');
    }

    mockResponse(pdfBytes('invalid result'), 'application/pdf');
    const invalidEvents = respondingPdfEvents(Promise.resolve({ markdown: 'text', converter: 'Other' }));
    await expect(extractContent('https://docs.example/invalid.pdf', {}, invalidEvents))
      .rejects.toThrow('PDF conversion failed');
  });

  it('rejects PDF signature and content-type mismatches', async () => {
    mockResponse('not a PDF', 'application/pdf');
    await expect(extractContent('https://docs.example/fake.pdf', {}))
      .rejects.toThrow('PDF content type does not match the file signature');

    mockResponse(pdfBytes('PDF bytes'), 'text/plain');
    await expect(extractContent('https://docs.example/report', {}))
      .rejects.toThrow('PDF file signature does not match content type: text/plain');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(pdfBytes('PDF bytes'))));
    await expect(extractContent('https://docs.example/report', {}))
      .rejects.toThrow('PDF file signature does not match content type: unknown');
  });

  it('cancels before PDF conversion when the caller signal is already aborted', async () => {
    mockResponse(pdfBytes('PDF bytes'), 'application/pdf');
    const events = mockPdfEvents('should not execute');
    await expect(extractContent('https://docs.example/report.pdf', {}, events, AbortSignal.abort()))
      .rejects.toThrow(/aborted|cancelled/iu);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rejects oversized declared and streamed PDF responses before conversion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pdfBytes('not retained'), {
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(1024 * 1024 + 1),
      },
    })));
    await expect(extractContent('https://docs.example/declared.pdf', { pdf: { maxSizeMB: 1 } }, mockPdfEvents('unused')))
      .rejects.toThrow('PDF exceeds the configured 1048576-byte limit');

    const chunk = new Uint8Array(700);
    chunk.set(new TextEncoder().encode('%PDF-1.7'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(new Uint8Array(700));
        controller.close();
      },
    }), { headers: { 'content-type': 'application/pdf' } })));
    await expect(extractContent('https://docs.example/streamed.pdf', { pdf: { maxSizeMB: 0.001 } }, mockPdfEvents('unused')))
      .rejects.toThrow('PDF exceeds the configured 1048-byte limit');
  });

  it('uses caller cancellation rather than the expired HTTP timeout after download', async () => {
    mockResponse(pdfBytes('stalled converter'), 'application/pdf');
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const events: PdfConversionEvents = {
      emit: vi.fn((_channel, value) => {
        const request = value as MarkitdownPdfConversionRequest;
        requestSignal = request.signal;
        if (request.claim()) request.respond(new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
        }));
      }),
    };

    const extraction = extractContent('https://docs.example/queued.pdf', {}, events, controller.signal, 20);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requestSignal).toBe(controller.signal);
    expect(requestSignal?.aborted).toBe(false);

    controller.abort(new Error('caller stopped'));
    await expect(extraction).rejects.toThrow('PDF conversion was cancelled');
  });

  it('formats JSON for matching', async () => {
    mockResponse('{"answer":42,"nested":{"ok":true}}', 'application/json');

    const result = await extractContent('https://docs.example/data.json', {});

    expect(result).toMatchObject({ title: 'data.json', error: null, contentType: 'application/json' });
    expect(result.content).toBe('{\n  "answer": 42,\n  "nested": {\n    "ok": true\n  }\n}');
  });
});

function mockResponse(body: BodyInit, contentType: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
    headers: { 'content-type': contentType },
  })));
}

function pdfBytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(`%PDF-1.7\n${text}`).buffer;
}

function responseWithUrl(body: BodyInit | null, init: ResponseInit, url: string): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function mockPdfEvents(markdown: string) {
  return respondingPdfEvents(Promise.resolve(markitdownResult(markdown)));
}

function mockPdfFailure(message: string): PdfConversionEvents {
  return {
    emit: vi.fn((_channel: string, value: unknown) => {
      const request = value as MarkitdownPdfConversionRequest;
      if (request.claim()) request.respond(Promise.reject(new Error(message)));
    }),
  };
}

function respondingPdfEvents(result: Promise<unknown>) {
  return {
    emit: vi.fn((_channel: string, value: unknown) => {
      const request = value as MarkitdownPdfConversionRequest;
      if (request.claim()) {
        request.respond(result as Parameters<MarkitdownPdfConversionRequest['respond']>[0]);
      }
    }),
  };
}

function deferredPdfConversion() {
  let resolve!: (value: ReturnType<typeof markitdownResult>) => void;
  const promise = new Promise<ReturnType<typeof markitdownResult>>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function markitdownResult(markdown: string) {
  return {
    markdown,
    converter: 'MarkItDown' as const,
    version: '1.0.0',
    cacheHit: false,
  };
}
