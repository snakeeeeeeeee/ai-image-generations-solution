import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import Fastify from 'fastify';
import { buildServer } from '../src/server.js';
import type { AppConfig } from '../src/config.js';

const tinyPngBase64 = 'iVBORw0KGgo=';

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

  const config: AppConfig = {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    bodyLimitBytes: 100 * 1024 * 1024,
    upstream: {
      baseUrl: `http://127.0.0.1:${port}`,
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
