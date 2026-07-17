import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AdminStore } from '../src/admin/store.js';
import { buildServer } from '../src/server.js';
import type { AppConfig } from '../src/config.js';
import type { AsyncTaskStore } from '../src/async/store.js';
import type { QueueClients } from '../src/async/queue.js';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const tinyJpegBuffer = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x02, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xd9
]);

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function buildTestConfig(baseUrl: string, overrides: DeepPartial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
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
      baseUrl,
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
    asyncTasks: {
      postgresUrl: '',
      redisUrl: '',
      providerApiKeys: [],
      workerConcurrency: 20,
      imageProcessingConcurrency: 10,
      globalRateLimitIpm: 250,
      providerRateLimitConfig: {},
      callbackBatchSize: 50,
      callbackFlushMs: 2000,
      callbackMaxRetryAgeHours: 24,
      callbackDefaultSecret: 'test-callback-secret',
      callbackSecrets: {},
      credentialLeaseSecrets: {},
      credentialLeaseAllowedHosts: ['127.0.0.1:1'],
      imageUrlAllowPrivateNetwork: true,
      rawResponseMaxBytes: 256 * 1024,
      syncTaskTimeoutMs: 5 * 60 * 1000,
      syncTaskPollIntervalMs: 500,
      syncWaitConcurrency: 200,
      workerHeartbeatIntervalMs: 5000,
      workerHeartbeatTtlSeconds: 15,
      taskStaleProcessingTimeoutSeconds: 1800
    }
  };

  return {
    ...base,
    ...overrides,
    limits: {
      ...base.limits,
      ...overrides.limits
    },
    upstream: {
      ...base.upstream,
      ...overrides.upstream
    },
    defaults: {
      ...base.defaults,
      ...overrides.defaults
    },
    upload: {
      ...base.upload,
      ...overrides.upload
    },
    cors: {
      allowedOrigins: overrides.cors?.allowedOrigins?.filter((item): item is string => typeof item === 'string') ?? base.cors.allowedOrigins,
      maxAgeSeconds: overrides.cors?.maxAgeSeconds ?? base.cors.maxAgeSeconds
    },
    r2: {
      ...base.r2,
      ...overrides.r2
    },
    admin: {
      ...base.admin,
      ...overrides.admin
    },
    asyncTasks: {
      postgresUrl: overrides.asyncTasks?.postgresUrl ?? base.asyncTasks.postgresUrl,
      redisUrl: overrides.asyncTasks?.redisUrl ?? base.asyncTasks.redisUrl,
      providerApiKeys: overrides.asyncTasks?.providerApiKeys?.filter((item): item is string => typeof item === 'string') ?? base.asyncTasks.providerApiKeys,
      workerConcurrency: overrides.asyncTasks?.workerConcurrency ?? base.asyncTasks.workerConcurrency,
      imageProcessingConcurrency: overrides.asyncTasks?.imageProcessingConcurrency ?? base.asyncTasks.imageProcessingConcurrency,
      globalRateLimitIpm: overrides.asyncTasks?.globalRateLimitIpm ?? base.asyncTasks.globalRateLimitIpm,
      providerRateLimitConfig: base.asyncTasks.providerRateLimitConfig,
      callbackBatchSize: overrides.asyncTasks?.callbackBatchSize ?? base.asyncTasks.callbackBatchSize,
      callbackFlushMs: overrides.asyncTasks?.callbackFlushMs ?? base.asyncTasks.callbackFlushMs,
      callbackMaxRetryAgeHours: overrides.asyncTasks?.callbackMaxRetryAgeHours ?? base.asyncTasks.callbackMaxRetryAgeHours,
      callbackDefaultSecret: overrides.asyncTasks?.callbackDefaultSecret ?? base.asyncTasks.callbackDefaultSecret,
      callbackSecrets: base.asyncTasks.callbackSecrets,
      credentialLeaseSecrets: base.asyncTasks.credentialLeaseSecrets,
      credentialLeaseAllowedHosts: base.asyncTasks.credentialLeaseAllowedHosts,
      imageUrlAllowPrivateNetwork: overrides.asyncTasks?.imageUrlAllowPrivateNetwork ?? base.asyncTasks.imageUrlAllowPrivateNetwork,
      rawResponseMaxBytes: overrides.asyncTasks?.rawResponseMaxBytes ?? base.asyncTasks.rawResponseMaxBytes,
      syncTaskTimeoutMs: overrides.asyncTasks?.syncTaskTimeoutMs ?? base.asyncTasks.syncTaskTimeoutMs,
      syncTaskPollIntervalMs: overrides.asyncTasks?.syncTaskPollIntervalMs ?? base.asyncTasks.syncTaskPollIntervalMs,
      syncWaitConcurrency: overrides.asyncTasks?.syncWaitConcurrency ?? base.asyncTasks.syncWaitConcurrency,
      workerHeartbeatIntervalMs: overrides.asyncTasks?.workerHeartbeatIntervalMs ?? base.asyncTasks.workerHeartbeatIntervalMs,
      workerHeartbeatTtlSeconds: overrides.asyncTasks?.workerHeartbeatTtlSeconds ?? base.asyncTasks.workerHeartbeatTtlSeconds,
      taskStaleProcessingTimeoutSeconds: overrides.asyncTasks?.taskStaleProcessingTimeoutSeconds ?? base.asyncTasks.taskStaleProcessingTimeoutSeconds
    }
  };
}

