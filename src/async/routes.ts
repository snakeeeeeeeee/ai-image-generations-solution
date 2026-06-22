import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { sendAppError } from '../errors.js';
import { enqueueImageTask } from './queue.js';
import { authorizeProviderKey, normalizeAsyncTaskRequest } from './request.js';
import type { AsyncTaskStore } from './store.js';
import type { AsyncTaskRecord } from './types.js';
import type { Queue } from 'bullmq';
import type { TaskQueuePayload } from './types.js';

interface AsyncRoutesOptions {
  config: AppConfig;
  store: AsyncTaskStore;
  taskQueue: Queue<TaskQueuePayload>;
}

interface QueryBody {
  task_ids?: unknown;
}

export function registerAsyncTaskRoutes(app: FastifyInstance, options: AsyncRoutesOptions): void {
  app.post('/v1/image/tasks', async (request: FastifyRequest, reply) => {
    try {
      const providerApiKey = authorizeProviderKey(request.headers.authorization, options.config.asyncTasks.providerApiKeys);
      const taskRequest = normalizeAsyncTaskRequest(request.body);
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
    result: task.result,
    usage: task.usage,
    error: task.error
  };
}
