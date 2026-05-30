import Fastify from 'fastify';

const port = Number.parseInt(process.env.MOCK_NEW_API_PORT || '3999', 10);
const host = process.env.MOCK_NEW_API_HOST || '127.0.0.1';

const app = Fastify({
  logger: true
});

// A tiny valid PNG. This is enough to verify decode, upload, and public URL flow.
const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

app.get('/healthz', async () => ({
  ok: true
}));

app.post('/v1/images/generations', async (request) => {
  request.log.info({
    authorization_present: Boolean(request.headers.authorization),
    body: request.body
  }, 'mock new-api received image request');

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
  }, 'mock new-api received image edit request');

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