async function buildUpstream(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const upstream = Fastify();

  upstream.post('/v1/images/generations', async () => ({
    created: 1780000000,
    data: [
      {
        b64_json: tinyPngBase64
      }
    ]
  }));

  upstream.post('/v1/images/edits', async () => ({
    created: 1780000000,
    data: [
      {
        b64_json: tinyPngBase64
      }
    ]
  }));

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const address = upstream.server.address();
  assert.ok(address && typeof address === 'object');

  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () => upstream.close()
  };
}

function getCookie(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(raw);
  return raw.split(';')[0] ?? '';
}

test('admin login succeeds and protects API routes', async () => {
  const upstream = await buildUpstream();
  const app = buildServer(buildTestConfig(upstream.baseUrl), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const unauthenticated = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/summary'
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, 'admin_auth_required');

  const failedLogin = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/login',
    payload: {
      password: 'wrong'
    }
  });
  assert.equal(failedLogin.statusCode, 401);

  const login = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/login',
    payload: {
      password: 'admin-pass'
    }
  });
  assert.equal(login.statusCode, 200);

  const cookie = getCookie(login.headers['set-cookie']);
  const authenticated = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/summary',
    headers: {
      cookie
    }
  });
  assert.equal(authenticated.statusCode, 200);
  assert.equal(typeof authenticated.json().runtime.activeGenerations, 'number');

  await app.close();
  await upstream.close();
});

test('admin async APIs report disabled empty state without async infra', async () => {
  const upstream = await buildUpstream();
  const app = buildServer(buildTestConfig(upstream.baseUrl), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const login = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/login',
    payload: {
      password: 'admin-pass'
    }
  });
  const cookie = getCookie(login.headers['set-cookie']);

  const summary = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/async/summary',
    headers: {
      cookie
    }
  });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().enabled, false);
  assert.equal(summary.json().tasks.total, 0);
  assert.equal(summary.json().callbacks.total, 0);
  assert.equal(summary.json().queue, null);

  const tasks = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/async/tasks?page=1&page_size=10',
    headers: {
      cookie
    }
  });
  assert.equal(tasks.statusCode, 200);
  assert.equal(tasks.json().total, 0);
  assert.deepEqual(tasks.json().data, []);

  const callbacks = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/async/callbacks?page=1&page_size=10',
    headers: {
      cookie
    }
  });
  assert.equal(callbacks.statusCode, 200);
  assert.equal(callbacks.json().total, 0);
  assert.deepEqual(callbacks.json().data, []);

  await app.close();
  await upstream.close();
});

