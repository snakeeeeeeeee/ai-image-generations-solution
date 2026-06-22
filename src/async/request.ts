import { AppError } from '../errors.js';
import type { ImageRequestBody } from '../image.js';
import type { AsyncTaskRequest } from './types.js';

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
    throw new AppError('Missing provider Authorization bearer token', {
      statusCode: 401,
      type: 'invalid_request_error',
      code: 'missing_authorization'
    });
  }

  if (allowedKeys.length > 0 && !allowedKeys.includes(token)) {
    throw new AppError('Invalid provider API key', {
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
  const provider = requireString(value, 'provider');
  const model = requireString(value, 'model');
  const operation = requireString(value, 'operation');
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
    provider,
    model,
    operation: operation as AsyncTaskRequest['operation'],
    input,
    parameters,
    provider_options: providerOptions,
    callback,
    metadata
  };
}

export function buildProviderImageBody(task: AsyncTaskRequest): ImageRequestBody {
  const body: ImageRequestBody = {
    ...task.parameters,
    ...task.provider_options,
    model: task.model,
    prompt: task.input.text
  };

  if (Array.isArray(task.input.images) && task.input.images.length > 0) {
    body.image = task.input.images.map((url) => ({ image_url: url }));
  }
  if (typeof task.input.mask === 'string' && task.input.mask.trim() !== '') {
    body.mask = {
      image_url: task.input.mask
    };
  }

  return body;
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
