import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { AdminConfig } from './admin/types.js';

const DEFAULT_BODY_LIMIT_BYTES = 100 * 1024 * 1024;

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  bodyLimitBytes: number;
  role: AppRole;
  limits: {
    maxConcurrentGenerations: number;
    maxConcurrentImageProcessing: number;
    maxProcessRssBytes: number;
  };
  upstream: {
    baseUrl: string;
    imagesPath: string;
    imageEditsPath: string;
    timeoutMs: number;
    apiKey?: string;
  };
  defaults: {
    size: string;
    outputFormat: ImageOutputFormat;
  };
  upload: {
    maxRetries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  };
  cors: {
    allowedOrigins: string[];
    maxAgeSeconds: number;
  };
  r2: R2Config;
  admin: AdminConfig;
  asyncTasks: AsyncTaskConfig;
}

export type AppRole = 'api' | 'worker' | 'notifier' | 'all';
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp';

export interface R2Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
  keyPrefix: string;
  cacheControl: string;
  forcePathStyle: boolean;
}

export interface AsyncTaskConfig {
  postgresUrl: string;
  redisUrl: string;
  providerApiKeys: string[];
  workerConcurrency: number;
  imageProcessingConcurrency: number;
  globalRateLimitIpm: number;
  providerRateLimitConfig: Record<string, number>;
  callbackBatchSize: number;
  callbackFlushMs: number;
  callbackMaxRetryAgeHours: number;
  callbackDefaultSecret: string;
  callbackSecrets: Record<string, string>;
  taskStaleProcessingTimeoutSeconds: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = optionalEnv(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${raw}`);
  }
  return value;
}

function parseMegabytes(name: string, fallback: number): number {
  return parsePositiveInt(name, fallback) * 1024 * 1024;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizePath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

function normalizeBasePath(value: string): string {
  const normalized = normalizePath(value).replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

function normalizeRole(value: string): AppRole {
  const normalized = value.toLowerCase();
  if (normalized === 'api' || normalized === 'worker' || normalized === 'notifier' || normalized === 'all') {
    return normalized;
  }
  throw new Error(`IMAGE_HANDLE_ROLE must be api, worker, notifier, or all; received: ${value}`);
}

function normalizeOutputFormat(value: string): ImageOutputFormat {
  const normalized = value.toLowerCase();
  if (normalized === 'png' || normalized === 'jpeg' || normalized === 'webp') {
    return normalized;
  }
  throw new Error(`DEFAULT_OUTPUT_FORMAT must be png, jpeg, or webp; received: ${value}`);
}

function parseCsvEnv(name: string, fallback: string): string[] {
  return optionalEnv(name, fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name, fallback ? 'true' : 'false').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }
  throw new Error(`Invalid boolean for ${name}: ${value}`);
}

function parseJsonObjectEnv(name: string, fallback: string): Record<string, unknown> {
  const raw = optionalEnv(name, fallback);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON object for ${name}: ${raw}`, { cause: error });
  }
}

