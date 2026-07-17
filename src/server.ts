import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { performance } from 'node:perf_hooks';
import { Agent, fetch as undiciFetch } from 'undici';
import { registerAdminRoutes, type AdminUploadFile, type AdminUploadResult } from './admin/routes.js';
import { AdminStore } from './admin/store.js';
import type { AdminRuntimeStats, ImageRequestRecord } from './admin/types.js';
import { registerAsyncTaskRoutes } from './async/routes.js';
import { AsyncTaskStore } from './async/store.js';
import { createQueueClients, closeQueueClients, type QueueClients } from './async/queue.js';
import { registerImageUploadRoutes } from './async/uploads.js';
import type { AppConfig } from './config.js';
import { AppError, openAIError, sendAppError } from './errors.js';
import { buildImageKey, decodeBase64Image, normalizeImageRequestBody, readImageMetadata, type ImageMetadata, type ImageRequestBody } from './image.js';
import { pickImageStrategy, type ImageModelStrategy, type ImageSource, type ImageSourceType } from './image-strategy.js';
import { ActiveRequestLimiter } from './limiter.js';
import { createR2Client, uploadImageToR2 } from './r2.js';
import { uploadWithRetry } from './upload-retry.js';
import { assertNoHttpRedirect, createPinnedHttpTarget } from './safe-url.js';

