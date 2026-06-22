import Fastify from 'fastify';

const port = Number.parseInt(process.env.MOCK_NEW_API_PORT || '3999', 10);
const host = process.env.MOCK_NEW_API_HOST || '127.0.0.1';

const app = Fastify({
  logger: true
});

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
