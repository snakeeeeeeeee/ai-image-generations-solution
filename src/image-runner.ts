import type { S3Client } from '@aws-sdk/client-s3';
import { performance } from 'node:perf_hooks';
import { Agent, fetch as undiciFetch } from 'undici';
import type { AppConfig } from './config.js';
import { AppError } from './errors.js';
import {
  buildImageKey,
  decodeBase64Image,
  normalizeImageRequestBody,
  readImageMetadata,
  type ImageMetadata,
  type ImageRequestBody
} from './image.js';
import {
  pickImageStrategy,
  type ImageModelStrategy,
  type ImageSource,
  type ImageSourceType
} from './image-strategy.js';
import { uploadImageToR2 } from './r2.js';

export interface UpstreamImageItem {
  b64_json?: string;
  url?: string;
  mime_type?: string;
  [key: string]: unknown;
}

export interface UpstreamImageResponse {
  created?: number;
  data?: UpstreamImageItem[];
  [key: string]: unknown;
}

export interface RunnerTimings {
  openai_ms: number;
  decode_ms: number;
  upload_ms: number;
}

export interface ImageExecutionResult {
  created: number;
  data: Array<{ url: string }>;
  outputImages: Array<ImageMetadata & { sourceType: ImageSourceType }>;
  responseParams: Record<string, unknown>;
  requestParams: Record<string, unknown>;
  metadata: {
    model?: string;
    size?: string;
  };
  timings: RunnerTimings;
  imageBytes: number;
  imageCount: number;
  imageUrls: string[];
}

export type UploadImageToR2 = typeof uploadImageToR2;
export type ImageOperation = 'generation' | 'edit';
export type UpstreamDispatcher = Agent;

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

export interface BuildPayloadOptions {
  body: unknown;
  config: AppConfig;
  operation: ImageOperation;
}

export interface ExecuteImageOperationOptions {
  body: unknown;
  authorization?: string;
  config: AppConfig;
  operation: ImageOperation;
  dispatcher: UpstreamDispatcher;
  r2Client: S3Client;
  upload?: UploadImageToR2;
}

export interface ExecuteUpstreamPayloadOptions {
  payload: UpstreamRequestPayload;
  authorization?: string;
  config: AppConfig;
  operation: ImageOperation;
  dispatcher: UpstreamDispatcher;
  r2Client: S3Client;
  upload?: UploadImageToR2;
}

export interface UploadImageSourcesOptions {
  sources: ImageSource[];
  allowedFormats: ImageMetadata['format'][];
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
  r2Client: S3Client;
  upload?: UploadImageToR2;
}

export function getRequestMetadata(body: ImageRequestBody | undefined): { model?: string; size?: string } {
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

export function buildRequestParamsFromBody(body: ImageRequestBody): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of ['model', 'n', 'size', 'quality', 'output_format', 'output_compression']) {
    addParamIfPresent(params, key, body[key]);
  }
  return params;
}

function addResponseParam(params: Record<string, unknown>, key: string, value: unknown): void {
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    params[key] = value;
  }
}

export function buildResponseParams(
  upstreamResponse: UpstreamImageResponse,
  outputImages: Array<ImageMetadata & { sourceType: ImageSourceType }>,
  strategy: ImageModelStrategy
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
  if (strategy.name !== 'gpt-image') {
    params.strategy = strategy.name;
    params.formats = [...new Set(outputImages.map((item) => item.format))];
    params.sourceTypes = [...new Set(outputImages.map((item) => item.sourceType))];
  }

  return params;
}

function upstreamUrl(config: AppConfig, operation: ImageOperation): string {
  const path = operation === 'generation' ? config.upstream.imagesPath : config.upstream.imageEditsPath;
  return `${config.upstream.baseUrl}${path}`;
}

function msSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function upstreamTimeoutError(error: unknown): AppError {
  return new AppError('new-api image generation timed out', {
    statusCode: 504,
    type: 'server_error',
    code: 'upstream_timeout',
    cause: error
  });
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

export async function parseUpstreamResponse(response: Response): Promise<UpstreamImageResponse> {
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

function copyForwardHeaders(authorization: string | undefined, extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };

  if (authorization) {
    headers.authorization = authorization;
  }

  return headers;
}

export async function fetchUpstream({
  config,
  authorization,
  operation,
  payload,
  dispatcher
}: {
  config: AppConfig;
  authorization?: string;
  operation: ImageOperation;
  payload: UpstreamRequestPayload;
  dispatcher: UpstreamDispatcher;
}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstream.timeoutMs);

  try {
    return await undiciFetch(upstreamUrl(config, operation), {
      method: 'POST',
      headers: copyForwardHeaders(authorization, payload.headers),
      body: payload.body,
      signal: controller.signal,
      dispatcher
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw upstreamTimeoutError(error);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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
  dispatcher
}: {
  source: ImageSource;
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
}): Promise<Buffer> {
  const url = parseImageDownloadUrl(source.value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstream.timeoutMs);

  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      signal: controller.signal,
      dispatcher
    });
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
  }
}

