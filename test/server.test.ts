import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import Fastify from 'fastify';
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
      internalExecuteSecrets: {},
      internalExecuteAllowedHosts: ['127.0.0.1:1'],
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
      internalExecuteSecrets: base.asyncTasks.internalExecuteSecrets,
      internalExecuteAllowedHosts: base.asyncTasks.internalExecuteAllowedHosts,
      taskStaleProcessingTimeoutSeconds: overrides.asyncTasks?.taskStaleProcessingTimeoutSeconds ?? base.asyncTasks.taskStaleProcessingTimeoutSeconds
    }
  };
}

test('POST /v1/images/generations uploads image and returns URL', async () => {
  const upstream = Fastify();
  let upstreamRequestBody: Record<string, unknown> | undefined;
  let upstreamAuth: string | undefined;

  upstream.post('/v1/images/generations', async (request) => {
    upstreamRequestBody = request.body as Record<string, unknown>;
    upstreamAuth = request.headers.authorization;
    return {
      created: 1780000000,
      data: [
        {
          b64_json: tinyPngBase64
        }
      ]
    };
  });

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const config = buildTestConfig(`http://127.0.0.1:${port}`);

  const app = buildServer(config, {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test',
      output_format: 'webp'
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamAuth, 'Bearer test-key');
  assert.equal(upstreamRequestBody?.size, '2560x1440');
  assert.equal(upstreamRequestBody?.output_format, 'png');

  const body = response.json() as { created: number; created_at_beijing: string; data: Array<{ url: string }> };
  assert.equal(body.created, 1780000000);
  assert.equal(body.created_at_beijing, '2026-05-29 04:26:40');
  assert.match(body.data[0]?.url ?? '', /^https:\/\/img\.example\.com\/images\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);

  await app.close();
  await upstream.close();
});

test('POST /v1/images/generations downloads xAI image URLs and uploads JPEG to R2', async () => {
  const upstream = Fastify();
  let upstreamRequestBody: Record<string, unknown> | undefined;
  let imageUrl = '';
  const uploaded: Array<{ key: string; contentType: string; bytes: number }> = [];

  upstream.get('/xai-generated.jpg', async (_request, reply) => {
    reply.header('content-type', 'image/jpeg');
    return reply.send(tinyJpegBuffer);
  });
  upstream.post('/v1/images/generations', async (request) => {
    upstreamRequestBody = request.body as Record<string, unknown>;
    return {
      created: 1780000000,
      data: [
        {
          url: imageUrl,
          mime_type: 'image/jpeg'
        },
        {
          url: imageUrl,
          mime_type: 'image/jpeg'
        }
      ]
    };
  });

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;
  imageUrl = `http://127.0.0.1:${port}/xai-generated.jpg`;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`), {
    uploadImageToR2: async ({ key, contentType, buffer }) => {
      uploaded.push({ key, contentType, bytes: buffer.length });
      return `https://img.example.com/${key}`;
    }
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'grok-imagine-image-quality',
      prompt: 'test'
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamRequestBody?.size, undefined);
  assert.equal(upstreamRequestBody?.output_format, undefined);
  assert.equal(uploaded.length, 2);
  assert.equal(uploaded[0]?.contentType, 'image/jpeg');
  assert.equal(uploaded[0]?.bytes, tinyJpegBuffer.length);
  assert.match(uploaded[0]?.key ?? '', /^images\/\d{4}\/\d{2}\/\d{2}\/.+\.jpg$/);

  const body = response.json() as { data: Array<{ url: string }> };
  assert.equal(body.data.length, 2);
  assert.match(body.data[0]?.url ?? '', /^https:\/\/img\.example\.com\/images\/\d{4}\/\d{2}\/\d{2}\/.+\.jpg$/);
  assert.match(body.data[1]?.url ?? '', /^https:\/\/img\.example\.com\/images\/\d{4}\/\d{2}\/\d{2}\/.+\.jpg$/);

  await app.close();
  await upstream.close();
});

test('POST /v1/images/generations accepts xAI b64_json image responses', async () => {
  const upstream = Fastify();
  const uploaded: Array<{ key: string; contentType: string }> = [];

  upstream.post('/v1/images/generations', async () => ({
    created: 1780000000,
    data: [
      {
        b64_json: tinyPngBase64,
        mime_type: 'image/png'
      }
    ]
  }));

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`), {
    uploadImageToR2: async ({ key, contentType }) => {
      uploaded.push({ key, contentType });
      return `https://img.example.com/${key}`;
    }
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'grok-imagine-image',
      prompt: 'test'
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(uploaded[0]?.contentType, 'image/png');
  assert.match(uploaded[0]?.key ?? '', /^images\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);

  const body = response.json() as { data: Array<{ url: string }> };
  assert.match(body.data[0]?.url ?? '', /^https:\/\/img\.example\.com\/images\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);

  await app.close();
  await upstream.close();
});