test('admin async APIs expose task callback and queue status', async () => {
  const upstream = await buildUpstream();
  const fakeAsyncStore = {
    getAdminTaskSummary: async () => ({
      total: 2,
      submitted: 0,
      queued: 1,
      processing: 0,
      succeeded: 1,
      failed: 0,
      lastCreatedAt: '2026-06-22T01:00:00.000Z',
      lastUpdatedAt: '2026-06-22T01:01:00.000Z'
    }),
    getAdminCallbackSummary: async () => ({
      total: 1,
      pending: 1,
      processing: 0,
      delivered: 0,
      failed: 0,
      lastCreatedAt: '2026-06-22T01:02:00.000Z',
      lastUpdatedAt: '2026-06-22T01:02:00.000Z'
    }),
    getAdminTasksPage: async (page: number, pageSize: number) => ({
      data: [
        {
          provider_task_id: 'imgtask_1',
          client_task_id: 'task_1',
          request_id: 'req_1',
          provider: 'provider_direct_lease',
          model: 'gpt-image-2',
          operation: 'generation',
          status: 'succeeded',
          parameters: {
            size: '1024x1024',
            output_format: 'png'
          },
          executor: {
            type: 'provider_direct_lease',
            lease_id: 'lease_1',
            resolve_url: 'http://newapi-master:3000/api/internal/image/credential-leases/lease_1/resolve',
            secret_id: 'image_handle_1'
          },
          metadata: {
            channel_id: 'channel_123'
          },
          usage: {
            total_tokens: 12
          },
          raw_response_truncated: true,
          raw_response_omitted_fields: ['data[].b64_json'],
          attempts: 1,
          image_count: 1,
          first_image_url: 'https://img.example.com/images/test.png',
          created_at: '2026-06-22T01:00:00.000Z',
          started_at: '2026-06-22T01:00:01.000Z',
          finished_at: '2026-06-22T01:00:10.000Z',
          updated_at: '2026-06-22T01:00:10.000Z'
        }
      ],
      page,
      pageSize,
      total: 1,
      totalPages: 1
    }),
    getAdminCallbackEventsPage: async (page: number, pageSize: number) => ({
      data: [
        {
          event_id: 'evt_1',
          provider_task_id: 'imgtask_1',
          client_task_id: 'task_1',
          callback_url: 'https://new-api.example.com/callback/task_1',
          batch_callback_url: 'https://new-api.example.com/callback/batch',
          secret_id: 'channel_123',
          status: 'pending',
          attempts: 1,
          next_attempt_at: '2026-06-22T01:05:00.000Z',
          created_at: '2026-06-22T01:02:00.000Z',
          updated_at: '2026-06-22T01:02:00.000Z'
        }
      ],
      page,
      pageSize,
      total: 1,
      totalPages: 1
    })
  } as unknown as AsyncTaskStore;
  const fakeQueueClients = {
    connection: {
      scan: async (cursor: string) => cursor === '0'
        ? ['0', ['image:runtime:worker:worker_1']]
        : ['0', []],
      mget: async () => [
        JSON.stringify({
          worker_id: 'worker_1',
          role: 'worker',
          hostname: 'node-1',
          ip_addresses: ['172.24.0.8'],
          pid: 123,
          started_at: '2026-06-22T01:00:00.000Z',
          last_seen_at: '2026-06-22T01:02:00.000Z',
          worker_concurrency: 20,
          image_processing_concurrency: 10,
          active_tasks: 1,
          completed_since_start: 7,
          failed_since_start: 1,
          rss_bytes: 123456789,
          heap_used_bytes: 23456789,
          last_error_code: 'upstream_error',
          current_tasks: [
            {
              client_task_id: 'task_2',
              provider_task_id: 'imgtask_2',
              operation: 'generation',
              model: 'gpt-image-2',
              started_at: '2026-06-22T01:01:30.000Z'
            }
          ]
        })
      ]
    },
    taskQueue: {
      getJobCounts: async () => ({
        waiting: 3,
        active: 1,
        delayed: 2,
        completed: 9,
        failed: 1,
        paused: 0
      })
    }
  } as unknown as QueueClients;
  const app = buildServer(buildTestConfig(upstream.baseUrl), {
    asyncTaskStore: fakeAsyncStore,
    queueClients: fakeQueueClients,
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const login = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/login',
    payload: {
      password: 'admin-pass'
    }
  });
  const cookie = getCookie(login.headers['set-cookie']);

  const summary = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/async/summary',
    headers: {
      cookie
    }
  });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().enabled, true);
  assert.equal(summary.json().tasks.queued, 1);
  assert.equal(summary.json().callbacks.pending, 1);
  assert.equal(summary.json().queue.waiting, 3);
  assert.equal(summary.json().queue.failed, 1);
  assert.equal(summary.json().workers.total, 1);
  assert.equal(summary.json().workers.active_tasks, 1);
  assert.equal(summary.json().workers.image_processing_concurrency, 10);
  assert.equal(summary.json().workers.data[0].current_tasks[0].client_task_id, 'task_2');

  const tasks = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/async/tasks?page=1&page_size=10',
    headers: {
      cookie
    }
  });
  assert.equal(tasks.statusCode, 200);
  assert.equal(tasks.json().data[0].client_task_id, 'task_1');
  assert.equal(tasks.json().data[0].first_image_url, 'https://img.example.com/images/test.png');

  const callbacks = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/async/callbacks?page=1&page_size=10',
    headers: {
      cookie
    }
  });
  assert.equal(callbacks.statusCode, 200);
  assert.equal(callbacks.json().data[0].event_id, 'evt_1');
  assert.equal(callbacks.json().data[0].secret_id, 'channel_123');

  await app.close();
  await upstream.close();
});

