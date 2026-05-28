import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { performance } from 'node:perf_hooks';
import type { AppConfig } from './config.js';
import { AppError, openAIError, sendAppError } from './errors.js';
import { applyImageDefaults, assertPng, buildImageKey, decodeBase64Image, type ImageRequestBody } from './image.js';
import { ActiveRequestLimiter } from './limiter.js';
import { createR2Client, uploadPngToR2 } from './r2.js';

interface UpstreamImageItem {
  b64_json?: string;
  [key: string]: unknown;
}

interface UpstreamImageResponse {
  created?: number;
  data?: UpstreamImageItem[];
  [key: string]: unknown;
}

interface Timings {
  openai_ms: number;
  decode_ms: number;
  upload_ms: number;
}

type UploadPngToR2 = typeof uploadPngToR2;

interface MemorySnapshot {
  rss_bytes: number;
  heap_used_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  max_rss_bytes: number;
}

interface UpstreamFetchResult {
  response: Response;
  stopTimeout: () => void;
}

interface ServerDeps {
  uploadPngToR2?: UploadPngToR2;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function upstreamTimeoutError(error: unknown): AppError {
  return new AppError('new-api image generation timed out', {
    statusCode: 504,
    type: 'server_error',
    code: 'upstream_timeout',
    cause: error
  });
}

function getMemorySnapshot(config: AppConfig): MemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rss_bytes: memory.rss,
    heap_used_bytes: memory.heapUsed,
    external_bytes: memory.external,
    array_buffers_bytes: memory.arrayBuffers,
    max_rss_bytes: config.limits.maxProcessRssBytes
  };
}

function assertMemoryAvailable(config: AppConfig): void {
  const memory = getMemorySnapshot(config);
  if (memory.rss_bytes < config.limits.maxProcessRssBytes) {
    return;
  }

  throw new AppError('Server memory limit exceeded, try again later', {
    statusCode: 503,
    type: 'server_error',
    code: 'server_memory_limit_exceeded',
    cause: memory
  });
}

function upstreamUrl(config: AppConfig): string {
  return `${config.upstream.baseUrl}${config.upstream.imagesPath}`;
}

function msSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

async function readUpstreamBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text } };
  }
}

async function parseUpstreamResponse(response: Response): Promise<UpstreamImageResponse> {
  let responseBody: unknown;
  try {
    responseBody = await readUpstreamBody(response);
  } catch (error) {
    if (isAbortError(error)) {
      throw upstreamTimeoutError(error);
    }
    throw error;
  }
  if (!response.ok) {
    throw new AppError('new-api returned an error', {
      statusCode: response.status,
      type: 'upstream_error',
      code: 'new_api_error',
      cause: responseBody
    });
  }

  return responseBody as UpstreamImageResponse;
}

function copyForwardHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };

  if (request.headers.authorization) {
    headers.authorization = request.headers.authorization;
  }

  return headers;
}

