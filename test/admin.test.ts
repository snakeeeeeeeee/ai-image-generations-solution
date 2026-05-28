import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AdminStore } from '../src/admin/store.js';
import { buildServer } from '../src/server.js';
import type { AppConfig } from '../src/config.js';

const tinyPngBase64 = 'iVBORw0KGgo=';

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
      timeoutMs: 5000
    },
    defaults: {
      size: '2560x1440',
      outputFormat: 'png'
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
  assert.equal(records[0]?.model, 'gpt-image-2-count');
  assert.equal(records[0]?.size, '2560x1440');
  assert.equal(records[0]?.imageCount, 1);
  assert.match(records[0]?.imageUrls[0] ?? '', /^https:\/\/img\.example\.com\/images\//);
  assert.equal(JSON.stringify(records).includes('do not save me'), false);
  assert.equal(JSON.stringify(records).includes('secret-new-api-key'), false);

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

test('admin store cleanup removes records older than retention window', () => {
  const store = new AdminStore(':memory:');
  store.recordRequest({
    requestId: 'old',
    createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
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
  store.close();
});
