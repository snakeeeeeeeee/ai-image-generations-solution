import { AppError } from '../errors.js';
import { PROVIDER_DIRECT_LEASE_EXECUTOR } from './types.js';
import type { AsyncTaskExecutor, AsyncTaskRequest, ResultDataFormat } from './types.js';

const SUPPORTED_OPERATIONS = new Set(['generation', 'edit']);

export function getBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined;
  }
  return token;
}

export function authorizeProviderKey(header: string | undefined, allowedKeys: string[]): string {
  const token = getBearerToken(header);
  if (!token) {
    throw new AppError('Missing image-handle Authorization bearer token', {
      statusCode: 401,
      type: 'invalid_request_error',
      code: 'missing_authorization'
    });
  }

  if (allowedKeys.length > 0 && !allowedKeys.includes(token)) {
    throw new AppError('Invalid image-handle API key', {
      statusCode: 401,
      type: 'invalid_request_error',
      code: 'invalid_provider_api_key'
    });
  }

  return token;
}

export function normalizeAsyncTaskRequest(body: unknown): AsyncTaskRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be a JSON object', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_request_body'
    });
  }

  const value = body as Record<string, unknown>;
  const requestId = requireString(value, 'request_id');
  const clientTaskId = requireString(value, 'client_task_id');
  const model = requireString(value, 'model');
  const operation = requireString(value, 'operation');
  const resultDataFormat = parseResultDataFormat(value.result_data_format);
  if (!SUPPORTED_OPERATIONS.has(operation)) {
    throw new AppError('Unsupported image task operation', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'unsupported_operation'
    });
  }

  const input = getObject(value.input, 'input');
  const parameters = getOptionalObject(value.parameters, 'parameters');
  const providerOptions = getOptionalObject(value.provider_options, 'provider_options');
  const executor = parseExecutor(value.executor);
  const callback = getOptionalObject(value.callback, 'callback');
  const metadata = getOptionalObject(value.metadata, 'metadata');

  if (typeof input.text !== 'string' || input.text.trim() === '') {
    throw new AppError('input.text is required', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'missing_input_text'
    });
  }

  return {
    request_id: requestId,
    client_task_id: clientTaskId,
    model,
    operation: operation as AsyncTaskRequest['operation'],
    result_data_format: resultDataFormat,
    input,
    parameters,
    provider_options: providerOptions,
    executor,
    callback,
    metadata
  };
}

export function parseResultDataFormat(value: unknown): ResultDataFormat {
  if (value === undefined || value === null || value === '') {
    return 'url';
  }

  if (value === 'url' || value === 'base64') {
    return value;
  }

  throw new AppError('result_data_format must be url or base64', {
    statusCode: 400,
    type: 'invalid_request_error',
    code: 'invalid_result_data_format'
  });
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.trim() === '') {
    throw new AppError(`${key} is required`, {
      statusCode: 400,
      type: 'invalid_request_error',
      code: `missing_${key}`
    });
  }
  return field.trim();
}

function getObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(`${name} must be an object`, {
      statusCode: 400,
      type: 'invalid_request_error',
      code: `invalid_${name}`
    });
  }
  return value as Record<string, unknown>;
}

function getOptionalObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  return getObject(value, name);
}

function parseExecutor(value: unknown): AsyncTaskExecutor {
  const executor = getObject(value, 'executor');
  const type = executor.type;
  if (type !== PROVIDER_DIRECT_LEASE_EXECUTOR) {
    throw new AppError('executor.type must be provider_direct_lease', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'unsupported_executor'
    });
  }

  const leaseId = requireString(executor, 'lease_id');
  const resolveUrl = requireString(executor, 'resolve_url');
  const secretId = requireString(executor, 'secret_id');
  validateResolveUrl(resolveUrl);

  return {
    ...executor,
    type: PROVIDER_DIRECT_LEASE_EXECUTOR,
    lease_id: leaseId,
    resolve_url: resolveUrl,
    secret_id: secretId
  };
}

function validateResolveUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError('executor.resolve_url must be a valid URL', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_resolve_url',
      cause: error
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('executor.resolve_url protocol is unsupported', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_resolve_url'
    });
  }
}