test('admin drain mode rejects new image requests and reports safe restart state', async () => {
  const upstream = await buildUpstream();
  const app = buildServer(buildTestConfig(upstream.baseUrl), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const login = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/login',
    payload: {
      password: 'admin-pass'
    }
  });
  const cookie = getCookie(login.headers['set-cookie']);

  const enableDrain = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/api/drain',
    headers: {
      cookie
    },
    payload: {
      draining: true,
      reason: 'test maintenance'
    }
  });
  assert.equal(enableDrain.statusCode, 200);
  assert.equal(enableDrain.json().data.draining, true);

  const summary = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/summary',
    headers: {
      cookie
    }
  });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().runtime.draining, true);
  assert.equal(summary.json().runtime.safeToRestart, true);

  const imageResponse = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer secret-new-api-key'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test'
    }
  });
  assert.equal(imageResponse.statusCode, 503);
  assert.equal(imageResponse.headers['retry-after'], '120');
  assert.equal(imageResponse.json().error.code, 'service_draining');

  const records = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/requests?page=1&page_size=10',
    headers: {
      cookie
    }
  });
  assert.equal(records.statusCode, 200);
  assert.equal(records.json().data[0].errorCode, 'service_draining');

  await app.close();
  await upstream.close();
});

test('successful image requests are recorded without prompt or authorization', async () => {
  const upstream = await buildUpstream();
  const store = new AdminStore(':memory:');
  const app = buildServer(buildTestConfig(upstream.baseUrl), {
    adminStore: store,
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer secret-new-api-key'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'do not save me',
      size: '2560x1440',
      quality: 'high',
      resolution: '2k',
      n: 2
    }
  });
  assert.equal(response.statusCode, 200);

  const records = store.getRecentRequests(10);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.success, true);
  assert.equal(records[0]?.operation, 'generation');
  assert.equal(records[0]?.model, 'gpt-image-2-count');
  assert.equal(records[0]?.size, '2560x1440');
  assert.deepEqual(records[0]?.requestParams, {
    model: 'gpt-image-2-count',
    n: 2,
    size: '2560x1440',
    quality: 'high',
    resolution: '2k',
    output_format: 'png'
  });
  assert.deepEqual(records[0]?.responseParams, {
    created: 1780000000,
    format: 'png',
    width: 1,
    height: 1,
    size: '1x1',
    bytes: 68,
    count: 1
  });
  assert.equal(records[0]?.imageCount, 1);
  assert.match(records[0]?.imageUrls[0] ?? '', /^https:\/\/img\.example\.com\/images\//);
  assert.equal(JSON.stringify(records).includes('do not save me'), false);
  assert.equal(JSON.stringify(records).includes('secret-new-api-key'), false);

  await app.close();
  await upstream.close();
});