function parseNumberMapEnv(name: string, fallback: string): Record<string, number> {
  const raw = parseJsonObjectEnv(name, fallback);
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid positive number for ${name}.${key}: ${String(value)}`);
    }
    result[key] = parsed;
  }
  return result;
}

function parseStringMapEnv(name: string, fallback: string): Record<string, string> {
  const raw = parseJsonObjectEnv(name, fallback);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new Error(`Invalid string for ${name}.${key}: ${String(value)}`);
    }
    result[key] = value;
  }
  return result;
}

export function loadConfig(): AppConfig {
  return {
    port: parsePositiveInt('PORT', 8787),
    host: optionalEnv('HOST', '0.0.0.0'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    bodyLimitBytes: parsePositiveInt('REQUEST_BODY_LIMIT_BYTES', DEFAULT_BODY_LIMIT_BYTES),
    role: normalizeRole(optionalEnv('IMAGE_HANDLE_ROLE', 'api')),
    limits: {
      maxConcurrentGenerations: parsePositiveInt('MAX_CONCURRENT_GENERATIONS', 1000),
      maxConcurrentImageProcessing: parsePositiveInt('MAX_CONCURRENT_IMAGE_PROCESSING', 50),
      maxProcessRssBytes: parseMegabytes('MAX_PROCESS_RSS_MB', 28 * 1024)
    },
    upstream: {
      baseUrl: normalizeBaseUrl(requireEnv('NEW_API_BASE_URL')),
      imagesPath: normalizePath(optionalEnv('NEW_API_IMAGES_PATH', '/v1/images/generations')),
      imageEditsPath: normalizePath(optionalEnv('NEW_API_IMAGES_EDITS_PATH', '/v1/images/edits')),
      timeoutMs: parsePositiveInt('UPSTREAM_TIMEOUT_MS', 30 * 60 * 1000),
      apiKey: optionalEnv('UPSTREAM_API_KEY', '') || undefined
    },
    defaults: {
      size: optionalEnv('DEFAULT_IMAGE_SIZE', '2560x1440'),
      outputFormat: normalizeOutputFormat(optionalEnv('DEFAULT_OUTPUT_FORMAT', 'png'))
    },
    upload: {
      maxRetries: parsePositiveInt('R2_UPLOAD_MAX_RETRIES', 3),
      retryBaseDelayMs: parsePositiveInt('R2_UPLOAD_RETRY_BASE_DELAY_MS', 300),
      retryMaxDelayMs: parsePositiveInt('R2_UPLOAD_RETRY_MAX_DELAY_MS', 3000)
    },
    cors: {
      allowedOrigins: parseCsvEnv('CORS_ALLOWED_ORIGINS', '*'),
      maxAgeSeconds: parsePositiveInt('CORS_MAX_AGE_SECONDS', 86400)
    },
    r2: {
      endpoint: normalizeBaseUrl(requireEnv('R2_ENDPOINT')),
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
      bucket: requireEnv('R2_BUCKET'),
      publicUrl: normalizeBaseUrl(requireEnv('R2_PUBLIC_URL')),
      keyPrefix: optionalEnv('R2_KEY_PREFIX', 'images').replace(/^\/+|\/+$/g, ''),
      cacheControl: optionalEnv('R2_CACHE_CONTROL', 'public, max-age=86400'),
      forcePathStyle: parseBooleanEnv('R2_FORCE_PATH_STYLE', false)
    },
    admin: {
      basePath: normalizeBasePath(optionalEnv('ADMIN_BASE_PATH', '/image-wrapper/admin')),
      password: optionalEnv('ADMIN_PASSWORD', ''),
      sessionSecret: optionalEnv('ADMIN_SESSION_SECRET', randomBytes(32).toString('hex')),
      dbPath: optionalEnv('ADMIN_DB_PATH', './data/admin.sqlite'),
      retentionDays: parsePositiveInt('ADMIN_RETENTION_DAYS', 7),
      recentLimit: parsePositiveInt('ADMIN_RECENT_LIMIT', 1000),
      cookieSecure: optionalEnv('NODE_ENV', 'development') === 'production'
    },
    asyncTasks: {
      postgresUrl: optionalEnv('POSTGRES_URL', ''),
      redisUrl: optionalEnv('REDIS_URL', ''),
      providerApiKeys: parseCsvEnv('PROVIDER_API_KEYS', ''),
      workerConcurrency: parsePositiveInt('WORKER_CONCURRENCY', 20),
      imageProcessingConcurrency: parsePositiveInt('IMAGE_PROCESSING_CONCURRENCY', 10),
      globalRateLimitIpm: parsePositiveInt('GLOBAL_RATE_LIMIT_IPM', 250),
      providerRateLimitConfig: parseNumberMapEnv('PROVIDER_RATE_LIMIT_CONFIG_JSON', '{}'),
      callbackBatchSize: parsePositiveInt('CALLBACK_BATCH_SIZE', 50),
      callbackFlushMs: parsePositiveInt('CALLBACK_FLUSH_MS', 2000),
      callbackMaxRetryAgeHours: parsePositiveInt('CALLBACK_MAX_RETRY_AGE_HOURS', 24),
      callbackDefaultSecret: optionalEnv('CALLBACK_DEFAULT_SECRET', ''),
      callbackSecrets: parseStringMapEnv('CALLBACK_SECRETS_JSON', '{}'),
      taskStaleProcessingTimeoutSeconds: parsePositiveInt('TASK_STALE_PROCESSING_TIMEOUT_SECONDS', 1800)
    }
  };
}
