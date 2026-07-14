import { createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Job, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { createR2Client } from '../r2.js';
import { ActiveRequestLimiter } from '../limiter.js';
import { createImageTaskWorker, createRedisConnection, enqueueImageTask, RedisRateLimiter } from './queue.js';
import type { AsyncTaskStore } from './store.js';
import type { AsyncTaskError, AsyncTaskRecord, TaskQueuePayload } from './types.js';
import { extractBase64TaskResult, isBase64ResultRequested, writeBase64TaskResult } from './base64-result.js';
import { executeUpstreamPayload } from '../image-runner.js';
import type { ImageOperation, UploadImageToR2, UpstreamDispatcher, UpstreamRequestPayload, ImageExecutionResult } from '../image-runner.js';
import { AppError } from '../errors.js';
import { uploadWithRetry } from '../upload-retry.js';
import { uploadImageToR2 } from '../r2.js';
import { genericOpenAICompatibleStrategy } from '../image-strategy.js';
import { loadImageSource } from '../image-runner.js';
import { readImageMetadata } from '../image.js';
import { sanitizeRawResponse } from './raw-response.js';
import {
  createWorkerRuntimeState,
  removeWorkerHeartbeat,
  trackWorkerTaskFinish,
  trackWorkerTaskRetry,
  trackWorkerTaskStart,
  writeWorkerHeartbeat,
  type WorkerRuntimeState
} from './worker-heartbeat.js';

const MAX_DIRECT_EXECUTE_ATTEMPTS = 3;
const SUPPORTED_PROVIDER = 'openai_compatible';
const SUPPORTED_REQUEST_FORMAT = 'openai_images';

export interface AsyncWorkerRuntime {
  worker: Worker<TaskQueuePayload, void, string>;
  close: () => Promise<void>;
}

interface CredentialLease {
  provider: string;
  request_format: string;
  base_url: string;
  api_key: string;
  model: string;
  channel_id?: string;
  expires_at?: string;
}

interface DirectExecuteResult {
  data: TaskResultImage[];
  usage: Record<string, unknown>;
  rawResponse: unknown;
  upstreamResponse: unknown;
  output: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface TaskResultImage {
  url: string;
  mime_type?: string;
  format?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
  filename?: string;
  revised_prompt?: string;
}

export function startAsyncWorker({
  config,
  store,
  taskQueue
}: {
  config: AppConfig;
  store: AsyncTaskStore;
  taskQueue: Queue<TaskQueuePayload>;
}): AsyncWorkerRuntime {
  const r2Client = createR2Client(config.r2);
  const upstreamDispatcher = new Agent({
    headersTimeout: config.upstream.timeoutMs,
    bodyTimeout: config.upstream.timeoutMs
  });
  const redis = createRedisConnection(config.asyncTasks.redisUrl);
  const rateLimiter = new RedisRateLimiter(redis, config);
  const imageProcessingLimiter = new ActiveRequestLimiter(config.asyncTasks.imageProcessingConcurrency);
  const runtimeState = createWorkerRuntimeState();

  void writeWorkerHeartbeat({ redis, config, state: runtimeState }).catch((error) => {
    console.error('worker heartbeat write failed', error);
  });

  const worker = createImageTaskWorker(config, async (job: Job<TaskQueuePayload>) => {
    await processTask({
      job,
      config,
      store,
      taskQueue,
      rateLimiter,
      imageProcessingLimiter,
      upstreamDispatcher,
      r2Client,
      base64ResultRedis: redis,
      runtimeState
    });
  });

  const recoveryInterval = setInterval(() => {
    void recoverQueuedTasks({ config, store, taskQueue }).catch((error) => {
      worker.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
  }, 60_000);
  recoveryInterval.unref();
  const heartbeatInterval = setInterval(() => {
    void writeWorkerHeartbeat({ redis, config, state: runtimeState }).catch((error) => {
      worker.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
  }, config.asyncTasks.workerHeartbeatIntervalMs);
  heartbeatInterval.unref();

  return {
    worker,
    close: async () => {
      clearInterval(recoveryInterval);
      clearInterval(heartbeatInterval);
      await removeWorkerHeartbeat(redis, runtimeState.workerId).catch(() => undefined);
      await worker.close();
      redis.disconnect();
      await upstreamDispatcher.close();
      r2Client.destroy();
    }
  };
}

export async function processTask({
  job,
  config,
  store,
  taskQueue,
  rateLimiter,
  imageProcessingLimiter,
  upstreamDispatcher,
  r2Client,
  base64ResultRedis,
  runtimeState,
  upload = uploadImageToR2
}: {
  job: Job<TaskQueuePayload>;
  config: AppConfig;
  store: AsyncTaskStore;
  taskQueue: Queue<TaskQueuePayload>;
  rateLimiter: RedisRateLimiter;
  imageProcessingLimiter: ActiveRequestLimiter;
  upstreamDispatcher: Agent;
  r2Client: ReturnType<typeof createR2Client>;
  base64ResultRedis?: Redis;
  runtimeState?: WorkerRuntimeState;
  upload?: UploadImageToR2;
}): Promise<void> {
  const claimed = await store.claimTask(job.data.provider_task_id);
  if (!claimed) {
    return;
  }
  runtimeState ? trackWorkerTaskStart(runtimeState, claimed) : undefined;

  try {
    const lease = await resolveCredentialLease({ task: claimed, config, dispatcher: upstreamDispatcher });
    assertSupportedLease(lease);
    await rateLimiter.waitForToken({
      provider: lease.provider,
      model: lease.model || claimed.model,
      channelId: lease.channel_id || (typeof claimed.metadata.channel_id === 'string' ? claimed.metadata.channel_id : undefined)
    });

    const releaseImageProcessing = await imageProcessingLimiter.acquire();
    try {
      const result = await executeDirectLeaseTask({
        task: claimed,
        lease,
        config,
        dispatcher: upstreamDispatcher,
        r2Client,
        upload: (args) => uploadWithRetry({
          ...args,
          upload,
          requestId: claimed.provider_task_id,
          config,
          r2Client
        })
      });

      const resultPayload = buildResultPayload(result);
      const usagePayload = result.usage;
      const safeRaw = sanitizeRawResponse(result.rawResponse, config.asyncTasks.rawResponseMaxBytes);
      if (isBase64ResultRequested(claimed)) {
        await writeBase64TaskResult(
          base64ResultRedis,
          claimed.provider_task_id,
          extractBase64TaskResult(result.upstreamResponse)
        );
      }
      const callbackPayload = buildCallbackPayload({
        task: claimed,
        status: 'succeeded',
        result: resultPayload,
        usage: usagePayload,
        error: null,
        rawResponse: safeRaw
      });

      await store.completeTask({
        providerTaskId: claimed.provider_task_id,
        status: 'succeeded',
        result: {
          ...resultPayload,
          raw_response: safeRaw.raw_response,
          raw_response_truncated: safeRaw.raw_response_truncated,
          raw_response_omitted_fields: safeRaw.raw_response_omitted_fields
        },
        usage: usagePayload,
        error: null,
        callbackPayload
      });
      runtimeState ? trackWorkerTaskFinish(runtimeState, claimed.provider_task_id, 'succeeded') : undefined;
    } finally {
      releaseImageProcessing();
    }
  } catch (error) {
    const taskError = toTaskError(error);
    if (taskError.retryable && claimed.attempts < MAX_DIRECT_EXECUTE_ATTEMPTS) {
      const delayMs = retryDelayMs(claimed.attempts);
      const queued = await store.retryTask(claimed.provider_task_id, taskError);
      if (queued) {
        await enqueueImageTask(taskQueue, claimed.provider_task_id, {
          delay: delayMs,
          jobId: `${claimed.provider_task_id}:retry:${claimed.attempts}`
        });
        runtimeState ? trackWorkerTaskRetry(runtimeState, claimed.provider_task_id, taskError.code) : undefined;
        return;
      }
    }

    const safeRaw = sanitizeRawResponse(extractCauseBody(error), config.asyncTasks.rawResponseMaxBytes);
    await store.completeTask({
      providerTaskId: claimed.provider_task_id,
      status: 'failed',
      result: {
        raw_response: safeRaw.raw_response,
        raw_response_truncated: safeRaw.raw_response_truncated,
        raw_response_omitted_fields: safeRaw.raw_response_omitted_fields
      },
      usage: null,
      error: taskError,
      callbackPayload: buildCallbackPayload({
        task: claimed,
        status: 'failed',
        result: null,
        usage: null,
        error: taskError,
        rawResponse: safeRaw
      })
    });
    runtimeState ? trackWorkerTaskFinish(runtimeState, claimed.provider_task_id, 'failed', taskError.code) : undefined;
  }
}

async function recoverQueuedTasks({
  config,
  store,
  taskQueue
}: {
  config: AppConfig;
  store: AsyncTaskStore;
  taskQueue: Queue<TaskQueuePayload>;
}): Promise<void> {
  const staleIds = await store.requeueStaleProcessing(config.asyncTasks.taskStaleProcessingTimeoutSeconds);
  const queuedIds = await store.getQueuedTaskIds(100);
  const ids = [...new Set([...staleIds, ...queuedIds])];
  for (const id of ids) {
    await enqueueImageTask(taskQueue, id);
  }
}

function buildCallbackPayload({
  task,
  status,
  result,
  usage,
  error,
  rawResponse
}: {
  task: AsyncTaskRecord;
  status: 'succeeded' | 'failed';
  result: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  error: AsyncTaskError | null;
  rawResponse: ReturnType<typeof sanitizeRawResponse>;
}): Record<string, unknown> {
  return {
    client_task_id: task.client_task_id,
    provider_task_id: task.provider_task_id,
    status,
    progress: '100%',
    result_data_format: 'url',
    result,
    usage,
    error,
    raw_response: rawResponse.raw_response,
    raw_response_truncated: rawResponse.raw_response_truncated,
    raw_response_omitted_fields: rawResponse.raw_response_omitted_fields
  };
}

function buildResultPayload(result: DirectExecuteResult): Record<string, unknown> {
  return {
    images: result.data,
    output: result.output,
    metadata: result.metadata
  };
}

async function executeDirectLeaseTask({
  task,
  lease,
  config,
  dispatcher,
  r2Client,
  upload
}: {
  task: AsyncTaskRecord;
  lease: CredentialLease;
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
  r2Client: ReturnType<typeof createR2Client>;
  upload: UploadImageToR2;
}): Promise<DirectExecuteResult> {
  const directConfig = configForLease(config, lease, task.operation);
  const body = buildOpenAICompatibleBody(task, lease);
  const payload = task.operation === 'edit'
    ? await buildEditPayloadFromUrls({ task, body, config: directConfig, dispatcher })
    : buildDirectJsonPayload({ body, config: directConfig });
  logDirectLeaseDebug(task, lease, directConfig);
  const execution = await executeUpstreamPayload({
    payload,
    authorization: `Bearer ${lease.api_key}`,
    config: directConfig,
    operation: task.operation,
    dispatcher,
    r2Client,
    upload,
    debug: {
      enabled: isUpstreamDebugEnabled(task),
      taskId: task.client_task_id,
      providerTaskId: task.provider_task_id,
      channelId: lease.channel_id || getString(task.metadata.channel_id)
    }
  });

  return {
    data: buildResultImages(execution),
    usage: safeObject(execution.upstreamResponse.usage),
    rawResponse: rewriteRawResponseImages(execution.upstreamResponse, execution.data),
    upstreamResponse: execution.upstreamResponse,
    output: buildOutputPayload(execution.upstreamResponse),
    metadata: buildExecutionMetadata({ task, execution })
  };
}

function buildResultImages(execution: ImageExecutionResult): TaskResultImage[] {
  const data = Array.isArray(execution.upstreamResponse.data) ? execution.upstreamResponse.data : [];
  return execution.data.map((image, index) => {
    const metadata = execution.outputImages[index];
    const upstreamItem = safeObject(data[index]);
    const result: TaskResultImage = {
      ...image
    };
    if (metadata) {
      result.mime_type = metadata.mimeType;
      result.format = metadata.format;
      result.width = metadata.width;
      result.height = metadata.height;
      result.size_bytes = metadata.bytes;
      result.filename = filenameFromUrl(image.url, metadata.extension);
    }
    const revisedPrompt = getString(upstreamItem.revised_prompt);
    if (revisedPrompt) {
      result.revised_prompt = revisedPrompt;
    }
    return result;
  });
}

function buildOutputPayload(upstreamResponse: unknown): Record<string, unknown> {
  const response = safeObject(upstreamResponse);
  const output: Record<string, unknown> = {};
  for (const key of ['created', 'background', 'output_format', 'quality', 'size', 'resolution']) {
    const value = response[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      output[key] = value;
    }
  }
  return output;
}

function buildExecutionMetadata({
  task,
  execution
}: {
  task: AsyncTaskRecord;
  execution: ImageExecutionResult;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    image_count: execution.data.length
  };
  if (task.operation === 'edit') {
    metadata.input_image_count = Array.isArray(task.input.images) ? task.input.images.length : 0;
    metadata.mask_used = typeof task.input.mask === 'string' && task.input.mask.trim() !== '';
  }
  const inputFidelity = getString(task.parameters.input_fidelity);
  if (inputFidelity) {
    metadata.input_fidelity = inputFidelity;
  }
  return metadata;
}

function filenameFromUrl(value: string, fallbackExtension: string): string {
  try {
    const pathname = new URL(value).pathname;
    const filename = pathname.split('/').filter(Boolean).pop();
    if (filename) {
      return filename;
    }
  } catch {
    // The R2 public URL should be absolute, but keep a stable fallback for tests/mocks.
  }
  return `image.${fallbackExtension}`;
}

function isUpstreamDebugEnabled(task: AsyncTaskRecord): boolean {
  return task.metadata.debug_upstream === true || task.metadata.debug_upstream === 'true';
}

function logDirectLeaseDebug(task: AsyncTaskRecord, lease: CredentialLease, config: AppConfig): void {
  if (!isUpstreamDebugEnabled(task)) {
    return;
  }
  console.info(`[image-handle upstream debug task=${task.client_task_id} provider_task=${task.provider_task_id} channel=${lease.channel_id || getString(task.metadata.channel_id) || '-'}] resolve ${JSON.stringify({
    provider: lease.provider,
    request_format: lease.request_format,
    base_url: lease.base_url,
    model: lease.model,
    operation: task.operation,
    final_path: task.operation === 'generation' ? config.upstream.imagesPath : config.upstream.imageEditsPath,
    expires_at: lease.expires_at
  })}`);
}

async function resolveCredentialLease({
  task,
  config,
  dispatcher
}: {
  task: AsyncTaskRecord;
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
}): Promise<CredentialLease> {
  const resolveUrl = task.executor.resolve_url;
  assertAllowedResolveUrl(resolveUrl, config);

  const rawBody = JSON.stringify({
    provider_task_id: task.provider_task_id,
    client_task_id: task.client_task_id,
    attempt: task.attempts,
    operation: task.operation,
    model: task.model
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const eventId = `evt_${randomUUID()}`;
  const secret = getCredentialLeaseSecret(task, config);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstream.timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await undiciFetch(resolveUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-imagehandle-timestamp': timestamp,
        'x-imagehandle-signature': signature,
        'x-imagehandle-event-id': eventId,
        'x-imagehandle-secret-id': task.executor.secret_id
      },
      body: rawBody,
      signal: controller.signal,
      dispatcher
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw leaseFailureToError(body, response.status, Math.round(performance.now() - startedAt));
    }
    return parseCredentialLease(body);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AppError('credential lease resolve timed out', {
        statusCode: 504,
        type: 'server_error',
        code: 'credential_lease_timeout',
        cause: {
          retryable: true
        }
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildEditPayloadFromUrls({
  task,
  body,
  config,
  dispatcher
}: {
  task: AsyncTaskRecord;
  body: Record<string, unknown>;
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
}): Promise<UpstreamRequestPayload> {
  const images = Array.isArray(task.input.images) ? task.input.images.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
  if (images.length === 0) {
    throw new AppError('input.images is required for async image edits', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'missing_edit_images'
    });
  }

  const form = new FormData();
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || key === 'image' || key === 'images' || key === 'mask') {
      continue;
    }
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      const fieldValue = String(value);
      fields.set(key, fieldValue);
      form.append(key, fieldValue);
    }
  }

  for (const [index, url] of images.entries()) {
    const buffer = await loadImageSource({
      source: { type: 'url', value: url },
      config,
      dispatcher
    });
    const metadata = readImageMetadata(buffer);
    form.append(
      'image',
      new Blob([buffer], { type: metadata.mimeType }),
      `image-${index + 1}.${metadata.extension}`
    );
  }

  if (typeof task.input.mask === 'string' && task.input.mask.trim() !== '') {
    const maskBuffer = await loadImageSource({
      source: { type: 'url', value: task.input.mask },
      config,
      dispatcher
    });
    const metadata = readImageMetadata(maskBuffer);
    form.append('mask', new Blob([maskBuffer], { type: metadata.mimeType }), `mask.${metadata.extension}`);
  }

  return {
    body: form,
    headers: {},
    strategy: genericOpenAICompatibleStrategy,
    metadata: {
      model: fields.get('model') ?? undefined,
      size: fields.get('size') ?? undefined
    },
    requestParams: Object.fromEntries(fields)
  };
}

function buildOpenAICompatibleBody(task: AsyncTaskRecord, lease: CredentialLease): Record<string, unknown> {
  return {
    ...task.parameters,
    model: lease.model || task.model,
    prompt: task.input.text
  };
}

function buildDirectJsonPayload({
  body,
  config
}: {
  body: Record<string, unknown>;
  config: AppConfig;
}): UpstreamRequestPayload {
  const normalizedBody = genericOpenAICompatibleStrategy.applyRequestDefaults(body, config.defaults);
  return {
    body: JSON.stringify(normalizedBody),
    headers: {
      'content-type': 'application/json'
    },
    strategy: genericOpenAICompatibleStrategy,
    metadata: {
      model: typeof normalizedBody.model === 'string' ? normalizedBody.model : undefined,
      size: typeof normalizedBody.size === 'string' ? normalizedBody.size : undefined
    },
    requestParams: buildRequestParams(normalizedBody)
  };
}

function buildRequestParams(body: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of ['model', 'n', 'size', 'quality', 'resolution', 'output_format', 'output_compression']) {
    const value = body[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      params[key] = value;
    }
  }
  return params;
}

function configForLease(config: AppConfig, lease: CredentialLease, operation: ImageOperation): AppConfig {
  return {
    ...config,
    upstream: {
      ...config.upstream,
      baseUrl: normalizeBaseUrl(lease.base_url),
      imagesPath: operation === 'generation' ? '/images/generations' : config.upstream.imagesPath,
      imageEditsPath: operation === 'edit' ? '/images/edits' : config.upstream.imageEditsPath,
      apiKey: lease.api_key
    }
  };
}

function rewriteRawResponseImages(upstreamResponse: unknown, images: Array<{ url: string; mime_type?: string }>): unknown {
  if (!upstreamResponse || typeof upstreamResponse !== 'object' || Array.isArray(upstreamResponse)) {
    return upstreamResponse;
  }
  const response = { ...upstreamResponse as Record<string, unknown> };
  if (!Array.isArray(response.data)) {
    return response;
  }
  response.data = response.data.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return item;
    }
    const output = { ...item as Record<string, unknown> };
    const image = images[index];
    if (image?.url) {
      output.url = image.url;
    }
    if (image?.mime_type) {
      output.mime_type = image.mime_type;
    }
    if ('b64_json' in output) {
      output.b64_json = '[omitted]';
    }
    return output;
  });
  return response;
}

async function readJsonResponse(response: Response): Promise<unknown> {
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

function assertAllowedResolveUrl(value: string, config: AppConfig): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError('executor.resolve_url is invalid', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_resolve_url',
      cause: error
    });
  }
  const allowed = config.asyncTasks.credentialLeaseAllowedHosts;
  if (allowed.length > 0 && !allowed.includes(url.host)) {
    throw new AppError('executor.resolve_url host is not allowed', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'resolve_url_host_not_allowed',
      cause: {
        host: url.host,
        allowed_hosts: allowed
      }
    });
  }
}

