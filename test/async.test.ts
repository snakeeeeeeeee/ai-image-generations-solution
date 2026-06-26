import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../src/config.js';
import { normalizeAsyncTaskRequest } from '../src/async/request.js';
import { extractBase64TaskResult } from '../src/async/base64-result.js';
import { flushCallbacks } from '../src/async/notifier.js';
import { sanitizeRawResponse } from '../src/async/raw-response.js';
import { processTask } from '../src/async/worker.js';
import { registerAsyncTaskRoutes } from '../src/async/routes.js';
import type { AsyncTaskRecord } from '../src/async/types.js';

function buildTestConfig(overrides: Partial<AppConfig['asyncTasks']> = {}): AppConfig {
  const asyncTasks: AppConfig['asyncTasks'] = {
    postgresUrl: '',
    redisUrl: '',
    providerApiKeys: ['provider-test-key'],
    workerConcurrency: 20,
    imageProcessingConcurrency: 10,
    globalRateLimitIpm: 250,
    providerRateLimitConfig: {},
    callbackBatchSize: 50,
    callbackFlushMs: 2000,
    callbackMaxRetryAgeHours: 24,
    callbackDefaultSecret: 'default-secret',
    callbackSecrets: {
      channel_123: 'channel-secret'
    },
    credentialLeaseSecrets: {
      image_handle_1: 'internal-secret'
    },
    credentialLeaseAllowedHosts: ['127.0.0.1:1'],
    rawResponseMaxBytes: 256 * 1024,
    syncTaskTimeoutMs: 5 * 60 * 1000,
    syncTaskPollIntervalMs: 500,
    syncWaitConcurrency: 200,
    workerHeartbeatIntervalMs: 5000,
    workerHeartbeatTtlSeconds: 15,
    taskStaleProcessingTimeoutSeconds: 1800,
    ...overrides
  };

  return {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    bodyLimitBytes: 100 * 1024 * 1024,
    role: 'api',
    limits: {
      maxConcurrentGenerations: 1000,
      maxConcurrentImageProcessing: 50,
      maxProcessRssBytes: 28 * 1024 * 1024 * 1024
    },
    upstream: {
      baseUrl: 'http://127.0.0.1:1',
      imagesPath: '/v1/images/generations',
      imageEditsPath: '/v1/images/edits',
      timeoutMs: 5000
    },
    defaults: {
      size: '2560x1440',
      outputFormat: 'png'
    },
    upload: {
      maxRetries: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5
    },
    cors: {
      allowedOrigins: ['*'],
      maxAgeSeconds: 86400
    },
    r2: {
      endpoint: 'http://127.0.0.1:1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      bucket: 'test-image-bucket',
      publicUrl: 'https://img.example.com',
      keyPrefix: 'images',
      cacheControl: 'public, max-age=86400',
      forcePathStyle: false
    },
    admin: {
      basePath: '/image-wrapper/admin',
      password: 'admin-pass',
      sessionSecret: 'test-session-secret-at-least-long-enough',
      dbPath: ':memory:',
      retentionDays: 7,
      recentLimit: 1000,
      cookieSecure: false
    },
    asyncTasks
  };
}

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('async task request requires provider_direct_lease executor', () => {
  const request = normalizeAsyncTaskRequest({
    request_id: 'req_1',
    client_task_id: 'task_1',
    model: 'gpt-image-2',
    operation: 'generation',
    input: {
      text: 'a cyberpunk city'
    },
    parameters: {
      size: '2048x2048',
      output_format: 'webp'
    },
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: 'http://127.0.0.1:1/api/internal/image/credential-leases/lease_1/resolve',
      secret_id: 'image_handle_1'
    }
  });

  assert.equal(request.model, 'gpt-image-2');
  assert.equal(request.input.text, 'a cyberpunk city');
  assert.equal(request.parameters?.size, '2048x2048');
  assert.equal(request.executor.type, 'provider_direct_lease');
  assert.equal(request.executor.lease_id, 'lease_1');
  assert.equal(request.executor.secret_id, 'image_handle_1');
  assert.equal(request.result_data_format, 'url');
});

