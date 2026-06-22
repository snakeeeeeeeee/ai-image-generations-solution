export type AsyncTaskStatus = 'submitted' | 'queued' | 'processing' | 'succeeded' | 'failed';
export type AsyncTaskOperation = 'generation' | 'edit';
export const NEW_API_INTERNAL_EXECUTOR = 'new_api_internal';

export interface AsyncTaskInput {
  text?: string;
  images?: string[];
  mask?: string | null;
  [key: string]: unknown;
}

export interface AsyncTaskCallback {
  url?: string;
  batch_url?: string;
  secret_id?: string;
  [key: string]: unknown;
}

export interface NewApiInternalExecutor {
  type: typeof NEW_API_INTERNAL_EXECUTOR;
  execute_url: string;
  secret_id: string;
  [key: string]: unknown;
}

export type AsyncTaskExecutor = NewApiInternalExecutor;

export interface AsyncTaskRequest {
  request_id: string;
  client_task_id: string;
  model: string;
  operation: AsyncTaskOperation;
  input: AsyncTaskInput;
  parameters?: Record<string, unknown>;
  executor: AsyncTaskExecutor;
  callback?: AsyncTaskCallback;
  metadata?: Record<string, unknown>;
}

export interface AsyncTaskRecord {
  provider_task_id: string;
  client_task_id: string;
  request_id: string;
  provider_api_key_hash: string;
  provider: string;
  model: string;
  operation: AsyncTaskOperation;
  status: AsyncTaskStatus;
  input: AsyncTaskInput;
  parameters: Record<string, unknown>;
  provider_options: Record<string, unknown>;
  executor: AsyncTaskExecutor;
  callback: AsyncTaskCallback;
  metadata: Record<string, unknown>;
  result: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  error: AsyncTaskError | null;
  attempts: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  updated_at: string;
}

export interface AsyncTaskError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface TaskQueuePayload {
  provider_task_id: string;
}

export interface CallbackEventRecord {
  event_id: string;
  provider_task_id: string;
  client_task_id: string;
  callback_url: string;
  batch_callback_url?: string;
  secret_id?: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  attempts: number;
  next_attempt_at: string;
  delivered_at?: string;
  created_at: string;
  updated_at: string;
}

export interface TaskResultPayload {
  images: Array<{ url: string }>;
}