test('POST /v1/images/generations keeps GPT image strategy b64_json-only', async () => {
  const upstream = Fastify();

  upstream.post('/v1/images/generations', async () => ({
    created: 1780000000,
    data: [
      {
        url: 'https://example.com/generated.png'
      }
    ]
  }));

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`), {
    uploadImageToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'gpt-image-2',
      prompt: 'test'
    }
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, 'missing_b64_json');

  await app.close();
  await upstream.close();
});

test('POST /v1/images/generations rejects xAI image URL with non-image body', async () => {
  const upstream = Fastify();
  let imageUrl = '';

  upstream.get('/not-image.txt', async (_request, reply) => {
    reply.header('content-type', 'text/plain');
    return reply.send('not image');
  });
  upstream.post('/v1/images/generations', async () => ({
    created: 1780000000,
    data: [
      {
        url: imageUrl,
        mime_type: 'text/plain'
      }
    ]
  }));

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;
  imageUrl = `http://127.0.0.1:${port}/not-image.txt`;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`), {
    uploadImageToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'grok-imagine-image',
      prompt: 'test'
    }
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, 'unsupported_image_format');

  await app.close();
  await upstream.close();
});

test('OPTIONS /v1/images/generations responds to browser CORS preflight', async () => {
  const app = buildServer(buildTestConfig('http://127.0.0.1:1'));

  const response = await app.inject({
    method: 'OPTIONS',
    url: '/v1/images/generations',
    headers: {
      origin: 'https://client.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type'
    }
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['access-control-allow-methods'], 'POST, OPTIONS');
  assert.equal(response.headers['access-control-allow-headers'], 'authorization,content-type');

  await app.close();
});

test('image API CORS can restrict allowed origins', async () => {
  const app = buildServer(buildTestConfig('http://127.0.0.1:1', {
    cors: {
      allowedOrigins: ['https://allowed.example.com'],
      maxAgeSeconds: 600
    }
  }));

  const allowed = await app.inject({
    method: 'OPTIONS',
    url: '/v1/images/edits',
    headers: {
      origin: 'https://allowed.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type'
    }
  });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://allowed.example.com');
  assert.equal(allowed.headers['access-control-max-age'], '600');

  const blocked = await app.inject({
    method: 'OPTIONS',
    url: '/v1/images/edits',
    headers: {
      origin: 'https://blocked.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type'
    }
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.headers['access-control-allow-origin'], undefined);

  await app.close();
});

test('image API POST includes CORS header but admin API does not', async () => {
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
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const imageResponse = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      origin: 'https://client.example.com',
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test'
    }
  });
  assert.equal(imageResponse.statusCode, 200);
  assert.equal(imageResponse.headers['access-control-allow-origin'], '*');

  const adminResponse = await app.inject({
    method: 'GET',
    url: '/image-wrapper/admin/api/summary',
    headers: {
      origin: 'https://client.example.com'
    }
  });
  assert.equal(adminResponse.headers['access-control-allow-origin'], undefined);

  await app.close();
  await upstream.close();
});

test('POST /v1/images/generations honors configured upstream header timeout', async () => {
  const upstream = Fastify();

  upstream.post('/v1/images/generations', async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      created: 1780000000,
      data: [
        {
          b64_json: tinyPngBase64
        }
      ]
    };
  });

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`, {
    upstream: {
      timeoutMs: 50
    }
  }), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test'
    }
  });

  assert.equal(response.statusCode, 504);
  assert.equal(response.json().error.code, 'upstream_timeout');

  await app.close();
  await upstream.close();
});

test('POST /v1/images/edits forwards JSON image edit request and returns URL', async () => {
  const upstream = Fastify();
  let upstreamRequestBody: Record<string, unknown> | undefined;
  let upstreamAuth: string | undefined;

  upstream.post('/v1/images/edits', async (request) => {
    upstreamRequestBody = request.body as Record<string, unknown>;
    upstreamAuth = request.headers.authorization;
    return {
      created: 1780000000,
      data: [
        {
          b64_json: tinyPngBase64
        }
      ]
    };
  });

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/edits',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'edit test',
      image: [
        {
          image_url: 'https://example.com/input.png'
        }
      ],
      output_format: 'webp'
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamAuth, 'Bearer test-key');
  assert.equal(upstreamRequestBody?.size, '2560x1440');
  assert.equal(upstreamRequestBody?.output_format, 'png');
  assert.deepEqual(upstreamRequestBody?.image, [{ image_url: 'https://example.com/input.png' }]);

  const body = response.json() as { data: Array<{ url: string }> };
  assert.match(body.data[0]?.url ?? '', /^https:\/\/img\.example\.com\/images\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);

  await app.close();
  await upstream.close();
});

test('POST /v1/images/edits forwards multipart image edit request and returns URL', async () => {
  const upstream = Fastify();
  let upstreamAuth: string | undefined;
  let upstreamContentType: string | undefined;
  const received: Record<string, unknown> = {};

  await upstream.register((await import('@fastify/multipart')).default);
  upstream.post('/v1/images/edits', async (request) => {
    upstreamAuth = request.headers.authorization;
    upstreamContentType = request.headers['content-type'];
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        received[part.fieldname] = {
          filename: part.filename,
          mimetype: part.mimetype,
          bytes: (await part.toBuffer()).length
        };
      } else {
        received[part.fieldname] = part.value;
      }
    }

    return {
      created: 1780000000,
      data: [
        {
          b64_json: tinyPngBase64
        }
      ]
    };
  });

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const appAddress = app.server.address();
  assert.ok(appAddress && typeof appAddress === 'object');
  const appPort = (appAddress as AddressInfo).port;

  const form = new FormData();
  form.append('model', 'gpt-image-2-count');
  form.append('prompt', 'edit test');
  form.append('image', new Blob([Buffer.from('input-image')], { type: 'image/png' }), 'input.png');

  const response = await fetch(`http://127.0.0.1:${appPort}/v1/images/edits`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-key'
    },
    body: form
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamAuth, 'Bearer test-key');
  assert.match(upstreamContentType ?? '', /^multipart\/form-data; boundary=/);
  assert.deepEqual(received.image, {
    filename: 'input.png',
    mimetype: 'image/png',
    bytes: 11
  });
  assert.equal(received.model, 'gpt-image-2-count');
  assert.equal(received.prompt, 'edit test');
  assert.equal(received.size, '2560x1440');
  assert.equal(received.output_format, 'png');

  const body = await response.json() as { data: Array<{ url: string }> };
  assert.match(body.data[0]?.url ?? '', /^https:\/\/img\.example\.com\/images\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);

  await app.close();
  await upstream.close();
});