test('async task request accepts base64 result_data_format', () => {
  const request = normalizeAsyncTaskRequest({
    request_id: 'req_1',
    client_task_id: 'task_1',
    model: 'gpt-image-2',
    operation: 'generation',
    result_data_format: 'base64',
    input: {
      text: 'a cyberpunk city'
    },
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: 'http://127.0.0.1:1/api/internal/image/credential-leases/lease_1/resolve',
      secret_id: 'image_handle_1'
    }
  });

  assert.equal(request.result_data_format, 'base64');
});

test('async task request rejects invalid result_data_format', () => {
  assert.throws(() => normalizeAsyncTaskRequest({
    request_id: 'req_1',
    client_task_id: 'task_1',
    model: 'gpt-image-2',
    operation: 'generation',
    result_data_format: 'binary',
    input: {
      text: 'a cyberpunk city'
    },
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: 'http://127.0.0.1:1/api/internal/image/credential-leases/lease_1/resolve',
      secret_id: 'image_handle_1'
    }
  }), /result_data_format/);
});

test('async task request rejects old new_api_internal executor', () => {
  assert.throws(() => normalizeAsyncTaskRequest({
    request_id: 'req_1',
    client_task_id: 'task_1',
    model: 'gpt-image-2',
    operation: 'generation',
    input: {
      text: 'a cyberpunk city'
    },
    executor: {
      type: 'new_api_internal',
      execute_url: 'http://127.0.0.1:1/api/internal/image/tasks/task_1/execute',
      secret_id: 'image_handle_1'
    }
  }), /provider_direct_lease/);
});

test('async task request rejects missing executor', () => {
  assert.throws(() => normalizeAsyncTaskRequest({
    request_id: 'req_1',
    client_task_id: 'task_1',
    ignored_field: 'ignored',
    model: 'gpt-image-2',
    operation: 'generation',
    input: {
      text: 'a cyberpunk city'
    }
  }), /executor must be an object/);
});

function buildTask(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  const now = new Date().toISOString();
  return {
    provider_task_id: 'imgtask_1',
    client_task_id: 'task_1',
    request_id: 'req_1',
    provider_api_key_hash: 'hash',
    provider: 'provider_direct_lease',
    model: 'gpt-image-2',
    operation: 'generation',
    status: 'queued',
    input: {
      text: 'a cyberpunk city'
    },
    parameters: {
      size: '1024x1024',
      n: 1
    },
    provider_options: {},
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: 'http://127.0.0.1:1/api/internal/image/credential-leases/lease_1/resolve',
      secret_id: 'image_handle_1'
    },
    callback: {},
    metadata: {},
    result: null,
    usage: null,
    error: null,
    attempts: 0,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function buildRoutePayload(clientTaskId = 'task_1'): Record<string, unknown> {
  return {
    request_id: 'req_1',
    client_task_id: clientTaskId,
    model: 'gpt-image-2',
    operation: 'generation',
    input: {
      text: 'a cyberpunk city'
    },
    parameters: {
      size: '1024x1024',
      n: 1
    },
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: 'http://127.0.0.1:1/api/internal/image/credential-leases/lease_1/resolve',
      secret_id: 'image_handle_1'
    }
  };
}

