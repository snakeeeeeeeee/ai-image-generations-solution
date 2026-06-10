import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AdminStore } from '../src/admin/store.js';
import { buildServer } from '../src/server.js';
import type { AppConfig } from '../src/config.js';

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
      cacheControl: 'public, max-age=86400'
    },
    admin: {
      basePath: '/image-wrapper/admin',
      password: 'admin-pass',
      sessionSecret: 'test-session-secret-at-least-long-enough',
      dbPath: ':memory:',
      retentionDays: 7,
      recentLimit: 1000,
      cookieSecure: false
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
      size: '2560x1440'
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
    size: '2560x1440',
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

test('xAI URL image requests are recorded with R2 image URLs', async () => {
  const upstream = Fastify();
  let imageUrl = '';

  upstream.get('/xai-generated.jpg', async (_request, reply) => {
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
    uploadImageToR2: async ({ key }) => `https://img.example.com/${key}`
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
  assert.equal(records[0]?.imageBytes, tinyJpegBuffer.length);
  assert.match(records[0]?.imageUrls[0] ?? '', /^https:\/\/img\.example\.com\/images\/\d{4}\/\d{2}\/\d{2}\/.+\.jpg$/);
  assert.equal(JSON.stringify(records).includes(imageUrl), false);
  assert.deepEqual(records[0]?.responseParams?.formats, ['jpeg']);
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
