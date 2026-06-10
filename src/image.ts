import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const DATA_URL_PREFIX = /^data:[^;]+;base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIGNATURE = '89504e470d0a1a0a';

export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type ImageExtension = 'png' | 'jpg' | 'webp';

export interface ImageRequestBody {
  model?: string;
  prompt?: string;
  size?: string;
  quality?: string;
  output_format?: string;
  [key: string]: unknown;
}

export interface ImageDefaults {
  size: string;
  outputFormat: 'png';
}

export interface PngMetadata {
  format: 'png';
  width: number;
  height: number;
}

export interface ImageMetadata {
  format: ImageFormat;
  extension: ImageExtension;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}

export function normalizeImageRequestBody(body: unknown): ImageRequestBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be a JSON object', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_request_body'
    });
  }

  return body as ImageRequestBody;
}

export function applyImageDefaults(body: unknown, defaults: ImageDefaults): ImageRequestBody {
  const requestBody = normalizeImageRequestBody(body);
  return {
    ...requestBody,
    size: requestBody.size || defaults.size,
    output_format: defaults.outputFormat
  };
}

export function decodeBase64Image(value: unknown): Buffer {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('Image b64_json is empty', {
      statusCode: 502,
      type: 'server_error',
      code: 'empty_image'
    });
  }

  const cleaned = value.trim().replace(DATA_URL_PREFIX, '').replace(/\s+/g, '');
  if (cleaned.length === 0 || cleaned.length % 4 === 1 || !BASE64_RE.test(cleaned)) {
    throw new AppError('Invalid image base64 returned by upstream', {
      statusCode: 502,
      type: 'server_error',
      code: 'invalid_base64'
    });
  }

  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) {
    throw new AppError('Decoded image is empty', {
      statusCode: 502,
      type: 'server_error',
      code: 'empty_image'
    });
  }

  return buffer;
}

export function assertPng(buffer: Buffer): void {
  readPngMetadata(buffer);
}

function assertPngSignature(buffer: Buffer): void {
  if (buffer.length < 8) {
    throw new AppError('Decoded image is empty', {
      statusCode: 502,
      type: 'server_error',
      code: 'empty_image'
    });
  }

  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== PNG_SIGNATURE) {
    throw new AppError('Upstream did not return a PNG image', {
      statusCode: 502,
      type: 'server_error',
      code: 'unexpected_image_format'
    });
  }
}

export function readPngMetadata(buffer: Buffer): PngMetadata {
  assertPngSignature(buffer);
  if (buffer.length < 24) {
    throw new AppError('Decoded image is empty', {
      statusCode: 502,
      type: 'server_error',
      code: 'empty_image'
    });
  }

  return {
    format: 'png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function readJpegMetadata(buffer: Buffer): Omit<ImageMetadata, 'bytes'> | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= buffer.length) {
      break;
    }

    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (offset + 2 > buffer.length) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        format: 'jpeg',
        extension: 'jpg',
        mimeType: 'image/jpeg',
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }

    offset += segmentLength;
  }

  throw new AppError('Unable to read JPEG image dimensions', {
    statusCode: 502,
    type: 'server_error',
    code: 'invalid_image_metadata'
  });
}

function readUint24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function readWebpMetadata(buffer: Buffer): Omit<ImageMetadata, 'bytes'> | undefined {
  if (
    buffer.length < 20 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return undefined;
  }

  const chunkType = buffer.toString('ascii', 12, 16);
  if (chunkType === 'VP8X') {
    if (buffer.length < 30) {
      throw new AppError('Unable to read WebP image dimensions', {
        statusCode: 502,
        type: 'server_error',
        code: 'invalid_image_metadata'
      });
    }
    return {
      format: 'webp',
      extension: 'webp',
      mimeType: 'image/webp',
      width: readUint24LE(buffer, 24) + 1,
      height: readUint24LE(buffer, 27) + 1
    };
  }

  if (chunkType === 'VP8L') {
    if (buffer.length < 25 || buffer[20] !== 0x2f) {
      throw new AppError('Unable to read WebP image dimensions', {
        statusCode: 502,
        type: 'server_error',
        code: 'invalid_image_metadata'
      });
    }
    const bits = buffer.readUInt32LE(21);
    return {
      format: 'webp',
      extension: 'webp',
      mimeType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  if (chunkType === 'VP8 ') {
    if (
      buffer.length < 30 ||
      buffer[23] !== 0x9d ||
      buffer[24] !== 0x01 ||
      buffer[25] !== 0x2a
    ) {
      throw new AppError('Unable to read WebP image dimensions', {
        statusCode: 502,
        type: 'server_error',
        code: 'invalid_image_metadata'
      });
    }
    return {
      format: 'webp',
      extension: 'webp',
      mimeType: 'image/webp',
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }

  throw new AppError('Unable to read WebP image dimensions', {
    statusCode: 502,
    type: 'server_error',
    code: 'invalid_image_metadata'
  });
}

export function readImageMetadata(buffer: Buffer): ImageMetadata {
  try {
    const png = readPngMetadata(buffer);
    return {
      ...png,
      extension: 'png',
      mimeType: 'image/png',
      bytes: buffer.length
    };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'unexpected_image_format') {
      throw error;
    }
  }

  const jpeg = readJpegMetadata(buffer);
  if (jpeg) {
    return {
      ...jpeg,
      bytes: buffer.length
    };
  }

  const webp = readWebpMetadata(buffer);
  if (webp) {
    return {
      ...webp,
      bytes: buffer.length
    };
  }

  throw new AppError('Upstream returned unsupported image format', {
    statusCode: 502,
    type: 'server_error',
    code: 'unsupported_image_format'
  });
}

export function buildImageKey(
  prefix: string,
  now = new Date(),
  id: string = randomUUID(),
  extension: ImageExtension = 'png'
): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${prefix}/${year}/${month}/${day}/${id}.${extension}`;
}
