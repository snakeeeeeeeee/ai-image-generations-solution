import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { sendAppError } from '../errors.js';
import { ActiveRequestLimiter } from '../limiter.js';
import { readBase64TaskResult } from './base64-result.js';
import { enqueueImageTask } from './queue.js';
import { authorizeProviderKey, normalizeAsyncTaskRequest } from './request.js';
import type { AsyncTaskStore } from './store.js';
import type { AsyncTaskRecord, AsyncTaskRequest, ResultDataFormat } from './types.js';
import type { Queue } from 'bullmq';
import type { TaskQueuePayload } from './types.js';

interface AsyncRoutesOptions {
  config: AppConfig;
  store: AsyncTaskStore;
  taskQueue: Queue<TaskQueuePayload>;
  base64ResultRedis?: Redis;
}

interface QueryBody {
  task_ids?: unknown;
}

export function registerAsyncTaskRoutes(app: FastifyInstance, options: AsyncRoutesOptions): void {
  const syncWaitLimiter = new ActiveRequestLimiter(options.config.asyncTasks.syncWaitConcurrency);

  app.post('/v1/image/tasks', async (request: FastifyRequest, reply) => {
    try {
      const providerApiKey = authorizeProviderKey(request.headers.authorization, options.config.asyncTasks.providerApiKeys);
      const taskRequest = withSubmissionMode(normalizeAsyncTaskRequest(request.body), 'async');
      assertAsyncResultDataFormatSupported(taskRequest.result_data_format);
      const result = await options.store.createTask(taskRequest, providerApiKey);
      if (result.created) {
        await enqueueImageTask(options.taskQueue, result.task.provider_task_id);
      }

      return reply.status(202).send({
        provider_task_id: result.task.provider_task_id,
        client_task_id: result.task.client_task_id,
        status: result.task.status
      });
    } catch (error) {
      return sendAppError(reply, error);
    }
  });

  app.post('/v1/image/tasks/sync', async (request: FastifyRequest, reply) => {
    let releaseWait: (() => void) | undefined;
    try {
      releaseWait = syncWaitLimiter.tryAcquire() ?? undefined;
      if (!releaseWait) {
        throw new AppError('Too many synchronous image task waits', {
          statusCode: 429,
          type: 'server_error',
          code: 'sync_wait_concurrency_exceeded'
        });
      }

      const providerApiKey = authorizeProviderKey(request.headers.authorization, options.config.asyncTasks.providerApiKeys);
      const taskRequest = withSubmissionMode(normalizeAsyncTaskRequest(request.body), 'sync_wait');
      const result = await options.store.createTask(taskRequest, providerApiKey);
      if (result.created) {
        await enqueueImageTask(options.taskQueue, result.task.provider_task_id);
      }

      const task = await waitForTaskTerminal({
        store: options.store,
        providerTaskId: result.task.provider_task_id,
        timeoutMs: options.config.asyncTasks.syncTaskTimeoutMs,
        pollIntervalMs: options.config.asyncTasks.syncTaskPollIntervalMs
      });

      const statusCode = task.status === 'succeeded' || task.status === 'failed' ? 200 : 202;
      const response = await formatSyncTaskResponse({
        task,
        requestedFormat: getTaskResultDataFormat(task),
        redis: options.base64ResultRedis,
        timeoutMs: options.config.asyncTasks.syncTaskTimeoutMs
      });
      return reply.status(statusCode).send({
        ...response,
        sync_wait: {
          completed: task.status === 'succeeded' || task.status === 'failed',
          timeout_ms: options.config.asyncTasks.syncTaskTimeoutMs
        }
      });
    } catch (error) {
      return sendAppError(reply, error);
    } finally {
      releaseWait?.();
    }
  });

  app.get('/v1/image/tasks/:providerTaskId', async (request: FastifyRequest<{ Params: { providerTaskId: string } }>, reply) => {
    try {
      authorizeProviderKey(request.headers.authorization, options.config.asyncTasks.providerApiKeys);
      const task = await options.store.getTask(request.params.providerTaskId);
      if (!task) {
        return reply.status(404).send({
          error: {
            message: 'Task not found',
            type: 'invalid_request_error',
            code: 'task_not_found'
          }
        });
      }
      return reply.send(formatTaskResponse(task));
    } catch (error) {
      return sendAppError(reply, error);
    }
  });

  app.post('/v1/image/tasks/query', async (request: FastifyRequest<{ Body: QueryBody }>, reply) => {
    try {
      authorizeProviderKey(request.headers.authorization, options.config.asyncTasks.providerApiKeys);
      const ids = parseTaskIds(request.body?.task_ids);
      const tasks = await options.store.getTasks(ids);
      const byId = new Map(tasks.map((task) => [task.provider_task_id, task]));
      return reply.send({
        data: ids.map((id) => {
          const task = byId.get(id);
          return task ? formatTaskResponse(task) : {
            task_id: id,
            provider_task_id: id,
            status: 'failed',
            progress: '100%',
            result: null,
            usage: null,
            error: {
              code: 'task_not_found',
              message: 'Task not found'
            }
          };
        })
      });
    } catch (error) {
      return sendAppError(reply, error);
    }
  });
}

