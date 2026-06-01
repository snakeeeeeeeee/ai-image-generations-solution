import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { performance } from 'node:perf_hooks';
import { registerAdminRoutes } from './admin/routes.js';
import { AdminStore } from './admin/store.js';
import type { AdminRuntimeStats, ImageRequestRecord } from './admin/types.js';
import type { AppConfig } from './config.js';
import { AppError, openAIError, sendAppError } from './errors.js';
import { applyImageDefaults, buildImageKey, decodeBase64Image, readPngMetadata, type ImageRequestBody } from './image.js';
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

interface UpstreamErrorInfo {
  statusCode?: number;
  code: string;
  message?: string;
}

interface Timings {
  openai_ms: number;
  decode_ms: number;
  upload_ms: number;
}

type UploadPngToR2 = typeof uploadPngToR2;
type ImageOperation = 'generation' | 'edit';

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

interface CorsConfig {
  allowedOrigins: string[];
  maxAgeSeconds: number;
}

interface UpstreamRequestPayload {
  body: string | FormData;
  headers: Record<string, string>;
  metadata: {
    model?: string;
    size?: string;
  };
  requestParams: Record<string, unknown>;
}

interface ServerDeps {
  uploadPngToR2?: UploadPngToR2;
  adminStore?: AdminStore;
}

function runtimeStats(
  config: AppConfig,
  generationLimiter: ActiveRequestLimiter,
  imageProcessingLimiter: ActiveRequestLimiter,
  adminStore: AdminStore
): AdminRuntimeStats {
  const memory = getMemorySnapshot(config);
  const drainState = adminStore.getDrainState();
  const activeWork =
    generationLimiter.active +
    generationLimiter.queued +
    imageProcessingLimiter.active +
    imageProcessingLimiter.queued;
  return {
    draining: drainState.draining,
    safeToRestart: drainState.draining && activeWork === 0,
    activeGenerations: generationLimiter.active,
    queuedGenerations: generationLimiter.queued,
    maxConcurrentGenerations: generationLimiter.max,
    activeImageProcessing: imageProcessingLimiter.active,
    queuedImageProcessing: imageProcessingLimiter.queued,
    maxConcurrentImageProcessing: imageProcessingLimiter.max,
    memory: {
      rssBytes: memory.rss_bytes,
      heapUsedBytes: memory.heap_used_bytes,
      externalBytes: memory.external_bytes,
      arrayBuffersBytes: memory.array_buffers_bytes,
      maxRssBytes: memory.max_rss_bytes
    }
  };
}

function getAppErrorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'internal_error';
}

function getAppErrorStatus(error: unknown): number {
  return error instanceof AppError ? error.statusCode : 500;
}

function getRequestMetadata(body: ImageRequestBody | undefined): { model?: string; size?: string } {
  return {
    model: typeof body?.model === 'string' ? body.model : undefined,
    size: typeof body?.size === 'string' ? body.size : undefined
  };
}

function addParamIfPresent(params: Record<string, unknown>, key: string, value: unknown): void {
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    params[key] = value;
  }
}

function buildRequestParamsFromBody(body: ImageRequestBody): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of ['model', 'n', 'size', 'quality', 'output_format', 'output_compression']) {
    addParamIfPresent(params, key, body[key]);
  }
  return params;
}

function buildRequestParamsFromFields(fields: Map<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of ['model', 'n', 'size', 'quality', 'output_format', 'output_compression']) {
    addParamIfPresent(params, key, fields.get(key));
  }
  return params;
}

function addResponseParam(params: Record<string, unknown>, key: string, value: unknown): void {
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    params[key] = value;
  }
}

function buildResponseParams(
  upstreamResponse: UpstreamImageResponse,
  outputImages: Array<{ width: number; height: number; bytes: number; format: string }>
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  addResponseParam(params, 'created', upstreamResponse.created);

  const firstImage = outputImages[0];
  if (firstImage) {
    params.format = firstImage.format;
    params.width = firstImage.width;
    params.height = firstImage.height;
    params.size = `${firstImage.width}x${firstImage.height}`;
    params.bytes = firstImage.bytes;
  }
  if (outputImages.length > 0) {
    params.count = outputImages.length;
  }

  return params;
}

function getFieldMetadata(fields: Map<string, string>): { model?: string; size?: string } {
  return {
    model: fields.get('model'),
    size: fields.get('size')
  };
}