test('sync async task route waits for terminal task result', async () => {
  const app = Fastify();
  let task = buildTask();
  let enqueued = false;
  let submittedMetadata: Record<string, unknown> | undefined;
  const store = {
    createTask: async (request: { metadata?: Record<string, unknown> }) => {
      submittedMetadata = request.metadata;
      return {
        task,
        created: true
      };
    },
    getTask: async () => task
  };
  const taskQueue = {
    add: async () => {
      enqueued = true;
      setTimeout(() => {
        task = buildTask({
          status: 'succeeded',
          result: {
            images: [
              {
                url: 'https://img.example.com/out.png',
                mime_type: 'image/png'
              }
            ]
          },
          usage: {
            total_tokens: 12
          },
          finished_at: new Date().toISOString()
        });
      }, 10);
    }
  };

  registerAsyncTaskRoutes(app, {
    config: buildTestConfig({
      providerApiKeys: ['provider-test-key'],
      syncTaskTimeoutMs: 500,
      syncTaskPollIntervalMs: 5
    }),
    store: store as never,
    taskQueue: taskQueue as never
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/image/tasks/sync',
    headers: {
      authorization: 'Bearer provider-test-key'
    },
    payload: buildRoutePayload()
  });

  assert.equal(response.statusCode, 200);
  assert.equal(enqueued, true);
  assert.equal(submittedMetadata?.submission_mode, 'sync_wait');
  const body = response.json() as {
    status: string;
    result: { images: Array<{ url: string }> };
    usage: { total_tokens: number };
    sync_wait: { completed: boolean; timeout_ms: number };
  };
  assert.equal(body.status, 'succeeded');
  assert.equal(body.result.images[0]?.url, 'https://img.example.com/out.png');
  assert.deepEqual(body.usage, { total_tokens: 12 });
  assert.deepEqual(body.sync_wait, {
    completed: true,
    timeout_ms: 500
  });

  await app.close();
});

