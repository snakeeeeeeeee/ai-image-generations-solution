import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../src/config.js';
import { normalizeAsyncTaskRequest } from '../src/async/request.js';
import { flushCallbacks } from '../src/async/notifier.js';

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
    internalExecuteSecrets: {
      image_handle_1: 'internal-secret'
    },
    internalExecuteAllowedHosts: ['127.0.0.1:1'],
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

test('async task request requires new_api_internal executor', () => {
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
      type: 'new_api_internal',
      execute_url: 'http://127.0.0.1:1/api/internal/image/tasks/task_1/execute',
      secret_id: 'image_handle_1'
    }
  });

  assert.equal(request.model, 'gpt-image-2');
  assert.equal(request.input.text, 'a cyberpunk city');
  assert.equal(request.parameters?.size, '2048x2048');
  assert.equal(request.executor.type, 'new_api_internal');
  assert.equal(request.executor.secret_id, 'image_handle_1');
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
