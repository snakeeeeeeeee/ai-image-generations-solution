import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const DATA_URL_PREFIX = /^data:[^;]+;base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIGNATURE = '89504e470d0a1a0a';

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

export function applyImageDefaults(body: unknown, defaults: ImageDefaults): ImageRequestBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be a JSON object', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_request_body'
    });
  }

  const requestBody = body as ImageRequestBody;
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

export function buildImageKey(prefix: string, now = new Date(), id: string = randomUUID()): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${prefix}/${year}/${month}/${day}/${id}.png`;
}