interface UpstreamImageItem {
  b64_json?: string;
  url?: string;
  mime_type?: string;
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

type UploadImageToR2 = typeof uploadImageToR2;
type ImageOperation = 'generation' | 'edit';
type AdminImageOperation = ImageRequestRecord['operation'];

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

type UpstreamDispatcher = Agent;

interface CorsConfig {
  allowedOrigins: string[];
  maxAgeSeconds: number;
}

interface UpstreamRequestPayload {
  body: string | FormData;
  headers: Record<string, string>;
  strategy: ImageModelStrategy;
  metadata: {
    model?: string;
    size?: string;
  };
  requestParams: Record<string, unknown>;
}

interface ServerDeps {
  uploadImageToR2?: UploadImageToR2;
  uploadPngToR2?: UploadImageToR2;
  adminStore?: AdminStore;
  asyncTaskStore?: AsyncTaskStore;
  queueClients?: QueueClients;
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
  for (const key of ['model', 'n', 'size', 'quality', 'resolution', 'output_format', 'output_compression']) {
    addParamIfPresent(params, key, body[key]);
  }
  return params;
}

function buildRequestParamsFromFields(fields: Map<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of ['model', 'n', 'size', 'quality', 'resolution', 'output_format', 'output_compression']) {
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
  outputImages: Array<(ImageMetadata & { sourceType: ImageSourceType }) | undefined>,
  strategy: ImageModelStrategy,
  sourceTypes: ImageSourceType[] = outputImages.flatMap((item) => item ? [item.sourceType] : [])
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  addResponseParam(params, 'created', upstreamResponse.created);

  const knownImages = outputImages.filter(
    (item): item is ImageMetadata & { sourceType: ImageSourceType } => item !== undefined
  );
  const firstImage = knownImages[0];
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
  if (strategy.name !== 'gpt-image') {
    params.strategy = strategy.name;
    params.formats = [...new Set(knownImages.map((item) => item.format))];
    params.sourceTypes = [...new Set(sourceTypes)];
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

function buildUploadResponseParams(metadata: ImageMetadata, filename: string, key: string): Record<string, unknown> {
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    size: `${metadata.width}x${metadata.height}`,
    bytes: metadata.bytes,
    count: 1,
    filename,
    key
  };
}

function readAdminUploadImageMetadata(buffer: Buffer): ImageMetadata {
  try {
    return readImageMetadata(buffer);
  } catch (error) {
    throw new AppError('Uploaded file must be a PNG, JPEG, or WebP image', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'unsupported_upload_image',
      cause: error
    });
  }
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
  payload,
  dispatcher
}: {
  config: AppConfig;
  request: FastifyRequest;
  operation: ImageOperation;
  payload: UpstreamRequestPayload;
  dispatcher: UpstreamDispatcher;
}): Promise<UpstreamFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstream.timeoutMs);

  try {
    const response = await undiciFetch(upstreamUrl(config, operation), {
      method: 'POST',
      headers: copyForwardHeaders(request, payload.headers),
      body: payload.body,
      signal: controller.signal,
      dispatcher
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

function imageDownloadTimeoutError(error: unknown): AppError {
  return new AppError('Upstream image URL download timed out', {
    statusCode: 504,
    type: 'server_error',
    code: 'image_url_download_timeout',
    cause: error
  });
}

function parseImageDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError('Upstream image URL is invalid', {
      statusCode: 502,
      type: 'server_error',
      code: 'invalid_image_url',
      cause: error
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('Upstream image URL protocol is unsupported', {
      statusCode: 502,
      type: 'server_error',
      code: 'unsupported_image_url_protocol'
    });
  }

  return url;
}

function getResponseContentLength(response: Response): number | undefined {
  const value = response.headers.get('content-length');
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readResponseBufferWithLimit(response: Response, limitBytes: number): Promise<Buffer> {
  const contentLength = getResponseContentLength(response);
  if (contentLength !== undefined && contentLength > limitBytes) {
    throw new AppError('Downloaded image exceeds size limit', {
      statusCode: 502,
      type: 'server_error',
      code: 'image_download_too_large',
      cause: {
        content_length: contentLength,
        limit_bytes: limitBytes
      }
    });
  }

  if (!response.body) {
    throw new AppError('Downloaded image body is empty', {
      statusCode: 502,
      type: 'server_error',
      code: 'empty_image'
    });
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel();
        throw new AppError('Downloaded image exceeds size limit', {
          statusCode: 502,
          type: 'server_error',
          code: 'image_download_too_large',
          cause: {
            bytes: totalBytes,
            limit_bytes: limitBytes
          }
        });
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw imageDownloadTimeoutError(error);
    }
    throw error;
  }

  const buffer = Buffer.concat(chunks, totalBytes);
  if (buffer.length === 0) {
    throw new AppError('Downloaded image body is empty', {
      statusCode: 502,
      type: 'server_error',
      code: 'empty_image'
    });
  }

  return buffer;
}

async function downloadImageUrl({
  source,
  config,
  dispatcher: _dispatcher
}: {
  source: ImageSource;
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
}): Promise<Buffer> {
  const url = parseImageDownloadUrl(source.value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstream.timeoutMs);
  const target = await createPinnedHttpTarget(url, config.asyncTasks.imageUrlAllowPrivateNetwork);

  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      signal: controller.signal,
      dispatcher: target.dispatcher,
      redirect: 'manual'
    });
    assertNoHttpRedirect(response);
    if (!response.ok) {
      throw new AppError('Upstream image URL download failed', {
        statusCode: 502,
        type: 'server_error',
        code: 'image_url_download_failed',
        cause: {
          status_code: response.status,
          status_text: response.statusText
        }
      });
    }

    return await readResponseBufferWithLimit(response, config.bodyLimitBytes);
  } catch (error) {
    if (isAbortError(error)) {
      throw imageDownloadTimeoutError(error);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await target.close();
  }
}

async function loadImageSource({
  source,
  config,
  dispatcher
}: {
  source: ImageSource;
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
}): Promise<Buffer> {
  if (source.type === 'base64') {
    return decodeBase64Image(source.value);
  }

  return downloadImageUrl({ source, config, dispatcher });
}

async function buildJsonUpstreamPayload(
  request: FastifyRequest,
  config: AppConfig
): Promise<UpstreamRequestPayload> {
  const rawBody = normalizeImageRequestBody(request.body);
  const strategy = pickImageStrategy(rawBody);
  const body = strategy.applyRequestDefaults(rawBody, config.defaults);
  return {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json'
    },
    strategy,
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
    const strategy = pickImageStrategy({ model: fields.get('model') });
    if (strategy.name !== 'xai-grok-imagine') {
      form.append('size', config.defaults.size);
      fields.set('size', config.defaults.size);
    }
  }

  const strategy = pickImageStrategy({ model: fields.get('model') });
  if (strategy.name !== 'xai-grok-imagine') {
    form.set('output_format', config.defaults.outputFormat);
    fields.set('output_format', config.defaults.outputFormat);
  }

  return {
    body: form,
    headers: {},
    strategy,
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

export function buildServer(config: AppConfig, deps: ServerDeps = {}): FastifyInstance {
  const r2Client = createR2Client(config.r2);
  const upstreamDispatcher = new Agent({
    headersTimeout: config.upstream.timeoutMs,
    bodyTimeout: config.upstream.timeoutMs
  });
  const upload = deps.uploadImageToR2 ?? deps.uploadPngToR2 ?? uploadImageToR2;
  const adminStore = deps.adminStore ?? new AdminStore(config.admin.dbPath);
  const asyncStore = deps.asyncTaskStore ?? (config.asyncTasks.postgresUrl ? new AsyncTaskStore(config.asyncTasks.postgresUrl) : undefined);
  const queueClients = deps.queueClients ?? (config.asyncTasks.redisUrl ? createQueueClients(config) : undefined);
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
    await upstreamDispatcher.close();
    if (!deps.queueClients && queueClients) {
      await closeQueueClients(queueClients);
    }
    if (!deps.asyncTaskStore && asyncStore) {
      await asyncStore.close();
    }
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
    getRuntimeStats: () => runtimeStats(config, generationLimiter, imageProcessingLimiter, adminStore),
    maxUploadBytes: config.bodyLimitBytes,
    uploadImage: (file, request) => handleAdminImageUpload(file, request),
    asyncTaskStore: asyncStore,
    taskQueue: queueClients?.taskQueue,
    asyncRedisConnection: queueClients?.connection
  });

  if (asyncStore && queueClients) {
    registerAsyncTaskRoutes(app, {
      config,
      store: asyncStore,
      taskQueue: queueClients.taskQueue,
      base64ResultRedis: queueClients.connection
    });
    registerImageUploadRoutes(app, {
      config,
      r2Client,
      upload
    });
  }

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
        payload: upstreamPayload,
        dispatcher: upstreamDispatcher
      });
      stopUpstreamTimeout = upstreamFetch.stopTimeout;

      releaseImageProcessingSlot = await imageProcessingLimiter.acquire();
      assertMemoryAvailable(config);
      const upstreamResponse = await parseUpstreamResponse(upstreamFetch.response);
      timings.openai_ms = msSince(upstreamStartedAt);
      stopUpstreamTimeout();
      stopUpstreamTimeout = undefined;

      const outputData: Array<{ url: string }> = [];
      const outputImages: Array<(ImageMetadata & { sourceType: ImageSourceType }) | undefined> = [];
      const imageSources = upstreamPayload.strategy.extractImages(upstreamResponse);
      if (imageSources.length === 0) {
        throw new AppError('new-api returned no image data', {
          statusCode: 502,
          type: 'server_error',
          code: 'empty_upstream_data'
        });
      }

      for (const source of imageSources) {
        if (source.type === 'url') {
          outputData.push({ url: source.value });
          outputImages.push(undefined);
          continue;
        }

        const decodeStartedAt = performance.now();
        const buffer = await loadImageSource({
          source,
          config,
          dispatcher: upstreamDispatcher
        });
        const imageMetadata = readImageMetadata(buffer);
        if (!upstreamPayload.strategy.allowedFormats.includes(imageMetadata.format)) {
          throw new AppError('Upstream returned unsupported image format for selected strategy', {
            statusCode: 502,
            type: 'server_error',
            code: 'unsupported_image_format',
            cause: {
              strategy: upstreamPayload.strategy.name,
              format: imageMetadata.format
            }
          });
        }
        timings.decode_ms += msSince(decodeStartedAt);
        totalImageBytes += buffer.length;
        outputImages.push({
          ...imageMetadata,
          sourceType: source.type
        });

        const key = buildImageKey(config.r2.keyPrefix, new Date(), undefined, imageMetadata.extension);
        const uploadStartedAt = performance.now();
        let url: string;
        try {
          url = await uploadWithRetry({
            upload,
            request,
            r2Client,
            config,
            key,
            buffer,
            contentType: imageMetadata.mimeType
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
      responseParams = buildResponseParams(
        upstreamResponse,
        outputImages,
        upstreamPayload.strategy,
        imageSources.map((source) => source.type)
      );

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

  async function handleAdminImageUpload(
    file: AdminUploadFile,
    request: FastifyRequest
  ): Promise<AdminUploadResult> {
    const totalStartedAt = performance.now();
    const operation: AdminImageOperation = 'manual_upload';
    let uploadMs = 0;
    let metadata: ImageMetadata | undefined;
    let key: string | undefined;
    let url: string | undefined;

    try {
      if (file.buffer.length === 0) {
        throw new AppError('Uploaded image file is empty', {
          statusCode: 400,
          type: 'invalid_request_error',
          code: 'empty_upload_file'
        });
      }

      assertMemoryAvailable(config);
      metadata = readAdminUploadImageMetadata(file.buffer);
      key = buildImageKey(config.r2.keyPrefix, new Date(), undefined, metadata.extension);
      const uploadStartedAt = performance.now();
      try {
        url = await uploadWithRetry({
          upload,
          request,
          r2Client,
          config,
          key,
          buffer: file.buffer,
          contentType: metadata.mimeType
        });
      } catch (uploadError) {
        uploadMs += msSince(uploadStartedAt);
        request.log.error({
          request_id: request.id,
          r2: r2ErrorDetails(uploadError)
        }, 'admin r2 upload failed');

        throw new AppError('R2 upload failed', {
          statusCode: 502,
          type: 'server_error',
          code: 'r2_upload_failed'
        });
      }
      uploadMs += msSince(uploadStartedAt);

      const uploadedAt = new Date().toISOString();
      const totalMs = msSince(totalStartedAt);
      recordAdminRequest(adminStore, {
        requestId: request.id,
        createdAt: uploadedAt,
        operation,
        statusCode: 200,
        success: true,
        size: `${metadata.width}x${metadata.height}`,
        requestParams: {
          filename: file.filename,
          content_type: file.mimetype,
          bytes: file.buffer.length
        },
        responseParams: buildUploadResponseParams(metadata, file.filename, key),
        totalMs,
        openaiMs: 0,
        decodeMs: 0,
        uploadMs,
        imageBytes: metadata.bytes,
        imageCount: 1,
        imageUrls: [url]
      }, request);

      request.log.info({
        request_id: request.id,
        operation,
        upload_ms: uploadMs,
        total_ms: totalMs,
        image_bytes: metadata.bytes,
        image_format: metadata.format,
        key
      }, 'admin image uploaded');

      return {
        url,
        key,
        filename: file.filename,
        contentType: metadata.mimeType,
        bytes: metadata.bytes,
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        uploadedAt
      };
    } catch (error) {
      const totalMs = msSince(totalStartedAt);
      request.log.error({
        request_id: request.id,
        operation,
        err: error,
        upload_ms: uploadMs,
        total_ms: totalMs
      }, 'admin image upload failed');

      recordAdminRequest(adminStore, {
        requestId: request.id,
        createdAt: new Date().toISOString(),
        operation,
        statusCode: getAdminStatusCode(error),
        success: false,
        size: metadata ? `${metadata.width}x${metadata.height}` : undefined,
        requestParams: {
          filename: file.filename,
          content_type: file.mimetype,
          bytes: file.buffer.length
        },
        responseParams: metadata && key ? buildUploadResponseParams(metadata, file.filename, key) : undefined,
        totalMs,
        openaiMs: 0,
        decodeMs: 0,
        uploadMs,
        imageBytes: metadata?.bytes ?? 0,
        imageCount: url ? 1 : 0,
        errorCode: getAdminErrorCode(error),
        errorMessage: getAdminErrorMessage(error),
        imageUrls: url ? [url] : []
      }, request);

      throw error;
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