test('sync async task route can return ephemeral base64 result', async () => {
  const app = Fastify();
  let task = buildTask();
  const store = {
    createTask: async (request: { metadata?: Record<string, unknown> }) => {
      task = buildTask({
        metadata: request.metadata ?? {}
      });
      return {
        task,
        created: true
      };
    },
    getTask: async () => task
  };
  const taskQueue = {
    add: async () => {
      setTimeout(() => {
        task = buildTask({
          status: 'succeeded',
          metadata: {
            result_data_format: 'base64',
            submission_mode: 'sync_wait'
          },
          result: {
            images: [
              {
                url: 'https://img.example.com/out.png',
                mime_type: 'image/png'
              }
            ]
          },
          usage: {
            total_tokens: 12
          },
          finished_at: new Date().toISOString()
        });
      }, 10);
    }
  };
  const cached = new Map<string, string>();
  const redis = {
    get: async (key: string) => cached.get(key)
  };
  cached.set('image-task:base64-result:imgtask_1', JSON.stringify({
    result_data_format: 'base64',
    result: {
      images: [
        {
          b64_json: tinyPngBase64,
          mime_type: 'image/png'
        }
      ]
    }
  }));

  registerAsyncTaskRoutes(app, {
    config: buildTestConfig({
      providerApiKeys: ['provider-test-key'],
      syncTaskTimeoutMs: 500,
      syncTaskPollIntervalMs: 5
    }),
    store: store as never,
    taskQueue: taskQueue as never,
    base64ResultRedis: redis as never
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/image/tasks/sync',
    headers: {
      authorization: 'Bearer provider-test-key'
    },
    payload: {
      ...buildRoutePayload(),
      result_data_format: 'base64'
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    result_data_format: string;
    result: { images: Array<{ b64_json: string; url?: string }> };
  };
  assert.equal(body.result_data_format, 'base64');
  assert.equal(body.result.images[0]?.b64_json, tinyPngBase64);
  assert.equal(body.result.images[0]?.url, undefined);

  await app.close();
});

test('async task route marks task submission mode as async', async () => {
  const app = Fastify();
  const task = buildTask();
  let submittedMetadata: Record<string, unknown> | undefined;
  let addCalls = 0;
  const store = {
    createTask: async (request: { metadata?: Record<string, unknown> }) => {
      submittedMetadata = request.metadata;
      return {
        task,
        created: true
      };
    }
  };
  const taskQueue = {
    add: async () => {
      addCalls += 1;
    }
  };

  registerAsyncTaskRoutes(app, {
    config: buildTestConfig({
      providerApiKeys: ['provider-test-key']
    }),
    store: store as never,
    taskQueue: taskQueue as never
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/image/tasks',
    headers: {
      authorization: 'Bearer provider-test-key'
    },
    payload: buildRoutePayload()
  });

  assert.equal(response.statusCode, 202);
  assert.equal(addCalls, 1);
  assert.equal(submittedMetadata?.submission_mode, 'async');

  await app.close();
});

test('async task route rejects base64 result_data_format', async () => {
  const app = Fastify();
  const store = {
    createTask: async () => {
      throw new Error('should not create task');
    }
  };
  const taskQueue = {
    add: async () => undefined
  };

  registerAsyncTaskRoutes(app, {
    config: buildTestConfig({
      providerApiKeys: ['provider-test-key']
    }),
    store: store as never,
    taskQueue: taskQueue as never
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/image/tasks',
    headers: {
      authorization: 'Bearer provider-test-key'
    },
    payload: {
      ...buildRoutePayload(),
      result_data_format: 'base64'
    }
  });

  assert.equal(response.statusCode, 400);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'unsupported_result_data_format');

  await app.close();
});

test('sync async task route returns processing state on wait timeout', async () => {
  const app = Fastify();
  const task = buildTask({
    status: 'processing'
  });
  let addCalls = 0;
  const store = {
    createTask: async () => ({
      task,
      created: true
    }),
    getTask: async () => task
  };
  const taskQueue = {
    add: async () => {
      addCalls += 1;
    }
  };

  registerAsyncTaskRoutes(app, {
    config: buildTestConfig({
      providerApiKeys: ['provider-test-key'],
      syncTaskTimeoutMs: 20,
      syncTaskPollIntervalMs: 5
    }),
    store: store as never,
    taskQueue: taskQueue as never
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/image/tasks/sync',
    headers: {
      authorization: 'Bearer provider-test-key'
    },
    payload: buildRoutePayload()
  });

  assert.equal(response.statusCode, 202);
  assert.equal(addCalls, 1);
  const body = response.json() as {
    status: string;
    progress: string;
    sync_wait: { completed: boolean; timeout_ms: number };
  };
  assert.equal(body.status, 'processing');
  assert.equal(body.progress, '50%');
  assert.deepEqual(body.sync_wait, {
    completed: false,
    timeout_ms: 20
  });

  await app.close();
});

test('raw_response sanitizer removes base64 image fields and applies byte limit', () => {
  const safe = sanitizeRawResponse({
    id: 'resp_1',
    data: [
      {
        b64_json: tinyPngBase64,
        url: 'https://example.com/original.png',
        revised_prompt: 'safe'
      }
    ],
    nested: {
      preview: `data:image/png;base64,${tinyPngBase64}`
    }
  }, 10_000);

  assert.equal(safe.raw_response_truncated, true);
  assert.deepEqual(safe.raw_response_omitted_fields.sort(), ['data[].b64_json', 'nested.preview']);
  const raw = safe.raw_response as { data: Array<{ b64_json: string }>; nested: { preview: string } };
  assert.equal(raw.data[0]?.b64_json, '[omitted]');
  assert.equal(raw.nested.preview, '[omitted]');

  const oversized = sanitizeRawResponse({ text: 'x'.repeat(2048) }, 128);
  assert.equal(oversized.raw_response_truncated, true);
  assert.deepEqual(oversized.raw_response, {
    truncated: true,
    message: 'raw_response exceeded 128 bytes'
  });
});

test('base64 result extractor enforces 100MB payload limit', () => {
  const result = extractBase64TaskResult({
    data: [
      {
        b64_json: tinyPngBase64,
        mime_type: 'image/png'
      }
    ]
  });

  assert.equal(result.images[0]?.b64_json, tinyPngBase64);
  assert.equal(result.images[0]?.mime_type, 'image/png');
  assert.throws(() => extractBase64TaskResult({
    data: [
      {
        b64_json: 'x'.repeat(33)
      }
    ]
  }, 32), /100MB/);
});

test('worker resolves credential lease, calls upstream directly, uploads R2, and stores safe callback payload', async () => {
  const upstream = Fastify();
  const received: {
    resolveSignature?: string;
    resolveSecretId?: string;
    resolveBody?: unknown;
    upstreamAuthorization?: string;
    upstreamBody?: unknown;
    rateLimitRequest?: { provider: string; model: string; channelId?: string };
  } = {};

  upstream.post('/api/internal/image/credential-leases/lease_1/resolve', async (request) => {
    received.resolveSignature = request.headers['x-imagehandle-signature'] as string | undefined;
    received.resolveSecretId = request.headers['x-imagehandle-secret-id'] as string | undefined;
    received.resolveBody = request.body;
    return {
      provider: 'openai_compatible',
      request_format: 'openai_images',
      base_url: upstreamBaseUrl,
      api_key: 'sk-secret-upstream',
      model: 'gpt-image-2',
      channel_id: 'resolved_channel_123',
      expires_at: new Date(Date.now() + 60_000).toISOString()
    };
  });

  upstream.post('/images/generations', async (request) => {
    received.upstreamAuthorization = request.headers.authorization;
    received.upstreamBody = request.body;
    return {
      id: 'resp_1',
      created: 123,
      model: 'gpt-image-2',
      usage: {
        total_tokens: 12
      },
      data: [
        {
          url: `${upstreamBaseUrl}/mock-output.png`,
          revised_prompt: 'a cyberpunk city'
        }
      ]
    };
  });

  upstream.get('/mock-output.png', async (_request, reply) => {
    return reply
      .header('content-type', 'image/png')
      .send(Buffer.from(tinyPngBase64, 'base64'));
  });

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const address = upstream.server.address();
  assert.ok(address && typeof address === 'object');
  const upstreamBaseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

  const completed: Array<{
    status: string;
    result: Record<string, unknown> | null;
    usage: Record<string, unknown> | null;
    error: unknown;
    callbackPayload: Record<string, unknown> | null;
  }> = [];
  const task = {
    provider_task_id: 'imgtask_1',
    client_task_id: 'task_1',
    request_id: 'req_1',
    provider_api_key_hash: 'hash',
    provider: 'provider_direct_lease',
    model: 'gpt-image-2',
    operation: 'generation',
    status: 'queued',
    input: {
      text: 'a cyberpunk city'
    },
    parameters: {
      size: '1024x1024',
      n: 1
    },
    provider_options: {},
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: `${upstreamBaseUrl}/api/internal/image/credential-leases/lease_1/resolve`,
      secret_id: 'image_handle_1'
    },
    callback: {},
    metadata: {
      channel_id: 'channel_123',
      debug_upstream: true
    },
    result: null,
    usage: null,
    error: null,
    attempts: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const store = {
    claimTask: async () => task,
    completeTask: async (args: {
      status: string;
      result: Record<string, unknown> | null;
      usage: Record<string, unknown> | null;
      error: unknown;
      callbackPayload: Record<string, unknown> | null;
    }) => {
      completed.push(args);
      return undefined;
    },
    retryTask: async () => false
  };
  const taskQueue = {
    add: async () => undefined
  };
  const rateLimiter = {
    waitForToken: async (request: { provider: string; model: string; channelId?: string }) => {
      received.rateLimitRequest = request;
    }
  };
  const limiter = {
    acquire: async () => () => undefined
  };
  const upload = async () => 'https://img.example.com/images/out.png';

  const dispatcher = new (await import('undici')).Agent();
  const logs: string[] = [];
  const originalConsoleInfo = console.info;
  console.info = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    await processTask({
      job: {
        data: {
          provider_task_id: 'imgtask_1'
        }
      } as never,
      config: buildTestConfig({
        credentialLeaseAllowedHosts: [`127.0.0.1:${(address as AddressInfo).port}`]
      }),
      store: store as never,
      taskQueue: taskQueue as never,
      rateLimiter: rateLimiter as never,
      imageProcessingLimiter: limiter as never,
      upstreamDispatcher: dispatcher,
      r2Client: {} as never,
      upload
    });
  } finally {
    console.info = originalConsoleInfo;
  }

  assert.equal(received.resolveSecretId, 'image_handle_1');
  assert.ok(received.resolveSignature);
  assert.deepEqual(received.resolveBody, {
    provider_task_id: 'imgtask_1',
    client_task_id: 'task_1',
    attempt: 1,
    operation: 'generation',
    model: 'gpt-image-2'
  });
  assert.equal(received.upstreamAuthorization, 'Bearer sk-secret-upstream');
  assert.deepEqual(received.rateLimitRequest, {
    provider: 'openai_compatible',
    model: 'gpt-image-2',
    channelId: 'resolved_channel_123'
  });
  assert.equal((received.upstreamBody as { model?: string }).model, 'gpt-image-2');
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.status, 'succeeded');
  assert.deepEqual(completed[0]?.usage, { total_tokens: 12 });
  const result = completed[0]?.result as {
    images: Array<{ url: string; mime_type: string }>;
    raw_response: { data: Array<{ url: string; b64_json?: string }> };
    raw_response_truncated: boolean;
  };
  assert.equal(result.images[0]?.url, 'https://img.example.com/images/out.png');
  assert.equal(result.raw_response.data[0]?.url, 'https://img.example.com/images/out.png');
  assert.equal(result.raw_response.data[0]?.b64_json, undefined);
  assert.equal(result.raw_response_truncated, false);
  assert.equal(JSON.stringify(completed[0]).includes('sk-secret-upstream'), false);
  const joinedLogs = logs.join('\n');
  assert.match(joinedLogs, /request/);
  assert.match(joinedLogs, /\/images\/generations/);
  assert.match(joinedLogs, /response_body/);
  assert.match(joinedLogs, /gpt-image-2/);
  assert.equal(joinedLogs.includes('sk-secret-upstream'), false);

  await dispatcher.close();
  await upstream.close();
});