function getObjectField(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function getStringField(value: unknown, key: string): string | undefined {
  const field = getObjectField(value, key);
  return typeof field === 'string' && field.trim() !== '' ? field : undefined;
}

function getNumberField(value: unknown, key: string): number | undefined {
  const field = getObjectField(value, key);
  if (typeof field === 'number' && Number.isInteger(field) && field >= 100 && field <= 599) {
    return field;
  }

  if (typeof field === 'string') {
    const parsed = Number.parseInt(field, 10);
    return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
  }

  return undefined;
}

function getUpstreamErrorInfo(error: unknown): UpstreamErrorInfo | undefined {
  if (!(error instanceof AppError) || error.code !== 'new_api_error') {
    return undefined;
  }

  const body = error.cause;
  const nestedError = getObjectField(body, 'error');
  const source = nestedError && typeof nestedError === 'object' ? nestedError : body;
  const statusCode =
    getNumberField(source, 'status_code') ??
    getNumberField(source, 'statusCode') ??
    getNumberField(body, 'status_code') ??
    getNumberField(body, 'statusCode') ??
    error.statusCode;
  const code =
    getStringField(source, 'code') ??
    getStringField(source, 'type') ??
    getStringField(body, 'code') ??
    'new_api_error';
  const message =
    getStringField(source, 'message') ??
    getStringField(body, 'message') ??
    (typeof body === 'string' ? body : undefined);

  return {
    statusCode,
    code,
    message
  };
}

function getAdminStatusCode(error: unknown): number {
  return getUpstreamErrorInfo(error)?.statusCode ?? getAppErrorStatus(error);
}

function getAdminErrorCode(error: unknown): string {
  return getUpstreamErrorInfo(error)?.code ?? getAppErrorCode(error);
}

function getAdminErrorMessage(error: unknown): string | undefined {
  if (error instanceof AppError) {
    return getUpstreamErrorInfo(error)?.message ?? error.message;
  }

  return error instanceof Error ? error.message : String(error);
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

function isImageApiPath(pathname: string): boolean {
  return pathname === '/v1/images/generations' || pathname === '/v1/images/edits';
}

function getAllowedCorsOrigin(config: CorsConfig, origin: string | undefined): string | undefined {
  if (!origin) {
    return undefined;
  }

  if (config.allowedOrigins.includes('*')) {
    return '*';
  }

  return config.allowedOrigins.includes(origin) ? origin : undefined;
}

function applyCorsHeaders(reply: FastifyReply, config: CorsConfig, origin: string | undefined): void {
  const allowedOrigin = getAllowedCorsOrigin(config, origin);
  if (!allowedOrigin) {
    return;
  }

  reply.header('Access-Control-Allow-Origin', allowedOrigin);
  reply.header('Vary', 'Origin');
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

function upstreamUrl(config: AppConfig, operation: ImageOperation): string {
  const path = operation === 'generation' ? config.upstream.imagesPath : config.upstream.imageEditsPath;
  return `${config.upstream.baseUrl}${path}`;
}

function msSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(config: AppConfig, retryIndex: number): number {
  const delay = config.upload.retryBaseDelayMs * 2 ** retryIndex;
  return Math.min(config.upload.retryMaxDelayMs, delay);
}

function formatBeijingTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000 + 8 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    '-',
    pad(date.getUTCMonth() + 1),
    '-',
    pad(date.getUTCDate()),
    ' ',
    pad(date.getUTCHours()),
    ':',
    pad(date.getUTCMinutes()),
    ':',
    pad(date.getUTCSeconds())
  ].join('');
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

function copyForwardHeaders(request: FastifyRequest, extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };

  if (request.headers.authorization) {
    headers.authorization = request.headers.authorization;
  }

  return headers;
}

async function fetchUpstream({
  config,
  request,
  operation,
  payload
}: {
  config: AppConfig;
  request: FastifyRequest;
  operation: ImageOperation;
  payload: UpstreamRequestPayload;
}): Promise<UpstreamFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstream.timeoutMs);

  try {
    const response = await fetch(upstreamUrl(config, operation), {
      method: 'POST',
      headers: copyForwardHeaders(request, payload.headers),
      body: payload.body,
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

async function buildJsonUpstreamPayload(
  request: FastifyRequest,
  config: AppConfig
): Promise<UpstreamRequestPayload> {
  const body = applyImageDefaults(request.body, config.defaults);
  return {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json'
    },
    metadata: getRequestMetadata(body),
    requestParams: buildRequestParamsFromBody(body)
  };
}

async function buildMultipartUpstreamPayload(
  request: FastifyRequest,
  config: AppConfig
): Promise<UpstreamRequestPayload> {
  const form = new FormData();
  const fields = new Map<string, string>();

  if (!request.isMultipart()) {
    throw new AppError('Request body must be JSON or multipart/form-data', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_request_body'
    });
  }

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (buffer.length === 0) {
        throw new AppError('Uploaded image file is empty', {
          statusCode: 400,
          type: 'invalid_request_error',
          code: 'empty_upload_file'
        });
      }

      form.append(
        part.fieldname,
        new Blob([buffer], { type: part.mimetype || 'application/octet-stream' }),
        part.filename || 'image.png'
      );
      continue;
    }

    const value = typeof part.value === 'string' ? part.value : String(part.value ?? '');
    fields.set(part.fieldname, value);
    form.append(part.fieldname, value);
  }

  if (!fields.has('size')) {
    form.append('size', config.defaults.size);
    fields.set('size', config.defaults.size);
  }
  form.set('output_format', config.defaults.outputFormat);
  fields.set('output_format', config.defaults.outputFormat);

  return {
    body: form,
    headers: {},
    metadata: getFieldMetadata(fields),
    requestParams: buildRequestParamsFromFields(fields)
  };
}