async function fetchUpstream({
  config,
  request,
  body
}: {
  config: AppConfig;
  request: FastifyRequest;
  body: ImageRequestBody;
}): Promise<UpstreamFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstream.timeoutMs);

  try {
    const response = await fetch(upstreamUrl(config), {
      method: 'POST',
      headers: copyForwardHeaders(request),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    return {
      response,
      stopTimeout: () => clearTimeout(timeout)
    };
  } catch (error) {
    clearTimeout(timeout);
    if (isAbortError(error)) {
      throw upstreamTimeoutError(error);
    }
    throw error;
  }
}

function sendUpstreamError(reply: FastifyReply, error: unknown): FastifyReply | false {
  if (!(error instanceof AppError) || error.code !== 'new_api_error') {
    return false;
  }

  const upstreamBody = error.cause;
  if (upstreamBody && typeof upstreamBody === 'object') {
    return reply.status(error.statusCode).send(upstreamBody);
  }

  return reply.status(error.statusCode).send(openAIError(error.message, error.type, error.code));
}

export function buildServer(config: AppConfig, deps: ServerDeps = {}): FastifyInstance {
  const r2Client = createR2Client(config.r2);
  const upload = deps.uploadPngToR2 ?? uploadPngToR2;
  const generationLimiter = new ActiveRequestLimiter(config.limits.maxConcurrentGenerations);
  const imageProcessingLimiter = new ActiveRequestLimiter(config.limits.maxConcurrentImageProcessing);
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization']
    },
    bodyLimit: config.bodyLimitBytes,
    requestIdHeader: 'x-request-id'
  });

  app.get('/healthz', async () => ({
    ok: true,
    active_generations: generationLimiter.active,
    queued_generations: generationLimiter.queued,
    max_concurrent_generations: generationLimiter.max,
    active_image_processing: imageProcessingLimiter.active,
    queued_image_processing: imageProcessingLimiter.queued,
    max_concurrent_image_processing: imageProcessingLimiter.max,
    memory: getMemorySnapshot(config)
  }));

  app.post('/v1/images/generations', async (request, reply) => {
    const totalStartedAt = performance.now();
    let releaseGenerationSlot: (() => void) | undefined;
    let releaseImageProcessingSlot: (() => void) | undefined;
    let stopUpstreamTimeout: (() => void) | undefined;
    const timings: Timings = {
      openai_ms: 0,
      decode_ms: 0,
      upload_ms: 0
    };

    try {
      if (!request.headers.authorization) {
        throw new AppError('Missing Authorization header', {
          statusCode: 401,
          type: 'invalid_request_error',
          code: 'missing_authorization'
        });
      }

      const upstreamBody = applyImageDefaults(request.body, config.defaults);
      assertMemoryAvailable(config);
      releaseGenerationSlot = generationLimiter.tryAcquire() ?? undefined;
      if (!releaseGenerationSlot) {
        throw new AppError('Too many image generation requests in progress', {
          statusCode: 429,
          type: 'server_error',
          code: 'too_many_generation_requests'
        });
      }

      const upstreamStartedAt = performance.now();
      const upstreamFetch = await fetchUpstream({ config, request, body: upstreamBody });
      stopUpstreamTimeout = upstreamFetch.stopTimeout;

      releaseImageProcessingSlot = await imageProcessingLimiter.acquire();
      assertMemoryAvailable(config);
      const upstreamResponse = await parseUpstreamResponse(upstreamFetch.response);
      timings.openai_ms = msSince(upstreamStartedAt);
      stopUpstreamTimeout();
      stopUpstreamTimeout = undefined;

      const outputData: Array<{ url: string }> = [];
      let totalImageBytes = 0;
      const data = Array.isArray(upstreamResponse.data) ? upstreamResponse.data : [];
      if (data.length === 0) {
        throw new AppError('new-api returned no image data', {
          statusCode: 502,
          type: 'server_error',
          code: 'empty_upstream_data'
        });
      }

      for (const item of data) {
        if (!item.b64_json) {
          throw new AppError('new-api returned image data without b64_json', {
            statusCode: 502,
            type: 'server_error',
            code: 'missing_b64_json'
          });
        }

        const decodeStartedAt = performance.now();
        const buffer = decodeBase64Image(item.b64_json);
        assertPng(buffer);
        timings.decode_ms += msSince(decodeStartedAt);
        totalImageBytes += buffer.length;

        const key = buildImageKey(config.r2.keyPrefix);
        const uploadStartedAt = performance.now();
        let url: string;
        try {
          url = await upload({
            client: r2Client,
            config: config.r2,
            key,
            buffer
          });
        } catch (uploadError) {
          timings.upload_ms += msSince(uploadStartedAt);
          request.log.error({
            request_id: request.id,
            r2: r2ErrorDetails(uploadError)
          }, 'r2 upload failed');

          throw new AppError('R2 upload failed', {
            statusCode: 502,
            type: 'server_error',
            code: 'r2_upload_failed'
          });
        }
        timings.upload_ms += msSince(uploadStartedAt);

        outputData.push({ url });
      }

      const totalMs = msSince(totalStartedAt);
      request.log.info({
        request_id: request.id,
        active_generations: generationLimiter.active,
        queued_generations: generationLimiter.queued,
        max_concurrent_generations: generationLimiter.max,
        active_image_processing: imageProcessingLimiter.active,
        queued_image_processing: imageProcessingLimiter.queued,
        max_concurrent_image_processing: imageProcessingLimiter.max,
        memory: getMemorySnapshot(config),
        openai_ms: timings.openai_ms,
        decode_ms: timings.decode_ms,
        upload_ms: timings.upload_ms,
        total_ms: totalMs,
        image_bytes: totalImageBytes,
        image_count: outputData.length
      }, 'image generation wrapped');

      return reply.send({
        created: upstreamResponse.created || Math.floor(Date.now() / 1000),
        data: outputData
      });
    } catch (error) {
      request.log.error({
        request_id: request.id,
        err: error,
        active_generations: generationLimiter.active,
        queued_generations: generationLimiter.queued,
        max_concurrent_generations: generationLimiter.max,
        active_image_processing: imageProcessingLimiter.active,
        queued_image_processing: imageProcessingLimiter.queued,
        max_concurrent_image_processing: imageProcessingLimiter.max,
        memory: getMemorySnapshot(config),
        openai_ms: timings.openai_ms,
        decode_ms: timings.decode_ms,
        upload_ms: timings.upload_ms,
        total_ms: msSince(totalStartedAt)
      }, 'image generation failed');

      const upstreamReply = sendUpstreamError(reply, error);
      if (upstreamReply) {
        return upstreamReply;
      }

      return sendAppError(reply, error);
    } finally {
      stopUpstreamTimeout?.();
      releaseImageProcessingSlot?.();
      releaseGenerationSlot?.();
    }
  });

  return app;
}
