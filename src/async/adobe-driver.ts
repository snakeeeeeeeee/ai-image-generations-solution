import { fetch as undiciFetch, type Agent } from 'undici';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { GeminiCredentialLease } from '../gemini-image.js';
import {
  ADOBE_ASYNC_IMAGE_DRIVER,
  type AsyncTaskError,
  type AsyncTaskRecord
} from './types.js';

export interface AdobeTaskState {
  taskId: string;
  clientTaskId?: string;
  status: string;
  progress: number;
  progressKnown: boolean;
  progressSource?: string;
  stage?: string;
  sequence: number;
  result: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  error: AsyncTaskError | null;
}

export interface AdobeAsyncLease extends GeminiCredentialLease {
  execution_driver?: string;
}

export function shouldUseAdobeAsyncDriver(
  task: AsyncTaskRecord,
  lease: AdobeAsyncLease,
  config: AppConfig
): boolean {
  if (config.asyncTasks.adobeAsyncImageEnabled === false) {
    return false;
  }
  if (lease.execution_driver !== ADOBE_ASYNC_IMAGE_DRIVER || task.operation !== 'generation') {
    return false;
  }
  if (task.metadata.result_data_format === 'base64') {
    return false;
  }
  const count = Number(task.parameters.n ?? 1);
  return Number.isSafeInteger(count) && count === 1;
}

export async function submitAdobeImageTask({
  task,
  lease,
  config,
  dispatcher
}: {
  task: AsyncTaskRecord;
  lease: AdobeAsyncLease;
  config: AppConfig;
  dispatcher: Agent;
}): Promise<AdobeTaskState> {
  const callbackBase = config.asyncTasks.adobeAsyncCallbackBaseUrl?.replace(/\/+$/, '') ?? '';
  const callback = callbackBase
    ? {
        url: `${callbackBase}/internal/adobe/image-task-callback`,
        secret_id: config.asyncTasks.adobeAsyncCallbackSecretId || 'adobe2api'
      }
    : undefined;
  const response = await requestJson(
    imageTaskUrl(lease.base_url, ''),
    lease.api_key,
    {
      client_task_id: task.provider_task_id,
      model: lease.model || task.model,
      input: { text: task.input.text },
      parameters: {
        ...task.parameters,
        n: 1,
        response_format: 'url'
      },
      ...(callback ? { callback } : {})
    },
    dispatcher
  );
  return parseAdobeTaskState(response);
}

export async function queryAdobeImageTasks({
  baseUrl,
  apiKey,
  taskIds,
  dispatcher
}: {
  baseUrl: string;
  apiKey: string;
  taskIds: string[];
  dispatcher: Agent;
}): Promise<AdobeTaskState[]> {
  if (taskIds.length === 0) {
    return [];
  }
  const response = await requestJson(
    imageTaskUrl(baseUrl, '/query'),
    apiKey,
    { task_ids: taskIds.slice(0, 100) },
    dispatcher
  );
  const data = Array.isArray(response.data) ? response.data : [];
  return data.map(parseAdobeTaskState);
}

export function parseAdobeTaskState(value: unknown): AdobeTaskState {
  const body = safeObject(value);
  const taskId = getString(body.task_id) || getString(body.id);
  if (!taskId) {
    throw new AppError('Async image task response is missing task_id', {
      statusCode: 502,
      type: 'server_error',
      code: 'invalid_async_image_response',
      cause: { retryable: false }
    });
  }
  const status = (getString(body.status) || 'queued').toLowerCase();
  const progress = clampProgress(body.progress);
  const errorBody = safeObject(body.error);
  const error = Object.keys(errorBody).length > 0
    ? {
        code: getString(errorBody.code) || 'generation_failed',
        message: sanitizeUpstreamMessage(getString(errorBody.message) || 'Upstream image generation failed'),
        retryable: false
      }
    : null;
  return {
    taskId,
    clientTaskId: getString(body.client_task_id),
    status,
    progress,
    progressKnown: body.progress_known === true,
    progressSource: getString(body.progress_source),
    stage: getString(body.stage),
    sequence: Math.max(0, toInteger(body.sequence)),
    result: nullableObject(body.result),
    usage: nullableObject(body.usage),
    error
  };
}

export function buildAdobeProgressCallbackPayload(
  task: AsyncTaskRecord,
  state: AdobeTaskState
): Record<string, unknown> {
  const failed = state.status === 'failed' || state.status === 'submission_unknown';
  return {
    client_task_id: task.client_task_id,
    provider_task_id: task.provider_task_id,
    status: failed ? 'failed' : 'processing',
    progress: `${Math.round(state.progress)}%`,
    progress_known: state.progressKnown,
    progress_source: state.progressSource || 'upstream_status',
    stage: state.status === 'completed' ? 'finalizing' : (state.stage || 'upstream_processing'),
    sequence: state.sequence,
    result_data_format: 'url',
    result: null,
    usage: state.usage,
    error: failed ? (state.error || {
      code: state.status === 'submission_unknown' ? 'submission_unknown' : 'generation_failed',
      message: 'Upstream image generation failed',
      retryable: false
    }) : null
  };
}

function imageTaskUrl(baseUrl: string, suffix: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/v1')
    ? `${normalized}/image/tasks${suffix}`
    : `${normalized}/v1/image/tasks${suffix}`;
}

async function requestJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  dispatcher: Agent
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await undiciFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      dispatcher
    });
    const text = await response.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AppError('Async image upstream returned invalid JSON', {
          statusCode: 502,
          type: 'server_error',
          code: 'invalid_async_image_response',
          cause: { retryable: response.status >= 500 }
        });
      }
    }
    if (!response.ok) {
      const errorBody = safeObject(safeObject(parsed).error);
      throw new AppError(
        sanitizeUpstreamMessage(getString(errorBody.message) || `Async image request failed with status ${response.status}`),
        {
          statusCode: response.status,
          type: response.status >= 500 ? 'server_error' : 'upstream_error',
          code: getString(errorBody.code) || 'async_image_http_error',
          cause: {
            retryable: response.status === 408 || response.status === 429 || response.status >= 500
          }
        }
      );
    }
    return safeObject(parsed);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AppError('Async image request timed out before acceptance was confirmed', {
        statusCode: 504,
        type: 'server_error',
        code: 'async_image_submission_unknown',
        cause: { retryable: true }
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeUpstreamMessage(value: string): string {
  return value.replace(/\bAdobe\b/gi, 'upstream').trim();
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableObject(value: unknown): Record<string, unknown> | null {
  const parsed = safeObject(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function toInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? 0), 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function clampProgress(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseFloat(String(value ?? 0).replace('%', ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
}