function getCredentialLeaseSecret(task: AsyncTaskRecord, config: AppConfig): string {
  const secret = config.asyncTasks.credentialLeaseSecrets[task.executor.secret_id];
  if (!secret) {
    throw new AppError('Missing credential lease secret for executor.secret_id', {
      statusCode: 401,
      type: 'invalid_request_error',
      code: 'missing_credential_lease_secret'
    });
  }
  return secret;
}

function assertSupportedLease(value: CredentialLease): void {
  if (value.provider !== SUPPORTED_PROVIDER || value.request_format !== SUPPORTED_REQUEST_FORMAT) {
    throw new AppError('credential lease request format is unsupported', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'unsupported_credential_lease_format',
      cause: {
        retryable: false
      }
    });
  }
}

function parseCredentialLease(value: unknown): CredentialLease {
  const body = safeObject(value);
  return {
    provider: requireString(body, 'provider'),
    request_format: requireString(body, 'request_format'),
    base_url: requireString(body, 'base_url'),
    api_key: requireString(body, 'api_key'),
    model: requireString(body, 'model'),
    channel_id: getString(body.channel_id),
    expires_at: getString(body.expires_at)
  };
}

function leaseFailureToError(value: unknown, statusCode: number, elapsedMs: number): AppError {
  const body = safeObject(value);
  const error = safeObject(body.error);
  const code = getString(error.code) || 'credential_lease_http_error';
  const message = getString(error.message) || 'credential lease resolve returned an error';
  const retryable = error.retryable === true;
  return new AppError(message, {
    statusCode,
    type: statusCode >= 500 ? 'server_error' : 'upstream_error',
    code,
    cause: {
      status_code: statusCode,
      elapsed_ms: elapsedMs,
      retryable,
      body
    }
  });
}

