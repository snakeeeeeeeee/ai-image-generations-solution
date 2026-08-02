import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import type { AsyncTaskRecord, TaskQueuePayload } from './types.js';
import { enqueueImageTask, type ImageTaskQueueRegistry } from './queue.js';
import type { AsyncTaskStore, SchedulingNode, TaskAssignmentResult } from './store.js';
import { aggregateWorkerNodes, readWorkerHeartbeats } from './worker-heartbeat.js';

const RECONCILE_BATCH_SIZE = 100;

interface SchedulerLogger {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
}

export interface TaskSchedulerLike {
  scheduleTask: (providerTaskId: string) => Promise<AsyncTaskRecord | undefined>;
  wakeTask?: (providerTaskId: string) => Promise<AsyncTaskRecord | undefined>;
}

export class TaskScheduler implements TaskSchedulerLike {
  private interval?: NodeJS.Timeout;
  private reconcilePromise?: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly store: AsyncTaskStore,
    private readonly redis: Redis,
    private readonly queues: ImageTaskQueueRegistry,
    private readonly logger: SchedulerLogger = consoleSchedulerLogger()
  ) {}

  start(): void {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      void this.reconcile();
    }, this.config.asyncTasks.workerHeartbeatIntervalMs);
    this.interval.unref();
  }

  async close(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    await this.reconcilePromise;
  }

  async scheduleTask(providerTaskId: string): Promise<AsyncTaskRecord | undefined> {
    const nodes = await this.readSchedulingNodes();
    const assignment = await this.store.assignTask(
      providerTaskId,
      nodes,
      this.config.asyncTasks.taskStaleProcessingTimeoutSeconds
    );
    if (!assignment) {
      return undefined;
    }
    if (assignment.changed) {
      this.logAssignment(assignment);
    }
    if (
      assignment.task.status === 'queued' &&
      assignment.task.assigned_node_id &&
      nodes.some((node) => node.nodeId === assignment.task.assigned_node_id)
    ) {
      await this.enqueueAssignment(assignment.task);
    }
    return assignment.task;
  }

  async wakeTask(providerTaskId: string): Promise<AsyncTaskRecord | undefined> {
    const task = await this.store.getTask(providerTaskId);
    if (!task?.assigned_node_id) {
      return task;
    }
    await this.enqueueAssignment(task);
    return task;
  }

  async reconcile(): Promise<void> {
    if (this.reconcilePromise) {
      return this.reconcilePromise;
    }
    this.reconcilePromise = this.runReconcile()
      .catch((error) => {
        this.logger.error({
          event: 'scheduler_reconcile_failed',
          error: error instanceof Error ? error.message : String(error)
        }, 'image task scheduler reconciliation failed');
      })
      .finally(() => {
        this.reconcilePromise = undefined;
      });
    return this.reconcilePromise;
  }

  private async runReconcile(): Promise<void> {
    const nodes = await this.readSchedulingNodes();
    if (nodes.length === 0) {
      return;
    }
    const taskIds = await this.store.getTasksNeedingAssignment(
      nodes.map((node) => node.nodeId),
      this.config.asyncTasks.taskStaleProcessingTimeoutSeconds,
      RECONCILE_BATCH_SIZE
    );
    for (const providerTaskId of taskIds) {
      const assignment = await this.store.assignTask(
        providerTaskId,
        nodes,
        this.config.asyncTasks.taskStaleProcessingTimeoutSeconds
      );
      if (!assignment?.changed) {
        continue;
      }
      this.logAssignment(assignment);
      await this.enqueueAssignment(assignment.task);
    }
  }

  private async readSchedulingNodes(): Promise<SchedulingNode[]> {
    const nodes = aggregateWorkerNodes(await readWorkerHeartbeats(this.redis));
    return nodes
      .filter((node) => !node.identity_conflict && node.effective_capacity > 0)
      .map((node) => ({
        nodeId: node.node_id,
        capacity: node.effective_capacity
      }));
  }

  private async enqueueAssignment(task: AsyncTaskRecord): Promise<void> {
    if (!task.assigned_node_id) {
      return;
    }
    const payload: TaskQueuePayload = {
      provider_task_id: task.provider_task_id,
      node_id: task.assigned_node_id,
      assignment_version: task.assignment_version
    };
    try {
      await enqueueImageTask(
        this.queues.get(task.assigned_node_id),
        payload,
        task.attempts
      );
    } catch (error) {
      this.logger.error({
        event: 'scheduler_enqueue_failed',
        provider_task_id: task.provider_task_id,
        node_id: task.assigned_node_id,
        assignment_version: task.assignment_version,
        error: error instanceof Error ? error.message : String(error)
      }, 'image task assignment enqueue failed');
    }
  }

  private logAssignment(assignment: TaskAssignmentResult): void {
    const details = {
      event: assignment.reason === 'submitted' ? 'task_assigned' : 'task_reassigned',
      provider_task_id: assignment.task.provider_task_id,
      node_id: assignment.task.assigned_node_id,
      previous_node_id: assignment.previousNodeId,
      assignment_version: assignment.task.assignment_version,
      reason: assignment.reason
    };
    if (assignment.reason === 'submitted') {
      this.logger.info(details, 'image task assigned to worker node');
      return;
    }
    this.logger.warn(details, 'image task reassigned to worker node');
  }
}

function consoleSchedulerLogger(): SchedulerLogger {
  return {
    info: (details, message) => console.info(message, details),
    warn: (details, message) => console.warn(message, details),
    error: (details, message) => console.error(message, details)
  };
}
