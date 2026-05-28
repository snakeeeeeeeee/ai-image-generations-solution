# image-handle

TypeScript OpenAI-compatible image generation wrapper for new-api.

The service accepts `POST /v1/images/generations`, forwards the caller's
`Authorization` header to new-api, uploads returned `b64_json` PNG images to
Cloudflare R2, and returns public image URLs instead of base64 JSON.

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
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=<bucket-name>
R2_PUBLIC_URL=https://<public-image-domain>
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