test('xAI URL image requests are recorded as passthrough URLs', async () => {
  const upstream = Fastify();
  let imageUrl = '';
  let imageGets = 0;
  let uploadCalls = 0;

  upstream.get('/xai-generated.jpg', async (_request, reply) => {
    imageGets += 1;
    reply.header('content-type', 'image/jpeg');
    return reply.send(tinyJpegBuffer);
  });
  upstream.post('/v1/images/generations', async () => ({
    created: 1780000000,
    data: [
      {
        url: imageUrl,
        mime_type: 'image/jpeg'
      }
    ]
  }));

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const address = upstream.server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as AddressInfo).port;
  imageUrl = `http://127.0.0.1:${port}/xai-generated.jpg`;

  const store = new AdminStore(':memory:');
  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`), {
    adminStore: store,
    uploadImageToR2: async () => {
      uploadCalls += 1;
      return 'https://img.example.com/unexpected.jpg';
    }
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer secret-new-api-key'
    },
    payload: {
      model: 'grok-imagine-image',
      prompt: 'do not save me'
    }
  });
  assert.equal(response.statusCode, 200);

  const records = store.getRecentRequests(10);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.success, true);
  assert.equal(records[0]?.model, 'grok-imagine-image');
  assert.equal(records[0]?.imageCount, 1);
  assert.equal(records[0]?.imageBytes, 0);
  assert.equal(records[0]?.imageUrls[0], imageUrl);
  assert.equal(imageGets, 0);
  assert.equal(uploadCalls, 0);
  assert.deepEqual(records[0]?.responseParams?.formats, []);
  assert.deepEqual(records[0]?.responseParams?.sourceTypes, ['url']);
  assert.equal(records[0]?.responseParams?.strategy, 'xai-grok-imagine');

  await app.close();
  store.close();
  await upstream.close();
});

test('admin request and image APIs return paginated records', async () => {
  const upstream = await buildUpstream();
  const app = buildServer(buildTestConfig(upstream.baseUrl), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const login = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/login',
    payload: {
      password: 'admin-pass'
    }
  });
  const cookie = getCookie(login.headers['set-cookie']);

  const generationResponse = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer secret-new-api-key'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'do not save me',
      size: '2560x1440'
    }
  });
  assert.equal(generationResponse.statusCode, 200);

  const editResponse = await app.inject({
    method: 'POST',
    url: '/v1/images/edits',
    headers: {
      authorization: 'Bearer secret-new-api-key'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'do not save me',
      size: '3840x2160'
    }
  });
  assert.equal(editResponse.statusCode, 200);

  const requests = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/requests?page=1&page_size=1',
    headers: {
      cookie
    }
  });
  assert.equal(requests.statusCode, 200);
  assert.equal(requests.json().data.length, 1);
  assert.equal(requests.json().page, 1);
  assert.equal(requests.json().pageSize, 1);
  assert.equal(requests.json().total, 2);
  assert.equal(requests.json().totalPages, 2);
  assert.equal(['generation', 'edit'].includes(requests.json().data[0].operation), true);

  const images = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/images?page=1&page_size=10',
    headers: {
      cookie
    }
  });
  assert.equal(images.statusCode, 200);
  assert.equal(images.json().data.length, 2);
  assert.equal(images.json().total, 2);
  assert.equal(['generation', 'edit'].includes(images.json().data[0].operation), true);
  assert.match(images.json().data[0].imageUrls[0] ?? '', /^https:\/\/img\.example\.com\/images\//);

  await app.close();
  await upstream.close();
});

test('admin can upload local image to R2 and see it in image records', async () => {
  const upstream = await buildUpstream();
  const store = new AdminStore(':memory:');
  let uploadedKey = '';
  let uploadedContentType = '';
  let uploadedBytes = 0;
  const app = buildServer(buildTestConfig(upstream.baseUrl), {
    adminStore: store,
    uploadImageToR2: async ({ key, contentType, buffer }) => {
      uploadedKey = key;
      uploadedContentType = contentType;
      uploadedBytes = buffer.length;
      return `https://img.example.com/${key}`;
    }
  });

  const unauthenticatedForm = new FormData();
  unauthenticatedForm.append('image', new Blob([Buffer.from(tinyPngBase64, 'base64')], { type: 'image/png' }), 'local.png');
  const unauthenticated = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/api/upload',
    payload: unauthenticatedForm
  });
  assert.equal(unauthenticated.statusCode, 401);

  const login = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/login',
    payload: {
      password: 'admin-pass'
    }
  });
  const cookie = getCookie(login.headers['set-cookie']);

  const form = new FormData();
  form.append('image', new Blob([Buffer.from(tinyPngBase64, 'base64')], { type: 'image/png' }), 'local.png');
  const response = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/api/upload',
    headers: {
      cookie
    },
    payload: form
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.json().data.url, /^https:\/\/img\.example\.com\/images\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);
  assert.equal(response.json().data.key, uploadedKey);
  assert.equal(response.json().data.filename, 'local.png');
  assert.equal(response.json().data.contentType, 'image/png');
  assert.equal(response.json().data.format, 'png');
  assert.equal(response.json().data.width, 1);
  assert.equal(response.json().data.height, 1);
  assert.equal(response.json().data.bytes, 68);
  assert.equal(uploadedContentType, 'image/png');
  assert.equal(uploadedBytes, 68);

  const images = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/images?page=1&page_size=10',
    headers: {
      cookie
    }
  });
  assert.equal(images.statusCode, 200);
  assert.equal(images.json().total, 1);
  assert.equal(images.json().data[0].operation, 'manual_upload');
  assert.equal(images.json().data[0].imageUrls[0], response.json().data.url);
  assert.deepEqual(images.json().data[0].responseParams, {
    format: 'png',
    width: 1,
    height: 1,
    size: '1x1',
    bytes: 68,
    count: 1,
    filename: 'local.png',
    key: uploadedKey
  });

  await app.close();
  await upstream.close();
});