test('worker writes requested base64 result to Redis only', async () => {
  const upstream = Fastify();

  upstream.post('/api/internal/image/credential-leases/lease_1/resolve', async () => ({
    provider: 'openai_compatible',
    request_format: 'openai_images',
    base_url: upstreamBaseUrl,
    api_key: 'sk-secret-upstream',
    model: 'gpt-image-2',
    channel_id: 'resolved_channel_123',
    expires_at: new Date(Date.now() + 60_000).toISOString()
  }));

  upstream.post('/images/generations', async () => ({
    id: 'resp_1',
    created: 123,
    model: 'gpt-image-2',
    usage: {
      total_tokens: 12
    },
    data: [
      {
        b64_json: tinyPngBase64,
        revised_prompt: 'a cyberpunk city'
      }
    ]
  }));

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const address = upstream.server.address();
  assert.ok(address && typeof address === 'object');
  const upstreamBaseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

  const completed: Array<{
    status: string;
    result: Record<string, unknown> | null;
    callbackPayload: Record<string, unknown> | null;
  }> = [];
  const cached = new Map<string, string>();
  const redis = {
    set: async (key: string, value: string) => {
      cached.set(key, value);
      return 'OK';
    }
  };
  const task = buildTask({
    attempts: 1,
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: `${upstreamBaseUrl}/api/internal/image/credential-leases/lease_1/resolve`,
      secret_id: 'image_handle_1'
    },
    metadata: {
      result_data_format: 'base64',
      submission_mode: 'sync_wait'
    }
  });
  const store = {
    claimTask: async () => task,
    completeTask: async (args: {
      status: string;
      result: Record<string, unknown> | null;
      callbackPayload: Record<string, unknown> | null;
    }) => {
      completed.push(args);
      return undefined;
    },
    retryTask: async () => false
  };
  const dispatcher = new (await import('undici')).Agent();

  await processTask({
    job: {
      data: {
        provider_task_id: 'imgtask_1'
      }
    } as never,
    config: buildTestConfig({
      credentialLeaseAllowedHosts: [`127.0.0.1:${(address as AddressInfo).port}`]
    }),
    store: store as never,
    taskQueue: {
      add: async () => undefined
    } as never,
    rateLimiter: {
      waitForToken: async () => undefined
    } as never,
    imageProcessingLimiter: {
      acquire: async () => () => undefined
    } as never,
    upstreamDispatcher: dispatcher,
    r2Client: {} as never,
    base64ResultRedis: redis as never,
    upload: async () => 'https://img.example.com/images/out.png'
  });

  assert.equal(completed[0]?.status, 'succeeded');
  assert.equal(JSON.stringify(completed[0]?.result).includes(tinyPngBase64), false);
  assert.equal(JSON.stringify(completed[0]?.callbackPayload).includes(tinyPngBase64), false);
  const cachedValue = cached.get('image-task:base64-result:imgtask_1');
  assert.ok(cachedValue);
  const body = JSON.parse(cachedValue) as { result: { images: Array<{ b64_json: string }> } };
  assert.equal(body.result.images[0]?.b64_json, tinyPngBase64);

  await dispatcher.close();
  await upstream.close();
});

