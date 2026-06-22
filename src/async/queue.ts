import { Queue, Worker, type JobsOptions, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import type { TaskQueuePayload } from './types.js';

export const IMAGE_TASK_QUEUE = 'image-tasks';

export interface QueueClients {
  connection: Redis;
  taskQueue: Queue<TaskQueuePayload>;
}

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });
}

export function createQueueClients(config: AppConfig): QueueClients {
  const connection = createRedisConnection(config.asyncTasks.redisUrl);
  return {
    connection,
    taskQueue: new Queue<TaskQueuePayload, void, string>(IMAGE_TASK_QUEUE, {
      connection: {
        url: config.asyncTasks.redisUrl
      }
    })
  };
}

export async function closeQueueClients(clients: QueueClients): Promise<void> {
  await clients.taskQueue.close();
  clients.connection.disconnect();
}

export async function enqueueImageTask(
  queue: Queue<TaskQueuePayload>,
  providerTaskId: string,
  options: JobsOptions = {}
): Promise<void> {
  const { jobId = providerTaskId, ...restOptions } = options;
  await queue.add(
    'image-task',
    { provider_task_id: providerTaskId },
    {
      jobId,
      attempts: 1,
      removeOnComplete: {
        age: 3600,
        count: 10000
      },
      removeOnFail: {
        age: 86400,
        count: 10000
      },
      ...restOptions
    }
  );
}

export function createImageTaskWorker(
  config: AppConfig,
  processor: Processor<TaskQueuePayload, void, string>
): Worker<TaskQueuePayload, void, string> {
  return new Worker<TaskQueuePayload, void, string>(IMAGE_TASK_QUEUE, processor, {
    connection: {
      url: config.asyncTasks.redisUrl
    },
    concurrency: config.asyncTasks.workerConcurrency
  });
}

export class RedisRateLimiter {
  constructor(private readonly redis: Redis, private readonly config: AppConfig) {}

  async waitForToken({
    provider,
    model,
    channelId
  }: {
    provider: string;
    model: string;
    channelId?: string;
  }): Promise<void> {
    const limit = this.getLimit({ provider, model, channelId });
    if (limit <= 0) {
      return;
    }

    const key = `rate:${provider}:${model}:${channelId || 'global'}`;
    const intervalMs = Math.max(1, Math.ceil(60_000 / limit));
    while (true) {
      const now = Date.now();
      const result = await this.redis.set(key, String(now), 'PX', intervalMs, 'NX');
      if (result === 'OK') {
        return;
      }
      const ttl = await this.redis.pttl(key);
      await sleep(Math.max(50, ttl > 0 ? ttl : intervalMs));
    }
  }

  private getLimit({
    provider,
    model,
    channelId
  }: {
    provider: string;
    model: string;
    channelId?: string;
  }): number {
    const config = this.config.asyncTasks.providerRateLimitConfig;
    return (
      config[`${provider}:${model}:${channelId || ''}`] ??
      config[`${provider}:${model}`] ??
      config[provider] ??
      this.config.asyncTasks.globalRateLimitIpm
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