test('admin local upload rejects unsupported image files', async () => {
  const upstream = await buildUpstream();
  const store = new AdminStore(':memory:');
  const app = buildServer(buildTestConfig(upstream.baseUrl), {
    adminStore: store,
    uploadImageToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const login = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/login',
    payload: {
      password: 'admin-pass'
    }
  });
  const cookie = getCookie(login.headers['set-cookie']);

  const form = new FormData();
  form.append('image', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'note.txt');
  const response = await app.inject({
    method: 'POST',
    url: '/image-wrapper/admin/api/upload',
    headers: {
      cookie
    },
    payload: form
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'unsupported_upload_image');

  const records = store.getRecentRequests(10);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.operation, 'manual_upload');
  assert.equal(records[0]?.success, false);
  assert.equal(records[0]?.errorCode, 'unsupported_upload_image');

  await app.close();
  await upstream.close();
});

test('failed image requests are recorded with error code', async () => {
  const upstream = await buildUpstream();
  const store = new AdminStore(':memory:');
  const app = buildServer(buildTestConfig(upstream.baseUrl), {
    adminStore: store,
    uploadPngToR2: async () => {
      throw new Error('upload failed');
    }
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer secret-new-api-key'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test'
    }
  });
  assert.equal(response.statusCode, 502);

  const records = store.getRecentRequests(10);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.success, false);
  assert.equal(records[0]?.errorCode, 'r2_upload_failed');
  assert.equal(store.getErrors()[0]?.code, 'r2_upload_failed');

  await app.close();
  await upstream.close();
});

