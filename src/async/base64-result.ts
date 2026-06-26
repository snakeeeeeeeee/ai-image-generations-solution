import { Buffer } from 'node:buffer';
import type { Redis } from 'ioredis';
import { AppError } from '../errors.js';
import type { Base64TaskResultPayload } from './types.js';

export const BASE64_RESULT_MAX_BYTES = 100 * 1024 * 1024;
const BASE64_RESULT_TTL_SECONDS = 10 * 60;

function keyForTask(providerTaskId: string): string {
  return `image-task:base64-result:${providerTaskId}`;
}

export function extractBase64TaskResult(
  upstreamResponse: unknown,
  maxBytes = BASE64_RESULT_MAX_BYTES
): Base64TaskResultPayload {
  const response = safeObject(upstreamResponse);
  const data = Array.isArray(response.data) ? response.data : [];
  const images = data.map((item) => {
    const record = safeObject(item);
    const b64Json = getString(record.b64_json);
    if (!b64Json) {
      throw new AppError('Upstream response did not include b64_json for base64 result', {
        statusCode: 502,
        type: 'server_error',
        code: 'missing_base64_result',
        cause: {
          retryable: false
        }
      });
    }
    return {
      b64_json: b64Json,
      mime_type: getString(record.mime_type) ?? getString(record.mimeType)
    };
  });

  if (images.length === 0) {
    throw new AppError('Upstream response did not include image data for base64 result', {
      statusCode: 502,
      type: 'server_error',
      code: 'empty_base64_result',
      cause: {
        retryable: false
      }
    });
  }

  assertBase64ResultSize(images, maxBytes);
  return { images };
}

export async function writeBase64TaskResult(
  redis: Redis | undefined,
  providerTaskId: string,
  result: Base64TaskResultPayload
): Promise<void> {
  if (!redis) {
    throw new AppError('Redis connection is required for base64 sync task result', {
      statusCode: 500,
      type: 'server_error',
      code: 'missing_base64_result_store',
      cause: {
        retryable: false
      }
    });
  }

  await redis.set(
    keyForTask(providerTaskId),
    JSON.stringify({
      result_data_format: 'base64',
      result
    }),
    'EX',
    BASE64_RESULT_TTL_SECONDS
  );
}

export async function readBase64TaskResult(redis: Redis, providerTaskId: string): Promise<Base64TaskResultPayload | undefined> {
  const raw = await redis.get(keyForTask(providerTaskId));
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AppError('Cached base64 result is invalid', {
      statusCode: 500,
      type: 'server_error',
      code: 'invalid_base64_result_cache',
      cause: error
    });
  }

  const result = safeObject(safeObject(parsed).result);
  const images: Base64TaskResultPayload['images'] = [];
  if (Array.isArray(result.images)) {
    for (const item of result.images) {
      const record = safeObject(item);
      const b64Json = getString(record.b64_json);
      if (!b64Json) {
        continue;
      }
      images.push({
        b64_json: b64Json,
        mime_type: getString(record.mime_type)
      });
    }
  }

  if (images.length === 0) {
    return undefined;
  }
  return { images };
}

export function isBase64ResultRequested(task: { metadata?: Record<string, unknown> }): boolean {
  return task.metadata?.result_data_format === 'base64';
}

function assertBase64ResultSize(images: Array<{ b64_json: string }>, maxBytes: number): void {
  const totalBytes = images.reduce((sum, image) => sum + Buffer.byteLength(image.b64_json, 'utf8'), 0);
  if (totalBytes > maxBytes) {
    throw new AppError('Base64 result exceeds 100MB limit', {
      statusCode: 502,
      type: 'server_error',
      code: 'base64_result_too_large',
      cause: {
        retryable: false,
        bytes: totalBytes,
        limit_bytes: maxBytes
      }
    });
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