function extractCauseBody(error: unknown): unknown {
  if (error instanceof AppError) {
    const cause = safeObject(error.cause);
    return cause.body ?? cause.upstream_error ?? error.cause ?? null;
  }
  return null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = getString(value[key]);
  if (!field) {
    throw new AppError(`credential lease ${key} is required`, {
      statusCode: 502,
      type: 'upstream_error',
      code: `missing_credential_${key}`,
      cause: {
        retryable: false
      }
    });
  }
  return field;
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function toTaskError(error: unknown): AsyncTaskError {
  if (error instanceof AppError) {
    const cause = safeObject(error.cause);
    const upstream = getUpstreamErrorDetails(error);
    const hasRetryableDecision = typeof cause.retryable === 'boolean';
    return {
      code: error.code,
      message: upstream.provider_error_message ?? error.message,
      retryable: hasRetryableDecision
        ? cause.retryable === true
        : error.statusCode >= 500 || error.statusCode === 429,
      ...upstream
    };
  }

  return {
    code: 'generation_failed',
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}

function getUpstreamErrorDetails(error: AppError): Partial<AsyncTaskError> {
  const cause = safeObject(error.cause);
  const body = safeObject(cause.body ?? cause.upstream_error ?? error.cause);
  const nested = safeObject(body.error);
  const source = Object.keys(nested).length > 0 ? nested : body;
  const upstreamStatus = getNumber(cause.status_code) ?? error.statusCode;
  const providerMessage =
    getString(source.message) ??
    getString(body.message) ??
    (typeof cause.body === 'string' ? cause.body : undefined);
  const providerCode =
    getString(source.code) ??
    getString(body.code) ??
    getString(source.type) ??
    getString(body.type);
  const providerType =
    getString(source.type) ??
    getString(body.type);
  const providerParam =
    getString(source.param) ??
    getString(body.param);

  return {
    upstream_status: upstreamStatus,
    provider_error_code: providerCode,
    provider_error_type: providerType,
    provider_error_message: providerMessage,
    provider_error_param: providerParam,
    upstream_error: Object.keys(body).length > 0 ? body : undefined
  };
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
