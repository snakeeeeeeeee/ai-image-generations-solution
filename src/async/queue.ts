import { Queue, Worker, type JobsOptions, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import type { TaskQueuePayload } from './types.js';

export const IMAGE_TASK_QUEUE_PREFIX = 'image-tasks-';

export interface QueueClients {
  connection: Redis;
  taskQueues: ImageTaskQueueRegistry;
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
    taskQueues: new ImageTaskQueueRegistry(config.asyncTasks.redisUrl)
  };
}

export async function closeQueueClients(clients: QueueClients): Promise<void> {
  await clients.taskQueues.close();
  clients.connection.disconnect();
}

export function imageTaskQueueName(nodeId: string): string {
  return `${IMAGE_TASK_QUEUE_PREFIX}${nodeId}`;
}

export function imageTaskJobId(payload: TaskQueuePayload, attempts: number): string {
  return `${payload.provider_task_id}-v${payload.assignment_version}-a${attempts}`;
}

export class ImageTaskQueueRegistry {
  private readonly queues = new Map<string, Queue<TaskQueuePayload, void, string>>();

  constructor(private readonly redisUrl: string) {}

  get(nodeId: string): Queue<TaskQueuePayload, void, string> {
    const existing = this.queues.get(nodeId);
    if (existing) {
      return existing;
    }
    const queue = new Queue<TaskQueuePayload, void, string>(imageTaskQueueName(nodeId), {
      connection: {
        url: this.redisUrl
      }
    });
    this.queues.set(nodeId, queue);
    return queue;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}

export async function enqueueImageTask(
  queue: Queue<TaskQueuePayload>,
  payload: TaskQueuePayload,
  attempts: number,
  options: JobsOptions = {}
): Promise<void> {
  const { jobId = imageTaskJobId(payload, attempts), ...restOptions } = options;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed') {
      await existing.retry();
      return;
    }
    if (state !== 'completed') {
      return;
    }
    await existing.remove();
  }
  await queue.add(
    'image-task',
    payload,
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
  nodeId: string,
  processor: Processor<TaskQueuePayload, void, string>
): Worker<TaskQueuePayload, void, string> {
  return new Worker<TaskQueuePayload, void, string>(imageTaskQueueName(nodeId), processor, {
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
