import multipart from '@fastify/multipart';
import Fastify from 'fastify';

const port = Number.parseInt(process.env.MOCK_NEW_API_PORT || '3999', 10);
const host = process.env.MOCK_NEW_API_HOST || '127.0.0.1';
const upstreamBaseUrl = (process.env.MOCK_UPSTREAM_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');

const app = Fastify({
  logger: true
});
await app.register(multipart);

// 一个极小的合法 PNG，用于验证解码、上传和公开 URL 流程。
const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

app.get('/healthz', async () => ({
  ok: true
}));

app.post('/api/task/callback/external-image/batch', async (request) => {
  const body = request.body as { events?: Array<{ client_task_id?: string; provider_task_id?: string }> };
  request.log.info({
    headers: {
      secret_id: request.headers['x-callback-secret-id'],
      event_id: request.headers['x-callback-event-id']
    },
    body
  }, 'mock new-api 收到图片批量回调');

  return {
    code: 'success',
    results: (body.events ?? []).map((event) => ({
      client_task_id: event.client_task_id,
      provider_task_id: event.provider_task_id,
      status: 'accepted'
    }))
  };
});

app.post('/api/task/callback/external-image/:taskId', async (request) => {
  const params = request.params as { taskId: string };
  request.log.info({
    task_id: params.taskId,
    headers: {
      secret_id: request.headers['x-callback-secret-id'],
      event_id: request.headers['x-callback-event-id']
    },
    body: request.body
  }, 'mock new-api 收到图片单条回调');

  return {
    code: 'success',
    results: [
      {
        task_id: params.taskId,
        status: 'accepted'
      }
    ]
  };
});

app.post('/api/internal/image/credential-leases/:leaseId/resolve', async (request) => {
  const params = request.params as { leaseId: string };
  request.log.info({
    lease_id: params.leaseId,
    headers: {
      secret_id: request.headers['x-imagehandle-secret-id'],
      event_id: request.headers['x-imagehandle-event-id'],
      timestamp: request.headers['x-imagehandle-timestamp'],
      signature_present: Boolean(request.headers['x-imagehandle-signature'])
    },
    body: request.body
  }, 'mock new-api 收到 credential lease resolve 请求');

  return {
    provider: 'openai_compatible',
    request_format: 'openai_images',
    base_url: upstreamBaseUrl,
    api_key: 'mock-upstream-key',
    model: 'gpt-image-2',
    channel_id: 'mock-channel',
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };
});

app.post('/images/generations', async (request) => {
  request.log.info({
    authorization_present: Boolean(request.headers.authorization),
    body: request.body
  }, 'mock 上游收到 direct lease 图片生成请求');

  return {
    id: `mock_${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-image-2',
    usage: {
      total_tokens: 0
    },
    data: [
      {
        b64_json: tinyPngBase64,
        revised_prompt: 'mock revised prompt'
      }
    ]
  };
});

app.post('/images/edits', async (request) => {
  if (request.isMultipart()) {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        await part.toBuffer();
      }
    }
  }
  request.log.info({
    authorization_present: Boolean(request.headers.authorization),
    content_type: request.headers['content-type']
  }, 'mock 上游收到 direct lease 图片编辑请求');

  return {
    id: `mock_edit_${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-image-2',
    usage: {
      total_tokens: 0
    },
    data: [
      {
        b64_json: tinyPngBase64,
        revised_prompt: 'mock edited prompt'
      }
    ]
  };
});

app.post('/v1/images/generations', async (request) => {
  request.log.info({
    authorization_present: Boolean(request.headers.authorization),
    body: request.body
  }, 'mock new-api 收到图片生成请求');

  return {
    created: Math.floor(Date.now() / 1000),
    data: [
      {
        b64_json: tinyPngBase64
      }
    ]
  };
});

app.post('/v1/images/edits', async (request) => {
  request.log.info({
    authorization_present: Boolean(request.headers.authorization),
    content_type: request.headers['content-type'],
    body: request.body
  }, 'mock new-api 收到图片编辑请求');

  return {
    created: Math.floor(Date.now() / 1000),
    data: [
      {
        b64_json: tinyPngBase64
      }
    ]
  };
});

await app.listen({
  host,
  port
});
