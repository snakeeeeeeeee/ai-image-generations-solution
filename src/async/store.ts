import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  AsyncTaskCallback,
  AsyncTaskError,
  AsyncTaskRecord,
  AsyncTaskRequest,
  AsyncTaskStatus,
  CallbackEventRecord
} from './types.js';

const { Pool } = pg;
const MIGRATION_LOCK_ID = 2026062201;

type PoolClient = pg.PoolClient;

interface TaskRow {
  provider_task_id: string;
  client_task_id: string;
  request_id: string;
  provider_api_key_hash: string;
  provider: string;
  model: string;
  operation: 'generation' | 'edit';
  status: AsyncTaskStatus;
  input_json: unknown;
  parameters_json: unknown;
  provider_options_json: unknown;
  callback_json: unknown;
  metadata_json: unknown;
  result_json: unknown | null;
  usage_json: unknown | null;
  error_json: unknown | null;
  attempts: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

interface CallbackRow {
  event_id: string;
  provider_task_id: string;
  client_task_id: string;
  callback_url: string;
  batch_callback_url: string | null;
  secret_id: string | null;
  payload_json: unknown;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  attempts: number;
  next_attempt_at: Date;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTaskResult {
  task: AsyncTaskRecord;
  created: boolean;
}

export interface AdminAsyncTaskSummary {
  total: number;
  submitted: number;
  queued: number;
  processing: number;
  succeeded: number;
  failed: number;
  lastCreatedAt?: string;
  lastUpdatedAt?: string;
}

export interface AdminAsyncTaskRecord {
  provider_task_id: string;
  client_task_id: string;
  request_id: string;
  provider: string;
  model: string;
  operation: 'generation' | 'edit';
  status: AsyncTaskStatus;
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
  attempts: number;
  image_count: number;
  first_image_url?: string;
  error_code?: string;
  error_message?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  updated_at: string;
}

export interface AdminCallbackSummary {
  total: number;
  pending: number;
  processing: number;
  delivered: number;
  failed: number;
  lastCreatedAt?: string;
  lastUpdatedAt?: string;
}

export interface AdminCallbackEventRecord {
  event_id: string;
  provider_task_id: string;
  client_task_id: string;
  callback_url: string;
  batch_callback_url?: string;
  secret_id?: string;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  attempts: number;
  next_attempt_at: string;
  delivered_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AdminPage<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export class AsyncTaskStore {
  readonly pool: pg.Pool;

  constructor(postgresUrl: string) {
    this.pool = new Pool({
      connectionString: postgresUrl
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS image_tasks (
          provider_task_id TEXT PRIMARY KEY,
          client_task_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          provider_api_key_hash TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          operation TEXT NOT NULL,
          status TEXT NOT NULL,
          input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          parameters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          provider_options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          callback_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          result_json JSONB,
          usage_json JSONB,
          error_json JSONB,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (provider_api_key_hash, client_task_id)
        );

        CREATE INDEX IF NOT EXISTS idx_image_tasks_status_updated_at
          ON image_tasks(status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_image_tasks_client_task_id
          ON image_tasks(client_task_id);

        CREATE TABLE IF NOT EXISTS callback_events (
          event_id TEXT PRIMARY KEY,
          provider_task_id TEXT NOT NULL REFERENCES image_tasks(provider_task_id) ON DELETE CASCADE,
          client_task_id TEXT NOT NULL,
          callback_url TEXT NOT NULL,
          batch_callback_url TEXT,
          secret_id TEXT,
          payload_json JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          delivered_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS idx_callback_events_status_next_attempt
          ON callback_events(status, next_attempt_at);
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createTask(request: AsyncTaskRequest, providerApiKey: string): Promise<CreateTaskResult> {
    const providerTaskId = `imgtask_${randomUUID()}`;
    const keyHash = hashProviderApiKey(providerApiKey);
    const result = await this.pool.query<TaskRow>(`
      INSERT INTO image_tasks (
        provider_task_id,
        client_task_id,
        request_id,
        provider_api_key_hash,
        provider,
        model,
        operation,
        status,
        input_json,
        parameters_json,
        provider_options_json,
        callback_json,
        metadata_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10, $11, $12
      )
      ON CONFLICT (provider_api_key_hash, client_task_id) DO NOTHING
      RETURNING *
    `, [
      providerTaskId,
      request.client_task_id,
      request.request_id,
      keyHash,
      request.provider,
      request.model,
      request.operation,
      request.input ?? {},
      request.parameters ?? {},
      request.provider_options ?? {},
      request.callback ?? {},
      request.metadata ?? {}
    ]);

    if (result.rows[0]) {
      return {
        task: mapTaskRow(result.rows[0]),
        created: true
      };
    }

    const existing = await this.getTaskByClientTaskId(keyHash, request.client_task_id);
    if (!existing) {
      throw new Error('Task idempotency conflict could not be loaded');
    }

    return {
      task: existing,
      created: false
    };
  }

  async getTask(providerTaskId: string): Promise<AsyncTaskRecord | undefined> {
    const result = await this.pool.query<TaskRow>('SELECT * FROM image_tasks WHERE provider_task_id = $1', [providerTaskId]);
    return result.rows[0] ? mapTaskRow(result.rows[0]) : undefined;
  }

  async getTasks(providerTaskIds: string[]): Promise<AsyncTaskRecord[]> {
    if (providerTaskIds.length === 0) {
      return [];
    }
    const result = await this.pool.query<TaskRow>(
      'SELECT * FROM image_tasks WHERE provider_task_id = ANY($1::text[]) ORDER BY created_at ASC',
      [providerTaskIds]
    );
    return result.rows.map(mapTaskRow);
  }

  async claimTask(providerTaskId: string): Promise<AsyncTaskRecord | undefined> {
    const result = await this.pool.query<TaskRow>(`
      UPDATE image_tasks
      SET status = 'processing',
          attempts = attempts + 1,
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE provider_task_id = $1
        AND status IN ('submitted', 'queued')
      RETURNING *
    `, [providerTaskId]);
    return result.rows[0] ? mapTaskRow(result.rows[0]) : undefined;
  }

  async completeTask({
    providerTaskId,
    status,
    result,
    usage,
    error,
    callbackPayload
  }: {
    providerTaskId: string;
    status: 'succeeded' | 'failed';
    result: Record<string, unknown> | null;
    usage: Record<string, unknown> | null;
    error: AsyncTaskError | null;
    callbackPayload: Record<string, unknown> | null;
  }): Promise<AsyncTaskRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<TaskRow>(`
        UPDATE image_tasks
        SET status = $2,
            result_json = $3,
            usage_json = $4,
            error_json = $5,
            finished_at = now(),
            updated_at = now()
        WHERE provider_task_id = $1
          AND status NOT IN ('succeeded', 'failed')
        RETURNING *
      `, [providerTaskId, status, result, usage, error]);

      const row = updated.rows[0];
      if (row && callbackPayload) {
        const callback = safeObject(row.callback_json) as AsyncTaskCallback;
        if (typeof callback.url === 'string' && callback.url.trim() !== '') {
          await this.insertCallbackEvent(client, {
            task: row,
            callback,
            payload: callbackPayload
          });
        }
      }

      await client.query('COMMIT');
      return row ? mapTaskRow(row) : undefined;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async requeueStaleProcessing(timeoutSeconds: number): Promise<string[]> {
    const result = await this.pool.query<{ provider_task_id: string }>(`
      UPDATE image_tasks
      SET status = 'queued',
          updated_at = now()
      WHERE status = 'processing'
        AND updated_at < now() - ($1::int * interval '1 second')
      RETURNING provider_task_id
    `, [timeoutSeconds]);
    return result.rows.map((row) => row.provider_task_id);
  }

  async getQueuedTaskIds(limit: number): Promise<string[]> {
    const result = await this.pool.query<{ provider_task_id: string }>(`
      SELECT provider_task_id
      FROM image_tasks
      WHERE status IN ('submitted', 'queued')
      ORDER BY created_at ASC
      LIMIT $1
    `, [limit]);
    return result.rows.map((row) => row.provider_task_id);
  }

  async getAdminTaskSummary(): Promise<AdminAsyncTaskSummary> {
    const result = await this.pool.query<{
      status: AsyncTaskStatus;
      count: string;
      last_created_at: Date | null;
      last_updated_at: Date | null;
    }>(`
      SELECT
        status,
        COUNT(*)::text AS count,
        MAX(created_at) AS last_created_at,
        MAX(updated_at) AS last_updated_at
      FROM image_tasks
      GROUP BY status
    `);
    const summary: AdminAsyncTaskSummary = {
      total: 0,
      submitted: 0,
      queued: 0,
      processing: 0,
      succeeded: 0,
      failed: 0
    };

    for (const row of result.rows) {
      const count = Number.parseInt(row.count, 10);
      summary.total += count;
      summary[row.status] = count;
      summary.lastCreatedAt = maxIso(summary.lastCreatedAt, dateToIso(row.last_created_at));
      summary.lastUpdatedAt = maxIso(summary.lastUpdatedAt, dateToIso(row.last_updated_at));
    }

    return summary;
  }

  async getAdminTasksPage(page: number, pageSize: number): Promise<AdminPage<AdminAsyncTaskRecord>> {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const totalRow = await this.pool.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM image_tasks');
    const total = Number.parseInt(totalRow.rows[0]?.total ?? '0', 10);
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const currentPage = Math.min(safePage, totalPages);
    const offset = (currentPage - 1) * safePageSize;
    const result = await this.pool.query<TaskRow>(`
      SELECT *
      FROM image_tasks
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [safePageSize, offset]);

    return {
      data: result.rows.map(mapAdminTaskRow),
      page: currentPage,
      pageSize: safePageSize,
      total,
      totalPages
    };
  }

  async getAdminCallbackSummary(): Promise<AdminCallbackSummary> {
    const result = await this.pool.query<{
      status: 'pending' | 'processing' | 'delivered' | 'failed';
      count: string;
      last_created_at: Date | null;
      last_updated_at: Date | null;
    }>(`
      SELECT
        status,
        COUNT(*)::text AS count,
        MAX(created_at) AS last_created_at,
        MAX(updated_at) AS last_updated_at
      FROM callback_events
      GROUP BY status
    `);
    const summary: AdminCallbackSummary = {
      total: 0,
      pending: 0,
      processing: 0,
      delivered: 0,
      failed: 0
    };

    for (const row of result.rows) {
      const count = Number.parseInt(row.count, 10);
      summary.total += count;
      summary[row.status] = count;
      summary.lastCreatedAt = maxIso(summary.lastCreatedAt, dateToIso(row.last_created_at));
      summary.lastUpdatedAt = maxIso(summary.lastUpdatedAt, dateToIso(row.last_updated_at));
    }

    return summary;
  }

  async getAdminCallbackEventsPage(page: number, pageSize: number): Promise<AdminPage<AdminCallbackEventRecord>> {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const totalRow = await this.pool.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM callback_events');
    const total = Number.parseInt(totalRow.rows[0]?.total ?? '0', 10);
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const currentPage = Math.min(safePage, totalPages);
    const offset = (currentPage - 1) * safePageSize;
    const result = await this.pool.query<CallbackRow>(`
      SELECT *
      FROM callback_events
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [safePageSize, offset]);

    return {
      data: result.rows.map(mapAdminCallbackRow),
      page: currentPage,
      pageSize: safePageSize,
      total,
      totalPages
    };
  }

  async claimCallbackEvents(limit: number): Promise<CallbackEventRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<CallbackRow>(`
        SELECT *
        FROM callback_events
        WHERE status IN ('pending', 'processing')
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `, [limit]);
      const ids = result.rows.map((row) => row.event_id);
      if (ids.length > 0) {
        await client.query(`
          UPDATE callback_events
          SET status = 'processing',
              attempts = attempts + 1,
              next_attempt_at = now() + interval '5 minutes',
              updated_at = now()
          WHERE event_id = ANY($1::text[])
        `, [ids]);
      }
      await client.query('COMMIT');
      return result.rows.map((row) => mapCallbackRow({
        ...row,
        attempts: row.attempts + 1,
        status: 'processing'
      }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markCallbackDelivered(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    await this.pool.query(`
      UPDATE callback_events
      SET status = 'delivered',
          delivered_at = now(),
          updated_at = now()
      WHERE event_id = ANY($1::text[])
    `, [eventIds]);
  }

  async rescheduleCallbackEvents(eventIds: string[], delayMs: number, maxRetryAgeHours: number): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    await this.pool.query(`
      UPDATE callback_events
      SET status = CASE
            WHEN created_at < now() - ($3::int * interval '1 hour') THEN 'failed'
            ELSE 'pending'
          END,
          next_attempt_at = now() + ($2::int * interval '1 millisecond'),
          updated_at = now()
      WHERE event_id = ANY($1::text[])
    `, [eventIds, delayMs, maxRetryAgeHours]);
  }

  private async insertCallbackEvent(
    client: PoolClient,
    {
      task,
      callback,
      payload
    }: {
      task: TaskRow;
      callback: AsyncTaskCallback;
      payload: Record<string, unknown>;
    }
  ): Promise<void> {
    await client.query(`
      INSERT INTO callback_events (
        event_id,
        provider_task_id,
        client_task_id,
        callback_url,
        batch_callback_url,
        secret_id,
        payload_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      `evt_${randomUUID()}`,
      task.provider_task_id,
      task.client_task_id,
      callback.url,
      callback.batch_url ?? null,
      callback.secret_id ?? null,
      payload
    ]);
  }

  private async getTaskByClientTaskId(providerApiKeyHash: string, clientTaskId: string): Promise<AsyncTaskRecord | undefined> {
    const result = await this.pool.query<TaskRow>(`
      SELECT *
      FROM image_tasks
      WHERE provider_api_key_hash = $1
        AND client_task_id = $2
    `, [providerApiKeyHash, clientTaskId]);
    return result.rows[0] ? mapTaskRow(result.rows[0]) : undefined;
  }
}

export function hashProviderApiKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function dateToIso(value: Date | null): string | undefined {
  return value ? value.toISOString() : undefined;
}

function maxIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return right > left ? right : left;
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapTaskRow(row: TaskRow): AsyncTaskRecord {
  return {
    provider_task_id: row.provider_task_id,
    client_task_id: row.client_task_id,
    request_id: row.request_id,
    provider_api_key_hash: row.provider_api_key_hash,
    provider: row.provider,
    model: row.model,
    operation: row.operation,
    status: row.status,
    input: safeObject(row.input_json),
    parameters: safeObject(row.parameters_json),
    provider_options: safeObject(row.provider_options_json),
    callback: safeObject(row.callback_json),
    metadata: safeObject(row.metadata_json),
    result: row.result_json ? safeObject(row.result_json) : null,
    usage: row.usage_json ? safeObject(row.usage_json) : null,
    error: row.error_json ? safeObject(row.error_json) as unknown as AsyncTaskError : null,
    attempts: row.attempts,
    created_at: row.created_at.toISOString(),
    started_at: dateToIso(row.started_at),
    finished_at: dateToIso(row.finished_at),
    updated_at: row.updated_at.toISOString()
  };
}

function mapAdminTaskRow(row: TaskRow): AdminAsyncTaskRecord {
  const result = safeObject(row.result_json);
  const error = row.error_json ? safeObject(row.error_json) as unknown as AsyncTaskError : null;
  const images = Array.isArray(result.images) ? result.images : [];
  const firstImage = images.find((item): item is { url: string } => (
    item !== null &&
    typeof item === 'object' &&
    typeof (item as { url?: unknown }).url === 'string'
  ));

  return {
    provider_task_id: row.provider_task_id,
    client_task_id: row.client_task_id,
    request_id: row.request_id,
    provider: row.provider,
    model: row.model,
    operation: row.operation,
    status: row.status,
    parameters: safeObject(row.parameters_json),
    metadata: safeObject(row.metadata_json),
    attempts: row.attempts,
    image_count: images.length,
    first_image_url: firstImage?.url,
    error_code: error?.code,
    error_message: error?.message,
    created_at: row.created_at.toISOString(),
    started_at: dateToIso(row.started_at),
    finished_at: dateToIso(row.finished_at),
    updated_at: row.updated_at.toISOString()
  };
}

function mapCallbackRow(row: CallbackRow): CallbackEventRecord {
  return {
    event_id: row.event_id,
    provider_task_id: row.provider_task_id,
    client_task_id: row.client_task_id,
    callback_url: row.callback_url,
    batch_callback_url: row.batch_callback_url ?? undefined,
    secret_id: row.secret_id ?? undefined,
    payload: safeObject(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at.toISOString(),
    delivered_at: dateToIso(row.delivered_at),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString()
  };
}

function mapAdminCallbackRow(row: CallbackRow): AdminCallbackEventRecord {
  return {
    event_id: row.event_id,
    provider_task_id: row.provider_task_id,
    client_task_id: row.client_task_id,
    callback_url: row.callback_url,
    batch_callback_url: row.batch_callback_url ?? undefined,
    secret_id: row.secret_id ?? undefined,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at.toISOString(),
    delivered_at: dateToIso(row.delivered_at),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString()
  };
}
