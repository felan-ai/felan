import { resizeImage, type AgentRuntime } from '@felan-ai/agent-core';

export const MAX_BROWSER_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_BROWSER_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;
export const MAX_BROWSER_IMAGE_DIMENSION = 2_000;

export interface BrowserImageDetails {
  readonly path: string;
  readonly delivered: boolean;
  readonly mimeType?: string;
  readonly originalWidth?: number;
  readonly originalHeight?: number;
  readonly width?: number;
  readonly height?: number;
  readonly wasResized?: boolean;
  readonly reason?: string;
}

export type BrowserImageReadResult = {
  readonly image: {
    readonly type: 'image';
    readonly data: string;
    readonly mimeType: string;
  };
  readonly details: BrowserImageDetails;
} | {
  readonly details: BrowserImageDetails;
};

export async function readBrowserImage(
  runtime: AgentRuntime,
  path: string,
  supportsImageInput: boolean,
): Promise<BrowserImageReadResult> {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return { details: { path, delivered: false, reason: 'empty screenshot path' } };
  }
  if (!supportsImageInput) {
    return {
      details: {
        path: normalizedPath,
        delivered: false,
        reason: 'selected model does not support image input',
      },
    };
  }

  let data: Uint8Array;
  try {
    data = await runtime.readFile(normalizedPath, { maxBytes: MAX_BROWSER_IMAGE_INPUT_BYTES });
  } catch (error) {
    return {
      details: {
        path: normalizedPath,
        delivered: false,
        reason: `screenshot could not be read: ${diagnostic(error)}`,
      },
    };
  }

  const mimeType = detectImageMimeType(data);
  if (!mimeType) {
    return {
      details: {
        path: normalizedPath,
        delivered: false,
        reason: 'screenshot is not a supported PNG, JPEG, GIF, or WebP image',
      },
    };
  }

  let resized: Awaited<ReturnType<typeof resizeImage>>;
  try {
    resized = await resizeImage(data, mimeType, {
      maxWidth: MAX_BROWSER_IMAGE_DIMENSION,
      maxHeight: MAX_BROWSER_IMAGE_DIMENSION,
      maxBytes: MAX_BROWSER_IMAGE_BASE64_BYTES,
    });
  } catch (error) {
    return {
      details: {
        path: normalizedPath,
        delivered: false,
        mimeType,
        reason: `screenshot could not be resized: ${diagnostic(error)}`,
      },
    };
  }
  if (!resized) {
    return {
      details: {
        path: normalizedPath,
        delivered: false,
        mimeType,
        reason: 'screenshot could not be decoded or resized within Felan image limits',
      },
    };
  }

  return {
    image: { type: 'image', data: resized.data, mimeType: resized.mimeType },
    details: {
      path: normalizedPath,
      delivered: true,
      mimeType: resized.mimeType,
      originalWidth: resized.originalWidth,
      originalHeight: resized.originalHeight,
      width: resized.width,
      height: resized.height,
      wasResized: resized.wasResized,
    },
  };
}

export function detectImageMimeType(data: Uint8Array): string | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const header = new TextDecoder().decode(data.subarray(0, 12));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte);
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300);
}