function withSubmissionMode(taskRequest: AsyncTaskRequest, submissionMode: 'async' | 'sync_wait'): AsyncTaskRequest {
  return {
    ...taskRequest,
    metadata: {
      ...(taskRequest.metadata ?? {}),
      result_data_format: taskRequest.result_data_format,
      submission_mode: submissionMode
    }
  };
}

function assertAsyncResultDataFormatSupported(format: ResultDataFormat): void {
  if (format === 'url') {
    return;
  }

  throw new AppError('result_data_format=base64 is only supported by /v1/image/tasks/sync', {
    statusCode: 400,
    type: 'invalid_request_error',
    code: 'unsupported_result_data_format'
  });
}

function getTaskResultDataFormat(task: AsyncTaskRecord): ResultDataFormat {
  return task.metadata.result_data_format === 'base64' ? 'base64' : 'url';
}

async function formatSyncTaskResponse({
  task,
  requestedFormat,
  redis,
  timeoutMs
}: {
  task: AsyncTaskRecord;
  requestedFormat: ResultDataFormat;
  redis?: Redis;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const base = formatTaskResponse(task);
  if (requestedFormat !== 'base64' || task.status !== 'succeeded') {
    return requestedFormat === 'base64' ? {
      ...base,
      result_data_format: 'base64'
    } : base;
  }

  if (!redis) {
    throw new AppError('Base64 sync task result store is unavailable', {
      statusCode: 500,
      type: 'server_error',
      code: 'base64_result_store_unavailable'
    });
  }

  const base64Result = await readBase64TaskResult(redis, task.provider_task_id);
  if (!base64Result) {
    throw new AppError('Base64 sync task result is no longer available', {
      statusCode: 502,
      type: 'server_error',
      code: 'base64_result_not_available',
      cause: {
        timeout_ms: timeoutMs
      }
    });
  }

  return {
    ...base,
    result_data_format: 'base64',
    result: base64Result
  };
}

async function waitForTaskTerminal({
  store,
  providerTaskId,
  timeoutMs,
  pollIntervalMs
}: {
  store: AsyncTaskStore;
  providerTaskId: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<AsyncTaskRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastTask = await requireTask(store, providerTaskId);
  while (lastTask.status !== 'succeeded' && lastTask.status !== 'failed') {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return lastTask;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
    lastTask = await requireTask(store, providerTaskId);
  }
  return lastTask;
}

async function requireTask(store: AsyncTaskStore, providerTaskId: string): Promise<AsyncTaskRecord> {
  const task = await store.getTask(providerTaskId);
  if (!task) {
    throw new AppError('Task not found', {
      statusCode: 404,
      type: 'invalid_request_error',
      code: 'task_not_found'
    });
  }
  return task;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppError('task_ids must be an array', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_task_ids'
    });
  }
  const ids = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  if (ids.length === 0 || ids.length > 100) {
    throw new AppError('task_ids must contain 1 to 100 ids', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_task_ids'
    });
  }
  return ids;
}

export function formatTaskResponse(task: AsyncTaskRecord): Record<string, unknown> {
  return {
    task_id: task.provider_task_id,
    provider_task_id: task.provider_task_id,
    client_task_id: task.client_task_id,
    status: task.status,
    progress: task.status === 'succeeded' || task.status === 'failed' ? '100%' : task.status === 'processing' ? '50%' : '0%',
    result_data_format: 'url',
    result: task.result,
    usage: task.usage,
    error: task.error
  };
}