test('worker returns upstream status code and provider error details on upstream failure', async () => {
  const upstream = Fastify();

  upstream.post('/api/internal/image/credential-leases/lease_1/resolve', async () => ({
    provider: 'openai_compatible',
    request_format: 'openai_images',
    base_url: upstreamBaseUrl,
    api_key: 'sk-secret-upstream',
    model: 'gpt-image-2',
    channel_id: 'resolved_channel_123',
    expires_at: new Date(Date.now() + 60_000).toISOString()
  }));

  upstream.post('/images/generations', async (_request, reply) => reply.status(400).send({
    error: {
      message: 'size is not supported by this channel',
      type: 'invalid_request_error',
      code: 'unsupported_size',
      param: 'size'
    }
  }));

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const address = upstream.server.address();
  assert.ok(address && typeof address === 'object');
  const upstreamBaseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

  const completed: Array<{
    status: string;
    result: Record<string, unknown> | null;
    error: Record<string, unknown> | null;
    callbackPayload: Record<string, unknown> | null;
  }> = [];
  const task = buildTask({
    attempts: 3,
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: `${upstreamBaseUrl}/api/internal/image/credential-leases/lease_1/resolve`,
      secret_id: 'image_handle_1'
    }
  });
  const store = {
    claimTask: async () => task,
    completeTask: async (args: {
      status: string;
      result: Record<string, unknown> | null;
      error: Record<string, unknown> | null;
      callbackPayload: Record<string, unknown> | null;
    }) => {
      completed.push(args);
      return undefined;
    },
    retryTask: async () => false
  };
  const dispatcher = new (await import('undici')).Agent();

  try {
    await processTask({
      job: {
        data: {
          provider_task_id: 'imgtask_1'
        }
      } as never,
      config: buildTestConfig({
        credentialLeaseAllowedHosts: [`127.0.0.1:${(address as AddressInfo).port}`]
      }),
      store: store as never,
      taskQueue: {
        add: async () => undefined
      } as never,
      rateLimiter: {
        waitForToken: async () => undefined
      } as never,
      imageProcessingLimiter: {
        acquire: async () => () => undefined
      } as never,
      upstreamDispatcher: dispatcher,
      r2Client: {} as never,
      upload: async () => 'https://img.example.com/images/out.png'
    });

    assert.equal(completed[0]?.status, 'failed');
    assert.deepEqual(completed[0]?.error, {
      code: 'new_api_error',
      message: 'size is not supported by this channel',
      retryable: false,
      upstream_status: 400,
      provider_error_code: 'unsupported_size',
      provider_error_type: 'invalid_request_error',
      provider_error_message: 'size is not supported by this channel',
      provider_error_param: 'size',
      upstream_error: {
        error: {
          message: 'size is not supported by this channel',
          type: 'invalid_request_error',
          code: 'unsupported_size',
          param: 'size'
        }
      }
    });
    const result = completed[0]?.result as {
      raw_response: { error: { code: string; message: string; type: string; param: string } };
      raw_response_truncated: boolean;
    };
    assert.equal(result.raw_response.error.code, 'unsupported_size');
    assert.equal(result.raw_response.error.message, 'size is not supported by this channel');
    assert.equal(result.raw_response.error.type, 'invalid_request_error');
    assert.equal(result.raw_response.error.param, 'size');
    assert.equal(result.raw_response_truncated, false);
    const callbackPayload = completed[0]?.callbackPayload as {
      error: { upstream_status: number; provider_error_code: string; provider_error_message: string };
      raw_response: { error: { code: string; message: string } };
    };
    assert.equal(callbackPayload.error.upstream_status, 400);
    assert.equal(callbackPayload.error.provider_error_code, 'unsupported_size');
    assert.equal(callbackPayload.error.provider_error_message, 'size is not supported by this channel');
    assert.equal(callbackPayload.raw_response.error.code, 'unsupported_size');
    assert.equal(JSON.stringify(completed[0]).includes('sk-secret-upstream'), false);
  } finally {
    await dispatcher.close();
    await upstream.close();
  }
});