async function buildUpstreamPayload({
  request,
  config,
  operation
}: {
  request: FastifyRequest;
  config: AppConfig;
  operation: ImageOperation;
}): Promise<UpstreamRequestPayload> {
  if (operation === 'generation' || !request.isMultipart()) {
    return buildJsonUpstreamPayload(request, config);
  }

  return buildMultipartUpstreamPayload(request, config);
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

async function uploadWithRetry({
  upload,
  request,
  r2Client,
  config,
  key,
  buffer
}: {
  upload: UploadPngToR2;
  request: FastifyRequest;
  r2Client: ReturnType<typeof createR2Client>;
  config: AppConfig;
  key: string;
  buffer: Buffer;
}): Promise<string> {
  let lastError: unknown;
  const maxAttempts = config.upload.maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await upload({
        client: r2Client,
        config: config.r2,
        key,
        buffer
      });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }

      const delayMs = retryDelayMs(config, attempt - 1);
      request.log.warn({
        request_id: request.id,
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

export function buildServer(config: AppConfig, deps: ServerDeps = {}): FastifyInstance {
  const r2Client = createR2Client(config.r2);
  const upload = deps.uploadPngToR2 ?? uploadPngToR2;
  const adminStore = deps.adminStore ?? new AdminStore(config.admin.dbPath);
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
  app.register(multipart, {
    limits: {
      fileSize: config.bodyLimitBytes,
      files: 20,
      parts: 100
    }
  });
  const cleanupInterval = setInterval(() => {
    try {
      adminStore.cleanup(config.admin.retentionDays);
    } catch (error) {
      app.log.error({ err: error }, 'admin metrics cleanup failed');
    }
  }, 60 * 60 * 1000);
  cleanupInterval.unref();

  app.addHook('onClose', async () => {
    clearInterval(cleanupInterval);
    adminStore.close();
  });

  app.addHook('onRequest', async (request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!isImageApiPath(pathname)) {
      return;
    }

    applyCorsHeaders(reply, config.cors, request.headers.origin);
  });

  async function handleCorsPreflight(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const origin = request.headers.origin;
    const allowedOrigin = getAllowedCorsOrigin(config.cors, origin);
    if (!allowedOrigin) {
      return reply.status(403).send();
    }

    reply.header('Access-Control-Allow-Origin', allowedOrigin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      request.headers['access-control-request-headers'] ?? 'Authorization, Content-Type, X-Request-ID'
    );
    reply.header('Access-Control-Max-Age', String(config.cors.maxAgeSeconds));
    return reply.status(204).send();
  }

  app.options('/v1/images/generations', handleCorsPreflight);
  app.options('/v1/images/edits', handleCorsPreflight);

  registerAdminRoutes(app, {
    config: config.admin,
    store: adminStore,
    getRuntimeStats: () => runtimeStats(config, generationLimiter, imageProcessingLimiter, adminStore)
  });

  app.get('/healthz', async () => ({
    ok: true,
    draining: adminStore.getDrainState().draining,
    active_generations: generationLimiter.active,
    queued_generations: generationLimiter.queued,
    max_concurrent_generations: generationLimiter.max,
    active_image_processing: imageProcessingLimiter.active,
    queued_image_processing: imageProcessingLimiter.queued,
    max_concurrent_image_processing: imageProcessingLimiter.max,
    memory: getMemorySnapshot(config)
  }));

  async function handleImageOperation(
    operation: ImageOperation,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const totalStartedAt = performance.now();
    let releaseGenerationSlot: (() => void) | undefined;
    let releaseImageProcessingSlot: (() => void) | undefined;
    let stopUpstreamTimeout: (() => void) | undefined;
    let metadata: { model?: string; size?: string } = {};
    let requestParams: Record<string, unknown> = {};
    let responseParams: Record<string, unknown> = {};
    let totalImageBytes = 0;
    let imageCount = 0;
    let imageUrls: string[] = [];
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

      if (adminStore.getDrainState().draining) {
        reply.header('Retry-After', '120');
        throw new AppError('Service is draining for maintenance, retry later', {
          statusCode: 503,
          type: 'server_error',
          code: 'service_draining'
        });
      }

      assertMemoryAvailable(config);
      releaseGenerationSlot = generationLimiter.tryAcquire() ?? undefined;
      if (!releaseGenerationSlot) {
        throw new AppError('Too many image generation requests in progress', {
          statusCode: 429,
          type: 'server_error',
          code: 'too_many_generation_requests'
        });
      }

      const upstreamPayload = await buildUpstreamPayload({ request, config, operation });
      metadata = upstreamPayload.metadata;
      requestParams = upstreamPayload.requestParams;
      assertMemoryAvailable(config);

      const upstreamStartedAt = performance.now();
      const upstreamFetch = await fetchUpstream({
        config,
        request,
        operation,
        payload: upstreamPayload
      });
      stopUpstreamTimeout = upstreamFetch.stopTimeout;

      releaseImageProcessingSlot = await imageProcessingLimiter.acquire();
      assertMemoryAvailable(config);
      const upstreamResponse = await parseUpstreamResponse(upstreamFetch.response);
      timings.openai_ms = msSince(upstreamStartedAt);
      stopUpstreamTimeout();
      stopUpstreamTimeout = undefined;

      const outputData: Array<{ url: string }> = [];
      const outputImages: Array<{ width: number; height: number; bytes: number; format: string }> = [];
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
        const imageMetadata = readPngMetadata(buffer);
        timings.decode_ms += msSince(decodeStartedAt);
        totalImageBytes += buffer.length;
        outputImages.push({
          width: imageMetadata.width,
          height: imageMetadata.height,
          bytes: buffer.length,
          format: imageMetadata.format
        });

        const key = buildImageKey(config.r2.keyPrefix);
        const uploadStartedAt = performance.now();
        let url: string;
        try {
          url = await uploadWithRetry({
            upload,
            request,
            r2Client,
            config,
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
      imageCount = outputData.length;
      imageUrls = outputData.map((item) => item.url);
      responseParams = buildResponseParams(upstreamResponse, outputImages);

      const totalMs = msSince(totalStartedAt);
      request.log.info({
        request_id: request.id,
        operation,
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
        image_count: imageCount
      }, 'image operation wrapped');

      recordAdminRequest(adminStore, {
        requestId: request.id,
        createdAt: new Date().toISOString(),
        operation,
        statusCode: 200,
        success: true,
        ...metadata,
        requestParams,
        responseParams,
        totalMs,
        openaiMs: timings.openai_ms,
        decodeMs: timings.decode_ms,
        uploadMs: timings.upload_ms,
        imageBytes: totalImageBytes,
        imageCount,
        imageUrls
      }, request);

      const created = upstreamResponse.created || Math.floor(Date.now() / 1000);
      return reply.send({
        created,
        created_at_beijing: formatBeijingTime(created),
        data: outputData
      });
    } catch (error) {
      const totalMs = msSince(totalStartedAt);
      request.log.error({
        request_id: request.id,
        operation,
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
        total_ms: totalMs
      }, 'image operation failed');

      const upstreamReply = sendUpstreamError(reply, error);
      if (upstreamReply) {
        recordAdminRequest(adminStore, {
          requestId: request.id,
          createdAt: new Date().toISOString(),
          operation,
          statusCode: getAdminStatusCode(error),
          success: false,
          ...metadata,
          requestParams,
          responseParams,
          totalMs,
          openaiMs: timings.openai_ms,
          decodeMs: timings.decode_ms,
          uploadMs: timings.upload_ms,
          imageBytes: totalImageBytes,
          imageCount,
          errorCode: getAdminErrorCode(error),
          errorMessage: getAdminErrorMessage(error),
          imageUrls
        }, request);
        return upstreamReply;
      }

      recordAdminRequest(adminStore, {
        requestId: request.id,
        createdAt: new Date().toISOString(),
        operation,
        statusCode: getAdminStatusCode(error),
        success: false,
        ...metadata,
        requestParams,
        responseParams,
        totalMs,
        openaiMs: timings.openai_ms,
        decodeMs: timings.decode_ms,
        uploadMs: timings.upload_ms,
        imageBytes: totalImageBytes,
        imageCount,
        errorCode: getAdminErrorCode(error),
        errorMessage: getAdminErrorMessage(error),
        imageUrls
      }, request);

      return sendAppError(reply, error);
    } finally {
      stopUpstreamTimeout?.();
      releaseImageProcessingSlot?.();
      releaseGenerationSlot?.();
    }
  }

  app.post('/v1/images/generations', async (request, reply) => handleImageOperation('generation', request, reply));
  app.post('/v1/images/edits', async (request, reply) => handleImageOperation('edit', request, reply));

  return app;
}

function recordAdminRequest(store: AdminStore, record: ImageRequestRecord, request: FastifyRequest): void {
  try {
    store.recordRequest(record);
  } catch (error) {
    request.log.error({ err: error, request_id: record.requestId }, 'failed to record admin metrics');
  }
}
