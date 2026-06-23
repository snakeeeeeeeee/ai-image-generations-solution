import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../src/config.js';
import { normalizeAsyncTaskRequest } from '../src/async/request.js';
import { flushCallbacks } from '../src/async/notifier.js';
import { sanitizeRawResponse } from '../src/async/raw-response.js';
import { processTask } from '../src/async/worker.js';

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
      channel_id: 'channel_123'
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

  await dispatcher.close();
  await upstream.close();
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