test('POST /v1/images/generations retries transient R2 upload failures', async () => {
  const upstream = Fastify();
  let attempts = 0;

  upstream.post('/v1/images/generations', async () => ({
    created: 1780000000,
    data: [
      {
        b64_json: tinyPngBase64
      }
    ]
  }));

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`, {
    upload: {
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2
    }
  }), {
    uploadPngToR2: async ({ key }) => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('temporary upload failure');
      }
      return `https://img.example.com/${key}`;
    }
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test'
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(attempts, 3);

  await app.close();
  await upstream.close();
});

test('POST /v1/images/generations returns 429 when concurrency limit is reached', async () => {
  const upstream = Fastify();

  upstream.post('/v1/images/generations', async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      created: 1780000000,
      data: [
        {
          b64_json: tinyPngBase64
        }
      ]
    };
  });

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`, {
    limits: {
      maxConcurrentGenerations: 1
    }
  }), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const request = {
    method: 'POST' as const,
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test'
    }
  };

  const [first, second] = await Promise.all([
    app.inject(request),
    app.inject(request)
  ]);

  const statusCodes = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statusCodes, [200, 429]);

  const rejected = first.statusCode === 429 ? first : second;
  assert.equal(rejected.json().error.code, 'too_many_generation_requests');

  const health = await app.inject({
    method: 'GET',
    url: '/healthz'
  });
  assert.equal(health.json().active_generations, 0);
  assert.equal(health.json().max_concurrent_generations, 1);
  assert.equal(health.json().active_image_processing, 0);

  await app.close();
  await upstream.close();
});

test('POST /v1/images/generations queues when image processing limit is reached', async () => {
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
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`, {
    limits: {
      maxConcurrentGenerations: 10,
      maxConcurrentImageProcessing: 1
    }
  }), {
    uploadPngToR2: async ({ key }) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return `https://img.example.com/${key}`;
    }
  });

  const request = {
    method: 'POST' as const,
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test'
    }
  };

  const [first, second] = await Promise.all([
    app.inject(request),
    app.inject(request)
  ]);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);

  const health = await app.inject({
    method: 'GET',
    url: '/healthz'
  });
  assert.equal(health.json().active_generations, 0);
  assert.equal(health.json().active_image_processing, 0);
  assert.equal(health.json().max_concurrent_image_processing, 1);

  await app.close();
  await upstream.close();
});

test('POST /v1/images/generations returns 503 when process RSS guard is exceeded', async () => {
  const upstream = Fastify();
  let upstreamCalled = false;

  upstream.post('/v1/images/generations', async () => {
    upstreamCalled = true;
    return {
      created: 1780000000,
      data: [
        {
          b64_json: tinyPngBase64
        }
      ]
    };
  });

  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamAddress = upstream.server.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const port = (upstreamAddress as AddressInfo).port;

  const app = buildServer(buildTestConfig(`http://127.0.0.1:${port}`, {
    limits: {
      maxProcessRssBytes: 1
    }
  }), {
    uploadPngToR2: async ({ key }) => `https://img.example.com/${key}`
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/images/generations',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json'
    },
    payload: {
      model: 'gpt-image-2-count',
      prompt: 'test'
    }
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'server_memory_limit_exceeded');
  assert.equal(upstreamCalled, false);

  await app.close();
  await upstream.close();
});
