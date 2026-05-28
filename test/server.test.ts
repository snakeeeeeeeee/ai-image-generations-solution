import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import Fastify from 'fastify';
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
      maxConcurrentGenerations: 200,
      maxConcurrentImageProcessing: 50
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

  const body = response.json() as { created: number; data: Array<{ url: string }> };
  assert.equal(body.created, 1780000000);
  assert.match(body.data[0]?.url ?? '', /^https:\/\/img\.example\.com\/images\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);

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

test('POST /v1/images/generations returns 429 when image processing limit is reached', async () => {
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

  const statusCodes = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statusCodes, [200, 429]);

  const rejected = first.statusCode === 429 ? first : second;
  assert.equal(rejected.json().error.code, 'too_many_image_processing_requests');

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
