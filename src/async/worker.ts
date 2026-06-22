import { createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Agent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import type { Job, Queue, Worker } from 'bullmq';
import type { AppConfig } from '../config.js';
import { createR2Client } from '../r2.js';
import { ActiveRequestLimiter } from '../limiter.js';
import { createImageTaskWorker, createRedisConnection, enqueueImageTask, RedisRateLimiter } from './queue.js';
import type { AsyncTaskStore } from './store.js';
import type { AsyncTaskError, AsyncTaskRecord, TaskQueuePayload } from './types.js';
import { uploadImageSources } from '../image-runner.js';
import type { UploadImageToR2 } from '../image-runner.js';
import type { UpstreamDispatcher } from '../image-runner.js';
import { AppError } from '../errors.js';
import { uploadWithRetry } from '../upload-retry.js';
import { uploadImageToR2 } from '../r2.js';
import type { ImageSource } from '../image-strategy.js';

const MAX_INTERNAL_EXECUTE_ATTEMPTS = 3;

export interface AsyncWorkerRuntime {
  worker: Worker<TaskQueuePayload, void, string>;
  close: () => Promise<void>;
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

async function processTask({
  job,
  config,
  store,
  taskQueue,
  rateLimiter,
  imageProcessingLimiter,
  upstreamDispatcher,
  r2Client
}: {
  job: Job<TaskQueuePayload>;
  config: AppConfig;
  store: AsyncTaskStore;
  taskQueue: Queue<TaskQueuePayload>;
  rateLimiter: RedisRateLimiter;
  imageProcessingLimiter: ActiveRequestLimiter;
  upstreamDispatcher: Agent;
  r2Client: ReturnType<typeof createR2Client>;
}): Promise<void> {
  const claimed = await store.claimTask(job.data.provider_task_id);
  if (!claimed) {
    return;
  }

  const channelId = typeof claimed.metadata.channel_id === 'string' ? claimed.metadata.channel_id : undefined;

  try {
    await rateLimiter.waitForToken({
      provider: claimed.provider,
      model: claimed.model,
      channelId
    });

    const releaseImageProcessing = await imageProcessingLimiter.acquire();
    try {
      const result = await executeInternalTask({
        task: claimed,
        config,
        dispatcher: upstreamDispatcher,
        r2Client,
        upload: (args) => uploadWithRetry({
          ...args,
          upload: uploadImageToR2,
          requestId: claimed.provider_task_id,
          config,
          r2Client
        })
      });

      const resultPayload = {
        images: result.data
      };
      const usagePayload = result.usage;
      const callbackPayload = buildCallbackPayload({
        task: claimed,
        status: 'succeeded',
        result: resultPayload,
        usage: usagePayload,
        error: null
      });

      await store.completeTask({
        providerTaskId: claimed.provider_task_id,
        status: 'succeeded',
        result: resultPayload,
        usage: usagePayload,
        error: null,
        callbackPayload
      });
    } finally {
      releaseImageProcessing();
    }
  } catch (error) {
    const taskError = toTaskError(error);
    if (taskError.retryable && claimed.attempts < MAX_INTERNAL_EXECUTE_ATTEMPTS) {
      const retryDelayMs = internalRetryDelayMs(claimed.attempts);
      const queued = await store.retryTask(claimed.provider_task_id, taskError);
      if (queued) {
        await enqueueImageTask(taskQueue, claimed.provider_task_id, {
          delay: retryDelayMs,
          jobId: `${claimed.provider_task_id}:retry:${claimed.attempts}`
        });
        return;
      }
    }

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
        error: taskError
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
  error
}: {
  task: AsyncTaskRecord;
  status: 'succeeded' | 'failed';
  result: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  error: AsyncTaskError | null;
}): Record<string, unknown> {
  return {
    client_task_id: task.client_task_id,
    provider_task_id: task.provider_task_id,
    status,
    progress: '100%',
    result,
    usage,
    error
  };
}

interface InternalExecuteResponse {
  status?: unknown;
  images?: unknown;
  usage?: unknown;
  error?: unknown;
}

interface InternalExecuteResult {
  data: Array<{ url: string }>;
  usage: Record<string, unknown>;
}

async function executeInternalTask({
  task,
  config,
  dispatcher,
  r2Client,
  upload
}: {
  task: AsyncTaskRecord;
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
  r2Client: ReturnType<typeof createR2Client>;
  upload: UploadImageToR2;
}): Promise<InternalExecuteResult> {
  const response = await callInternalExecute({
    task,
    config,
    dispatcher
  });

  if (response.status === 'failed') {
    throw internalFailureToError(response.error);
  }
  if (response.status !== 'succeeded') {
    throw new AppError('new-api internal execute returned invalid status', {
      statusCode: 502,
      type: 'upstream_error',
      code: 'invalid_internal_execute_status',
      cause: response
    });
  }

  const sources = parseInternalImages(response.images);
  const uploaded = await uploadImageSources({
    sources,
    allowedFormats: ['png', 'jpeg', 'webp'],
    config,
    dispatcher,
    r2Client,
    upload
  });

  return {
    data: uploaded.data,
    usage: safeObject(response.usage)
  };
}

async function callInternalExecute({
  task,
  config,
  dispatcher
}: {
  task: AsyncTaskRecord;
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
}): Promise<InternalExecuteResponse> {
  const executeUrl = task.executor.execute_url;
  assertAllowedExecuteUrl(executeUrl, config);

  const rawBody = JSON.stringify({
    provider_task_id: task.provider_task_id,
    attempt: task.attempts
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const eventId = `evt_${randomUUID()}`;
  const secret = getInternalExecuteSecret(task, config);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstream.timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await undiciFetch(executeUrl, {
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
      throw new AppError('new-api internal execute returned an error', {
        statusCode: response.status,
        type: 'upstream_error',
        code: 'internal_execute_http_error',
        cause: {
          status_code: response.status,
          elapsed_ms: Math.round(performance.now() - startedAt),
          body
        }
      });
    }
    return body as InternalExecuteResponse;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AppError('new-api internal execute timed out', {
        statusCode: 504,
        type: 'server_error',
        code: 'internal_execute_timeout',
        cause: error
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function assertAllowedExecuteUrl(value: string, config: AppConfig): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError('executor.execute_url is invalid', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_execute_url',
      cause: error
    });
  }
  const allowed = config.asyncTasks.internalExecuteAllowedHosts;
  if (allowed.length > 0 && !allowed.includes(url.host)) {
    throw new AppError('executor.execute_url host is not allowed', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'execute_url_host_not_allowed',
      cause: {
        host: url.host,
        allowed_hosts: allowed
      }
    });
  }
}

function getInternalExecuteSecret(task: AsyncTaskRecord, config: AppConfig): string {
  const secret = config.asyncTasks.internalExecuteSecrets[task.executor.secret_id];
  if (!secret) {
    throw new AppError('Missing internal execute secret for executor.secret_id', {
      statusCode: 401,
      type: 'invalid_request_error',
      code: 'missing_internal_execute_secret'
    });
  }
  return secret;
}

function parseInternalImages(value: unknown): ImageSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError('new-api internal execute returned no image data', {
      statusCode: 502,
      type: 'server_error',
      code: 'empty_internal_execute_images'
    });
  }

  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppError('new-api internal execute image item is invalid', {
        statusCode: 502,
        type: 'server_error',
        code: 'invalid_internal_execute_image'
      });
    }
    const image = item as Record<string, unknown>;
    const b64Json = getString(image.b64_json);
    if (b64Json) {
      return {
        type: 'base64',
        value: b64Json,
        declaredMimeType: getString(image.mime_type)
      };
    }
    const url = getString(image.url);
    if (url) {
      return {
        type: 'url',
        value: url,
        declaredMimeType: getString(image.mime_type)
      };
    }
    throw new AppError('new-api internal execute image item has no url or b64_json', {
      statusCode: 502,
      type: 'server_error',
      code: 'missing_internal_execute_image_source'
    });
  });
}

function internalFailureToError(value: unknown): AppError {
  const error = safeObject(value);
  const code = getString(error.code) || 'internal_execute_failed';
  const message = getString(error.message) || 'new-api internal execute failed';
  const retryable = error.retryable === true;
  return new AppError(message, {
    statusCode: retryable ? 503 : 502,
    type: 'upstream_error',
    code,
    cause: {
      internalExecuteFailure: true,
      retryable
    }
  });
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function internalRetryDelayMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function toTaskError(error: unknown): AsyncTaskError {
  if (error instanceof AppError) {
    const cause = error.cause as { retryable?: unknown; internalExecuteFailure?: unknown } | undefined;
    return {
      code: error.code,
      message: error.message,
      retryable: cause?.internalExecuteFailure === true
        ? cause.retryable === true
        : cause?.retryable === true || error.statusCode >= 500 || error.statusCode === 429
    };
  }

  return {
    code: 'generation_failed',
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}
