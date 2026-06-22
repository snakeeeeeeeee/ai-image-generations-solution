import { Agent } from 'undici';
import type { Job, Queue, Worker } from 'bullmq';
import type { AppConfig } from '../config.js';
import { createR2Client } from '../r2.js';
import { ActiveRequestLimiter } from '../limiter.js';
import { createImageTaskWorker, createRedisConnection, enqueueImageTask, RedisRateLimiter } from './queue.js';
import { buildProviderImageBody } from './request.js';
import type { AsyncTaskStore } from './store.js';
import type { AsyncTaskError, AsyncTaskRecord, TaskQueuePayload } from './types.js';
import { buildJsonUpstreamPayload, executeUpstreamPayload } from '../image-runner.js';
import { AppError } from '../errors.js';
import { uploadWithRetry } from '../upload-retry.js';
import { uploadImageToR2 } from '../r2.js';

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
  rateLimiter,
  imageProcessingLimiter,
  upstreamDispatcher,
  r2Client
}: {
  job: Job<TaskQueuePayload>;
  config: AppConfig;
  store: AsyncTaskStore;
  rateLimiter: RedisRateLimiter;
  imageProcessingLimiter: ActiveRequestLimiter;
  upstreamDispatcher: Agent;
  r2Client: ReturnType<typeof createR2Client>;
}): Promise<void> {
  const claimed = await store.claimTask(job.data.provider_task_id);
  if (!claimed) {
    return;
  }

  const taskRequest = taskRecordToRequest(claimed);
  const channelId = typeof claimed.metadata.channel_id === 'string' ? claimed.metadata.channel_id : undefined;

  try {
    await rateLimiter.waitForToken({
      provider: claimed.provider,
      model: claimed.model,
      channelId
    });

    const payload = await buildJsonUpstreamPayload({
      body: buildProviderImageBody(taskRequest),
      config
    });

    const releaseImageProcessing = await imageProcessingLimiter.acquire();
    try {
      const result = await executeUpstreamPayload({
        payload,
        authorization: config.upstream.apiKey ? `Bearer ${config.upstream.apiKey}` : undefined,
        config,
        operation: claimed.operation,
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
      const usagePayload = {
        total_tokens: 0,
        actual_quota: 0
      };
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

function taskRecordToRequest(task: AsyncTaskRecord) {
  return {
    request_id: task.request_id,
    client_task_id: task.client_task_id,
    provider: task.provider,
    model: task.model,
    operation: task.operation,
    input: task.input,
    parameters: task.parameters,
    provider_options: task.provider_options,
    callback: task.callback,
    metadata: task.metadata
  };
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

function toTaskError(error: unknown): AsyncTaskError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.statusCode >= 500 || error.statusCode === 429
    };
  }

  return {
    code: 'generation_failed',
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}
