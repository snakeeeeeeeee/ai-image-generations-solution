import { createHash } from 'node:crypto';
import type { AsyncTaskRequest } from './types.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item !== undefined) {
      normalized[key] = canonicalize(item);
    }
  }
  return normalized;
}

export function semanticAsyncTaskRequest(request: AsyncTaskRequest): Record<string, unknown> {
  return {
    model: request.model,
    operation: request.operation,
    result_data_format: request.result_data_format,
    input: request.input ?? {},
    parameters: request.parameters ?? {},
    provider_options: request.provider_options ?? {}
  };
}

export function fingerprintAsyncTaskRequest(request: AsyncTaskRequest): string {
  const canonical = JSON.stringify(canonicalize(semanticAsyncTaskRequest(request)));
  return createHash('sha256').update(canonical).digest('hex');
}
