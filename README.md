# image-handle

TypeScript OpenAI-compatible image generation wrapper for new-api.

The service accepts `POST /v1/images/generations` and
`POST /v1/images/edits`, forwards the caller's `Authorization` header to
new-api, uploads returned `b64_json` PNG images to Cloudflare R2, and returns
public image URLs instead of base64 JSON.

## Flow

```text
client
  -> image-handle
  -> new-api
  -> OpenAI image generation
  -> new-api returns b64_json
  -> image-handle uploads PNG to R2
  -> client receives CDN URL
```

## Environment

Copy `.env.example` to `.env` and fill the secret values:

```env
NEW_API_BASE_URL=http://127.0.0.1:3000
NEW_API_IMAGES_PATH=/v1/images/generations
NEW_API_IMAGES_EDITS_PATH=/v1/images/edits
MAX_CONCURRENT_GENERATIONS=1000
MAX_CONCURRENT_IMAGE_PROCESSING=50
MAX_PROCESS_RSS_MB=28672
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=<bucket-name>
R2_PUBLIC_URL=https://<public-image-domain>
ADMIN_PASSWORD=<admin-console-password>
ADMIN_SESSION_SECRET=<long-random-session-secret>
ADMIN_DB_PATH=./data/admin.sqlite
ADMIN_RETENTION_DAYS=7
ADMIN_BASE_PATH=/image-wrapper/admin
```

## Run

```bash
npm install
npm run build
npm start
```

Development:

```bash
npm run dev
```

## Memory and concurrency

Image responses can temporarily hold the upstream JSON text, the base64 string,
the decoded PNG buffer, and SDK upload buffers in memory. Keep a service-level
concurrency cap even on large machines.

Recommended starting point for a large server:

```env
MAX_CONCURRENT_GENERATIONS=1000
MAX_CONCURRENT_IMAGE_PROCESSING=50
MAX_PROCESS_RSS_MB=28672
PM2_MAX_MEMORY_RESTART=30G
NODE_MAX_OLD_SPACE_SIZE_MB=24576
```

`MAX_CONCURRENT_GENERATIONS` limits total in-flight generation requests, including
the long wait for new-api/OpenAI. `MAX_CONCURRENT_IMAGE_PROCESSING` limits the
memory-heavy phase after `b64_json` is returned: decode plus R2 upload.

If 4K PNGs are larger than expected, reduce `MAX_CONCURRENT_IMAGE_PROCESSING`.
If the server remains mostly idle during load tests, increase it gradually.

`MAX_PROCESS_RSS_MB` is the service-level memory guard. When RSS reaches this
limit, the service returns `503 server_memory_limit_exceeded` before accepting
more image work. PM2's `max_memory_restart` remains the last-resort restart
guard.

## Local smoke test

This verifies wrapper -> mock new-api -> R2 -> public URL without spending a real
image generation request.

Terminal 1:

```bash
npm run mock:new-api
```

Terminal 2:

```bash
cp .env.example .env
# Fill R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in .env.
# Keep NEW_API_BASE_URL=http://127.0.0.1:3999 for this smoke test.
npm run dev
```

Terminal 3:

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H 'Authorization: Bearer local-test' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2-count",
    "prompt": "local smoke test"
  }'
```

Expected response:

```json
{
  "created": 1780000000,
  "data": [
    {
      "url": "https://<public-image-domain>/images/2026/05/29/uuid.png"
    }
  ]
}
```

Open the returned URL in a browser. If it loads, R2 credentials, custom domain,
and public access are all working.

Health check:

```bash
curl http://127.0.0.1:8787/healthz
```

Image request:

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H 'Authorization: Bearer NEW_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2-count",
    "prompt": "a mechanical cat watching sunset on a cyberpunk rooftop",
    "size": "2560x1440",
    "quality": "high"
  }'
```

Image edit request with native multipart parameters:

```bash
curl http://127.0.0.1:8787/v1/images/edits \
  -H 'Authorization: Bearer NEW_API_KEY' \
  -F 'model=gpt-image-2-count' \
  -F 'prompt=replace the sky with a clean sunset' \
  -F 'image=@./input.png' \
  -F 'size=2560x1440'
```

Image edit request with JSON image URLs:

```bash
curl http://127.0.0.1:8787/v1/images/edits \
  -H 'Authorization: Bearer NEW_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2-count",
    "prompt": "replace the sky with a clean sunset",
    "image": [
      {
        "image_url": "https://example.com/input.png"
      }
    ],
    "size": "2560x1440"
  }'
```

Response:

```json
{
  "created": 1780000000,
  "data": [
    {
      "url": "https://<public-image-domain>/images/2026/05/29/uuid.png"
    }
  ]
}
```

## R2 settings

- Bucket: your R2 image bucket
- Custom domain: your public image domain
- Lifecycle rule: delete objects under `images/` after 1 day
- Uploaded object headers:
  - `Content-Type: image/png`
  - `Cache-Control: public, max-age=86400`

## Admin dashboard

The service includes a Chinese internal dashboard at `/image-wrapper/admin`.
It is served by the same Fastify process after `npm run build`.

Required settings:

```env
ADMIN_PASSWORD=<admin-console-password>
ADMIN_SESSION_SECRET=<long-random-session-secret>
ADMIN_DB_PATH=./data/admin.sqlite
ADMIN_RETENTION_DAYS=7
ADMIN_RECENT_LIMIT=1000
ADMIN_BASE_PATH=/image-wrapper/admin
```

Use a stable `ADMIN_SESSION_SECRET` in production; otherwise sessions are reset
after every restart. The login uses an HttpOnly cookie scoped to
`ADMIN_BASE_PATH`.

The dashboard stores recent request metrics in SQLite for troubleshooting:
operation type, status, timings, model, image size, error code, and returned
image URLs. It does not store prompts, uploaded source images, masks,
Authorization headers, R2 secrets, or new-api keys.

Dashboard APIs:

```text
GET  /image-wrapper/admin/login
POST /image-wrapper/admin/login
POST /image-wrapper/admin/logout
GET  /image-wrapper/admin/api/summary
GET  /image-wrapper/admin/api/requests
GET  /image-wrapper/admin/api/errors
```

## nginx

See `nginx/image-wrapper.conf`. Required settings:

```nginx
proxy_read_timeout 1800s;
proxy_send_timeout 1800s;
proxy_buffering off;
client_max_body_size 100m;
```

## PM2

Build first, then start with PM2:

```bash
npm install
npm run build
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
```

Useful commands:

```bash
pm2 status image-handle
pm2 logs image-handle
pm2 restart image-handle
pm2 stop image-handle
```

After code changes:

```bash
git pull
npm install
npm run build
pm2 restart image-handle
```

To start PM2 automatically after reboot:

```bash
pm2 startup
pm2 save
```
