import { createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Job, Queue, Worker } from 'bullmq';
import type { AppConfig } from '../config.js';
import { createR2Client } from '../r2.js';
import { ActiveRequestLimiter } from '../limiter.js';
import { createImageTaskWorker, createRedisConnection, enqueueImageTask, RedisRateLimiter } from './queue.js';
import type { AsyncTaskStore } from './store.js';
import type { AsyncTaskError, AsyncTaskRecord, TaskQueuePayload } from './types.js';
import { executeUpstreamPayload } from '../image-runner.js';
import type { ImageOperation, UploadImageToR2, UpstreamDispatcher, UpstreamRequestPayload } from '../image-runner.js';
import { AppError } from '../errors.js';
import { uploadWithRetry } from '../upload-retry.js';
import { uploadImageToR2 } from '../r2.js';
import { genericOpenAICompatibleStrategy } from '../image-strategy.js';
import { loadImageSource } from '../image-runner.js';
import { sanitizeRawResponse } from './raw-response.js';

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
  data: Array<{ url: string; mime_type?: string }>;
  usage: Record<string, unknown>;
  rawResponse: unknown;
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

  const worker = createImageTaskWorker(config, async (job: Job<TaskQueuePayload>) => {
    await processTask({
      job,
      config,
      store,
      taskQueue,
      rateLimiter,
      imageProcessingLimiter,
      upstreamDispatcher,
      r2Client
    });
  });

  const recoveryInterval = setInterval(() => {
    void recoverQueuedTasks({ config, store, taskQueue }).catch((error) => {
      worker.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
  }, 60_000);
  recoveryInterval.unref();

  return {
    worker,
    close: async () => {
      clearInterval(recoveryInterval);
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
  upload?: UploadImageToR2;
}): Promise<void> {
  const claimed = await store.claimTask(job.data.provider_task_id);
  if (!claimed) {
    return;
  }

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

      const resultPayload = {
        images: result.data
      };
      const usagePayload = result.usage;
      const safeRaw = sanitizeRawResponse(result.rawResponse, config.asyncTasks.rawResponseMaxBytes);
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
        return;
      }
    }

    const safeRaw = sanitizeRawResponse(extractCauseBody(error), config.asyncTasks.rawResponseMaxBytes);
    await store.completeTask({
      providerTaskId: claimed.provider_task_id,
      status: 'failed',
      result: null,
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
    result,
    usage,
    error,
    raw_response: rawResponse.raw_response,
    raw_response_truncated: rawResponse.raw_response_truncated,
    raw_response_omitted_fields: rawResponse.raw_response_omitted_fields
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
    data: execution.data,
    usage: safeObject(execution.upstreamResponse.usage),
    rawResponse: rewriteRawResponseImages(execution.upstreamResponse, execution.data)
  };
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
    form.append('image', new Blob([buffer]), `image-${index + 1}.png`);
  }

  if (typeof task.input.mask === 'string' && task.input.mask.trim() !== '') {
    const maskBuffer = await loadImageSource({
      source: { type: 'url', value: task.input.mask },
      config,
      dispatcher
    });
    form.append('mask', new Blob([maskBuffer]), 'mask.png');
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
  for (const key of ['model', 'n', 'size', 'quality', 'output_format', 'output_compression']) {
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
  if (error instanceof AppError && error.cause && typeof error.cause === 'object') {
    const cause = error.cause as { body?: unknown };
    return cause.body ?? error.cause;
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
    const cause = error.cause as { retryable?: unknown } | undefined;
    const hasRetryableDecision = cause && typeof cause.retryable === 'boolean';
    return {
      code: error.code,
      message: error.message,
      retryable: hasRetryableDecision
        ? cause.retryable === true
        : error.statusCode >= 500 || error.statusCode === 429
    };
  }

  return {
    code: 'generation_failed',
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}
