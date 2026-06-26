import { randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import type { AsyncTaskRecord } from './types.js';

const WORKER_HEARTBEAT_PREFIX = 'image:runtime:worker:';

export interface WorkerCurrentTask {
  client_task_id: string;
  provider_task_id: string;
  operation: string;
  model: string;
  started_at: string;
}

export interface WorkerHeartbeat {
  worker_id: string;
  role: 'worker';
  hostname: string;
  ip_addresses: string[];
  pid: number;
  started_at: string;
  last_seen_at: string;
  worker_concurrency: number;
  image_processing_concurrency: number;
  active_tasks: number;
  completed_since_start: number;
  failed_since_start: number;
  rss_bytes: number;
  heap_used_bytes: number;
  last_error_code?: string;
  current_tasks: WorkerCurrentTask[];
}

export interface WorkerRuntimeState {
  readonly workerId: string;
  readonly startedAt: string;
  readonly currentTasks: Map<string, WorkerCurrentTask>;
  completedSinceStart: number;
  failedSinceStart: number;
  lastErrorCode?: string;
}

export function createWorkerRuntimeState(): WorkerRuntimeState {
  return {
    workerId: buildWorkerId(),
    startedAt: new Date().toISOString(),
    currentTasks: new Map(),
    completedSinceStart: 0,
    failedSinceStart: 0
  };
}

export function trackWorkerTaskStart(state: WorkerRuntimeState, task: AsyncTaskRecord): void {
  state.currentTasks.set(task.provider_task_id, {
    client_task_id: task.client_task_id,
    provider_task_id: task.provider_task_id,
    operation: task.operation,
    model: task.model,
    started_at: new Date().toISOString()
  });
}

export function trackWorkerTaskFinish(
  state: WorkerRuntimeState,
  providerTaskId: string,
  status: 'succeeded' | 'failed',
  errorCode?: string
): void {
  state.currentTasks.delete(providerTaskId);
  if (status === 'succeeded') {
    state.completedSinceStart += 1;
    return;
  }
  state.failedSinceStart += 1;
  state.lastErrorCode = errorCode;
}

export function trackWorkerTaskRetry(state: WorkerRuntimeState, providerTaskId: string, errorCode?: string): void {
  state.currentTasks.delete(providerTaskId);
  state.lastErrorCode = errorCode;
}

export async function writeWorkerHeartbeat({
  redis,
  config,
  state
}: {
  redis: Redis;
  config: AppConfig;
  state: WorkerRuntimeState;
}): Promise<void> {
  const memory = process.memoryUsage();
  const heartbeat: WorkerHeartbeat = {
    worker_id: state.workerId,
    role: 'worker',
    hostname: hostname(),
    ip_addresses: getIpAddresses(),
    pid: process.pid,
    started_at: state.startedAt,
    last_seen_at: new Date().toISOString(),
    worker_concurrency: config.asyncTasks.workerConcurrency,
    image_processing_concurrency: config.asyncTasks.imageProcessingConcurrency,
    active_tasks: state.currentTasks.size,
    completed_since_start: state.completedSinceStart,
    failed_since_start: state.failedSinceStart,
    rss_bytes: memory.rss,
    heap_used_bytes: memory.heapUsed,
    last_error_code: state.lastErrorCode,
    current_tasks: [...state.currentTasks.values()]
  };

  await redis.set(
    workerHeartbeatKey(state.workerId),
    JSON.stringify(heartbeat),
    'EX',
    config.asyncTasks.workerHeartbeatTtlSeconds
  );
}

export async function removeWorkerHeartbeat(redis: Redis, workerId: string): Promise<void> {
  await redis.del(workerHeartbeatKey(workerId));
}

export async function readWorkerHeartbeats(redis: Redis): Promise<WorkerHeartbeat[]> {
  const keys = await scanWorkerHeartbeatKeys(redis);
  if (keys.length === 0) {
    return [];
  }

  const values = await redis.mget(...keys);
  return values
    .map(parseWorkerHeartbeat)
    .filter((heartbeat): heartbeat is WorkerHeartbeat => heartbeat !== null)
    .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at));
}

function workerHeartbeatKey(workerId: string): string {
  return `${WORKER_HEARTBEAT_PREFIX}${workerId}`;
}

async function scanWorkerHeartbeatKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${WORKER_HEARTBEAT_PREFIX}*`, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

function parseWorkerHeartbeat(value: string | null): WorkerHeartbeat | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<WorkerHeartbeat>;
    if (
      typeof parsed.worker_id !== 'string' ||
      parsed.role !== 'worker' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.started_at !== 'string' ||
      typeof parsed.last_seen_at !== 'string'
    ) {
      return null;
    }
    return {
      worker_id: parsed.worker_id,
      role: 'worker',
      hostname: parsed.hostname,
      ip_addresses: Array.isArray(parsed.ip_addresses)
        ? parsed.ip_addresses.filter((item): item is string => typeof item === 'string')
        : [],
      pid: parsed.pid,
      started_at: parsed.started_at,
      last_seen_at: parsed.last_seen_at,
      worker_concurrency: numberOrZero(parsed.worker_concurrency),
      image_processing_concurrency: numberOrZero(parsed.image_processing_concurrency),
      active_tasks: numberOrZero(parsed.active_tasks),
      completed_since_start: numberOrZero(parsed.completed_since_start),
      failed_since_start: numberOrZero(parsed.failed_since_start),
      rss_bytes: numberOrZero(parsed.rss_bytes),
      heap_used_bytes: numberOrZero(parsed.heap_used_bytes),
      last_error_code: typeof parsed.last_error_code === 'string' ? parsed.last_error_code : undefined,
      current_tasks: Array.isArray(parsed.current_tasks)
        ? parsed.current_tasks.filter(isWorkerCurrentTask)
        : []
    };
  } catch {
    return null;
  }
}

function isWorkerCurrentTask(value: unknown): value is WorkerCurrentTask {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const task = value as Partial<WorkerCurrentTask>;
  return (
    typeof task.client_task_id === 'string' &&
    typeof task.provider_task_id === 'string' &&
    typeof task.operation === 'string' &&
    typeof task.model === 'string' &&
    typeof task.started_at === 'string'
  );
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getIpAddresses(): string[] {
  const addresses = new Set<string>();
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const item of interfaces ?? []) {
      if (item.internal || item.family !== 'IPv4') {
        continue;
      }
      addresses.add(item.address);
    }
  }
  return [...addresses].sort();
}

function buildWorkerId(): string {
  const safeHostname = hostname().replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return `${safeHostname}-${process.pid}-${randomUUID()}`;
}
