import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { createR2Client, uploadImageToR2 } from './r2.js';

export type UploadImageToR2 = typeof uploadImageToR2;

export interface UploadLogger {
  warn: (obj: unknown, msg: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(config: AppConfig, retryIndex: number): number {
  const delay = config.upload.retryBaseDelayMs * 2 ** retryIndex;
  return Math.min(config.upload.retryMaxDelayMs, delay);
}

function getObjectField(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function r2ErrorDetails(error: unknown): Record<string, unknown> {
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
    code: getObjectField(error, 'Code'),
    http_status: getObjectField(getObjectField(error, '$metadata'), 'httpStatusCode')
  };
}

export async function uploadWithRetry({
  upload,
  request,
  logger,
  requestId,
  r2Client,
  config,
  key,
  buffer,
  contentType
}: {
  upload: UploadImageToR2;
  request?: FastifyRequest;
  logger?: UploadLogger;
  requestId?: string;
  r2Client: ReturnType<typeof createR2Client>;
  config: AppConfig;
  key: string;
  buffer: Buffer;
  contentType: string;
}): Promise<string> {
  let lastError: unknown;
  const maxAttempts = config.upload.maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await upload({
        client: r2Client,
        config: config.r2,
        key,
        buffer,
        contentType
      });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }

      const delayMs = retryDelayMs(config, attempt - 1);
      const log = request?.log ?? logger;
      log?.warn({
        request_id: request?.id ?? requestId,
        attempt,
        next_attempt: attempt + 1,
        max_attempts: maxAttempts,
        retry_delay_ms: delayMs,
        r2: r2ErrorDetails(error)
      }, 'r2 upload attempt failed, retrying');
      await sleep(delayMs);
    }
  }

  throw lastError;
}
