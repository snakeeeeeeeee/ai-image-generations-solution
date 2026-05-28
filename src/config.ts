import 'dotenv/config';

const DEFAULT_BODY_LIMIT_BYTES = 100 * 1024 * 1024;

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  bodyLimitBytes: number;
  limits: {
    maxConcurrentGenerations: number;
    maxConcurrentImageProcessing: number;
  };
  upstream: {
    baseUrl: string;
    imagesPath: string;
    timeoutMs: number;
  };
  defaults: {
    size: string;
    outputFormat: 'png';
  };
  r2: R2Config;
}

export interface R2Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
  keyPrefix: string;
  cacheControl: string;
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

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizePath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

function normalizePngFormat(value: string): 'png' {
  const normalized = value.toLowerCase();
  if (normalized !== 'png') {
    throw new Error(`DEFAULT_OUTPUT_FORMAT must be png, received: ${value}`);
  }
  return 'png';
}

export function loadConfig(): AppConfig {
  return {
    port: parsePositiveInt('PORT', 8787),
    host: optionalEnv('HOST', '0.0.0.0'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    bodyLimitBytes: parsePositiveInt('REQUEST_BODY_LIMIT_BYTES', DEFAULT_BODY_LIMIT_BYTES),
    limits: {
      maxConcurrentGenerations: parsePositiveInt('MAX_CONCURRENT_GENERATIONS', 1000),
      maxConcurrentImageProcessing: parsePositiveInt('MAX_CONCURRENT_IMAGE_PROCESSING', 50)
    },
    upstream: {
      baseUrl: normalizeBaseUrl(requireEnv('NEW_API_BASE_URL')),
      imagesPath: normalizePath(optionalEnv('NEW_API_IMAGES_PATH', '/v1/images/generations')),
      timeoutMs: parsePositiveInt('UPSTREAM_TIMEOUT_MS', 30 * 60 * 1000)
    },
    defaults: {
      size: optionalEnv('DEFAULT_IMAGE_SIZE', '2560x1440'),
      outputFormat: normalizePngFormat(optionalEnv('DEFAULT_OUTPUT_FORMAT', 'png'))
    },
    r2: {
      endpoint: normalizeBaseUrl(requireEnv('R2_ENDPOINT')),
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
      bucket: requireEnv('R2_BUCKET'),
      publicUrl: normalizeBaseUrl(requireEnv('R2_PUBLIC_URL')),
      keyPrefix: optionalEnv('R2_KEY_PREFIX', 'images').replace(/^\/+|\/+$/g, ''),
      cacheControl: optionalEnv('R2_CACHE_CONTROL', 'public, max-age=86400')
    }
  };
}