export async function loadImageSource({
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

export async function buildJsonUpstreamPayload({
  body,
  config
}: {
  body: unknown;
  config: AppConfig;
}): Promise<UpstreamRequestPayload> {
  const rawBody = normalizeImageRequestBody(body);
  const strategy = pickImageStrategy(rawBody);
  const normalizedBody = strategy.applyRequestDefaults(rawBody, config.defaults);
  return {
    body: JSON.stringify(normalizedBody),
    headers: {
      'content-type': 'application/json'
    },
    strategy,
    metadata: getRequestMetadata(normalizedBody),
    requestParams: buildRequestParamsFromBody(normalizedBody)
  };
}

export async function buildUpstreamPayload({
  body,
  config,
  operation
}: BuildPayloadOptions): Promise<UpstreamRequestPayload> {
  if (operation !== 'generation') {
    throw new AppError('Async multipart image edits are not supported by this payload builder', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'unsupported_async_operation'
    });
  }

  return buildJsonUpstreamPayload({ body, config });
}

export async function executeUpstreamPayload({
  payload,
  authorization,
  config,
  operation,
  dispatcher,
  r2Client,
  upload = uploadImageToR2
}: ExecuteUpstreamPayloadOptions): Promise<ImageExecutionResult> {
  const timings: RunnerTimings = {
    openai_ms: 0,
    decode_ms: 0,
    upload_ms: 0
  };
  let totalImageBytes = 0;

  const upstreamStartedAt = performance.now();
  const upstreamResponse = await parseUpstreamResponse(await fetchUpstream({
    config,
    authorization,
    operation,
    payload,
    dispatcher
  }));
  timings.openai_ms = msSince(upstreamStartedAt);

  const outputData: Array<{ url: string }> = [];
  const outputImages: Array<ImageMetadata & { sourceType: ImageSourceType }> = [];
  const imageSources = payload.strategy.extractImages(upstreamResponse);
  if (imageSources.length === 0) {
    throw new AppError('new-api returned no image data', {
      statusCode: 502,
      type: 'server_error',
      code: 'empty_upstream_data'
    });
  }

  const uploaded = await uploadImageSources({
    sources: imageSources,
    allowedFormats: payload.strategy.allowedFormats,
    config,
    dispatcher,
    r2Client,
    upload
  });
  outputData.push(...uploaded.data);
  outputImages.push(...uploaded.outputImages);
  timings.decode_ms += uploaded.timings.decode_ms;
  timings.upload_ms += uploaded.timings.upload_ms;
  totalImageBytes += uploaded.imageBytes;

  const created = upstreamResponse.created || Math.floor(Date.now() / 1000);
  const imageUrls = outputData.map((item) => item.url);
  return {
    created,
    data: outputData,
    outputImages,
    responseParams: buildResponseParams(upstreamResponse, outputImages, payload.strategy),
    requestParams: payload.requestParams,
    metadata: payload.metadata,
    timings,
    imageBytes: totalImageBytes,
    imageCount: outputData.length,
    imageUrls
  };
}

export async function uploadImageSources({
  sources,
  allowedFormats,
  config,
  dispatcher,
  r2Client,
  upload = uploadImageToR2
}: UploadImageSourcesOptions): Promise<{
  data: Array<{ url: string }>;
  outputImages: Array<ImageMetadata & { sourceType: ImageSourceType }>;
  timings: Pick<RunnerTimings, 'decode_ms' | 'upload_ms'>;
  imageBytes: number;
}> {
  const outputData: Array<{ url: string }> = [];
  const outputImages: Array<ImageMetadata & { sourceType: ImageSourceType }> = [];
  const timings = {
    decode_ms: 0,
    upload_ms: 0
  };
  let totalImageBytes = 0;

  for (const source of sources) {
    const decodeStartedAt = performance.now();
    const buffer = await loadImageSource({
      source,
      config,
      dispatcher
    });
    const imageMetadata = readImageMetadata(buffer);
    if (!allowedFormats.includes(imageMetadata.format)) {
      throw new AppError('Upstream returned unsupported image format', {
        statusCode: 502,
        type: 'server_error',
        code: 'unsupported_image_format',
        cause: {
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
    const url = await upload({
      client: r2Client,
      config: config.r2,
      key,
      buffer,
      contentType: imageMetadata.mimeType
    });
    timings.upload_ms += msSince(uploadStartedAt);
    outputData.push({ url });
  }

  return {
    data: outputData,
    outputImages,
    timings,
    imageBytes: totalImageBytes
  };
}

export async function executeImageOperation(options: ExecuteImageOperationOptions): Promise<ImageExecutionResult> {
  const payload = await buildUpstreamPayload({
    body: options.body,
    config: options.config,
    operation: options.operation
  });
  return executeUpstreamPayload({
    ...options,
    payload
  });
}