test('回调投递进程按 secret_id 分组并发送 X-Callback-Secret-Id 请求头', async () => {
  const callbackServer = Fastify();
  const received: Array<{ secretId: string | undefined; body: unknown }> = [];

  callbackServer.post('/callback/batch', async (request) => {
    received.push({
      secretId: request.headers['x-callback-secret-id'] as string | undefined,
      body: request.body
    });
    return {
      code: 'success',
      results: [
        {
          client_task_id: 'task_1',
          status: 'accepted'
        },
        {
          client_task_id: 'task_2',
          status: 'accepted'
        }
      ]
    };
  });

  await callbackServer.listen({ port: 0, host: '127.0.0.1' });
  const address = callbackServer.server.address();
  assert.ok(address && typeof address === 'object');
  const callbackUrl = `http://127.0.0.1:${(address as AddressInfo).port}/callback/batch`;

  const delivered: string[] = [];
  const rescheduled: string[] = [];
  const store = {
    claimCallbackEvents: async () => [
      {
        event_id: 'evt_1',
        provider_task_id: 'imgtask_1',
        client_task_id: 'task_1',
        callback_url: callbackUrl,
        batch_callback_url: callbackUrl,
        secret_id: 'channel_123',
        payload: {
          client_task_id: 'task_1',
          provider_task_id: 'imgtask_1',
          status: 'succeeded'
        },
        status: 'pending',
        attempts: 0,
        next_attempt_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      {
        event_id: 'evt_2',
        provider_task_id: 'imgtask_2',
        client_task_id: 'task_2',
        callback_url: callbackUrl,
        batch_callback_url: callbackUrl,
        secret_id: 'channel_123',
        payload: {
          client_task_id: 'task_2',
          provider_task_id: 'imgtask_2',
          status: 'failed'
        },
        status: 'pending',
        attempts: 0,
        next_attempt_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ],
    markCallbackDelivered: async (ids: string[]) => {
      delivered.push(...ids);
    },
    rescheduleCallbackEvents: async (ids: string[]) => {
      rescheduled.push(...ids);
    }
  };

  await flushCallbacks({
    config: buildTestConfig(),
    store: store as never
  });

  assert.equal(received.length, 1);
  assert.equal(received[0]?.secretId, 'channel_123');
  const body = received[0]?.body as { events: Array<{ client_task_id: string }> };
  assert.deepEqual(body.events.map((event) => event.client_task_id), ['task_1', 'task_2']);
  assert.deepEqual(delivered.sort(), ['evt_1', 'evt_2']);
  assert.deepEqual(rescheduled, []);

  await callbackServer.close();
});