test('upstream image errors record upstream status code and message', async () => {
  const upstream = Fastify();
  const store = new AdminStore(':memory:');

  upstream.post('/v1/images/generations', async (_request, reply) => reply.status(500).send({
    error: {
      message: 'status_code=403, image generation quota exceeded',
      type: 'server_error',
      code: 'image_generation_quota_exceeded',
      status_code: 403
    }
  }));

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const address = upstream.server.address();
  assert.ok(address && typeof address === 'object');

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${(address as AddressInfo).port}`), {
    adminStore: store,
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer secret-new-api-key'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test',
      size: '3840x2160'
    }
  });
  assert.equal(response.statusCode, 500);

  const records = store.getRecentRequests(10);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.statusCode, 403);
  assert.equal(records[0]?.errorCode, 'image_generation_quota_exceeded');
  assert.equal(records[0]?.errorMessage, 'status_code=403, image generation quota exceeded');

  await app.close();
  await upstream.close();
});

test('memory guard failures are recorded with error code', async () => {
  const upstream = await buildUpstream();
  const store = new AdminStore(':memory:');
  const app = buildServer(buildTestConfig(upstream.baseUrl, {
    limits: {
      maxProcessRssBytes: 1
    }
  }), {
    adminStore: store,
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer secret-new-api-key'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test'
    }
  });
  assert.equal(response.statusCode, 503);

  const records = store.getRecentRequests(10);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.success, false);
  assert.equal(records[0]?.errorCode, 'server_memory_limit_exceeded');
  assert.equal(store.getErrors()[0]?.code, 'server_memory_limit_exceeded');

  await app.close();
  await upstream.close();
});

test('admin error distribution is limited to the last day and paginated', () => {
  const store = new AdminStore(':memory:');
  const now = Date.now();
  const recentCodes = ['a', 'b', 'c', 'd', 'e', 'f'];

  for (const [index, code] of recentCodes.entries()) {
    store.recordRequest({
      requestId: `recent-${code}`,
      createdAt: new Date(now - index * 60 * 1000).toISOString(),
      operation: 'generation',
      statusCode: 500,
      success: false,
      totalMs: 1,
      openaiMs: 1,
      decodeMs: 0,
      uploadMs: 0,
      imageBytes: 0,
      imageCount: 0,
      errorCode: code,
      imageUrls: []
    });
  }
  store.recordRequest({
    requestId: 'old-error',
    createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    operation: 'generation',
    statusCode: 500,
    success: false,
    totalMs: 1,
    openaiMs: 1,
    decodeMs: 0,
    uploadMs: 0,
    imageBytes: 0,
    imageCount: 0,
    errorCode: 'old_error',
    imageUrls: []
  });

  const firstPage = store.getErrorsPage(1, 5, 24);
  assert.equal(firstPage.total, 6);
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.pageSize, 5);
  assert.equal(firstPage.windowHours, 24);
  assert.equal(firstPage.data.length, 5);
  assert.equal(firstPage.data.some((item) => item.code === 'old_error'), false);

  const secondPage = store.getErrorsPage(2, 5, 24);
  assert.equal(secondPage.page, 2);
  assert.equal(secondPage.data.length, 1);

  store.close();
});

test('admin store cleanup removes records older than retention window', () => {
  const store = new AdminStore(':memory:');
  store.recordRequest({
    requestId: 'old',
    createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
    operation: 'generation',
    statusCode: 200,
    success: true,
    totalMs: 1,
    openaiMs: 1,
    decodeMs: 0,
    uploadMs: 0,
    imageBytes: 0,
    imageCount: 0,
    imageUrls: []
  });
  store.recordRequest({
    requestId: 'new',
    createdAt: new Date().toISOString(),
    operation: 'edit',
    statusCode: 200,
    success: true,
    totalMs: 1,
    openaiMs: 1,
    decodeMs: 0,
    uploadMs: 0,
    imageBytes: 0,
    imageCount: 0,
    imageUrls: []
  });

  assert.equal(store.cleanup(7), 1);
  const records = store.getRecentRequests(10);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.requestId, 'new');
  assert.equal(records[0]?.operation, 'edit');
  store.close();
});
