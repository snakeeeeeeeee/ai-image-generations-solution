# image-handle

面向 new-api 的 TypeScript 图片处理服务，兼容 OpenAI Images API 风格。

服务支持 `POST /v1/images/generations` 和 `POST /v1/images/edits`。同步兼容模式下，它会把调用方的 `Authorization` 透传给 new-api，把上游返回的 `b64_json` 图片上传到 Cloudflare R2，并向调用方返回公开图片 URL，而不是 base64 JSON。

服务也支持高吞吐异步任务模式。异步模式下，new-api 提交任务，image-handle 通过任务处理进程执行生图、上传 R2、把状态写入 PostgreSQL，并在任务进入终态时通过回调通知 new-api。需要同步体验时，可以调用同步等待包装接口，任务仍由 worker 执行，API 请求只等待终态或超时。

## GPT-Image-2 模型分组

通过 SuperToken 可以使用 GPT-Image-2 生成和编辑图片。根据成本、计费方式和
参数能力不同，当前建议把图片模型分成两个使用入口：

| 模型分组 | 计费方式 | 上游路径 | 参数支持 | 推荐场景 |
| --- | --- | --- | --- | --- |
| `gpt-image-2-count` | 按调用次数计费 | GPT 内置生图工具 | 不支持全部官方 API 参数，例如 `n` 只能为 `1`；目前无法生成超过 2K 分辨率的图片 | 低成本单图生成、常规编辑、对高级参数和高分辨率要求不高的场景 |
| `gpt-image-2` | 按 token 使用量计费 | 官方 Images API 生图 | 支持官方 API 参数能力 | 对分辨率、质量、多图输出或官方参数兼容性有要求的场景 |

选择建议：

- 默认低成本场景优先使用 `gpt-image-2-count`。它按次收费，单张成本更低，
  适合常规生成和编辑。
- 如果需要超过 2K 的输出分辨率、更高质量控制、多图输出，或依赖官方 Images
  API 的完整参数，请使用 `gpt-image-2` 官方生图分组。
- 本服务会继续把生成结果上传到 R2，并向调用方返回公开图片 URL。

## 同步兼容流程

```text
调用方
  -> image-handle
  -> new-api
  -> OpenAI 生图
  -> new-api 返回 b64_json
  -> image-handle 上传图片到 R2
  -> 调用方收到 CDN URL
```

## 环境变量

复制 `.env.example` 为 `.env`，并填入密钥和真实配置：

```env
NEW_API_BASE_URL=http://127.0.0.1:3000
NEW_API_IMAGES_PATH=/v1/images/generations
NEW_API_IMAGES_EDITS_PATH=/v1/images/edits
MAX_CONCURRENT_GENERATIONS=1000
MAX_CONCURRENT_IMAGE_PROCESSING=50
MAX_PROCESS_RSS_MB=28672
CORS_ALLOWED_ORIGINS=*
CORS_MAX_AGE_SECONDS=86400
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=<bucket-name>
R2_PUBLIC_URL=https://<public-image-domain>
R2_UPLOAD_MAX_RETRIES=3
R2_UPLOAD_RETRY_BASE_DELAY_MS=300
R2_UPLOAD_RETRY_MAX_DELAY_MS=3000
ADMIN_PASSWORD=<admin-console-password>
ADMIN_SESSION_SECRET=<long-random-session-secret>
ADMIN_DB_PATH=./data/admin.sqlite
ADMIN_RETENTION_DAYS=7
ADMIN_BASE_PATH=/image-wrapper/admin
IMAGE_HANDLE_ROLE=api
POSTGRES_URL=postgres://image_handle:image_handle@image-handle-postgres:5432/image_handle
REDIS_URL=redis://image-handle-redis:6379
PROVIDER_API_KEYS=provider-test-key
UPSTREAM_API_KEY=
WORKER_CONCURRENCY=20
IMAGE_PROCESSING_CONCURRENCY=10
GLOBAL_RATE_LIMIT_IPM=250
CALLBACK_DEFAULT_SECRET=local-callback-secret
CALLBACK_SECRETS_JSON={}
SYNC_TASK_TIMEOUT_MS=300000
SYNC_TASK_POLL_INTERVAL_MS=500
SYNC_WAIT_CONCURRENCY=200
WORKER_HEARTBEAT_INTERVAL_MS=5000
WORKER_HEARTBEAT_TTL_SECONDS=15
```

## 运行

```bash
npm install
npm run build
npm start
```

开发模式：

```bash
npm run dev
```

## 异步图片任务

new-api 提交异步图片任务：

```bash
curl http://127.0.0.1:8787/v1/image/tasks \
  -H 'Authorization: Bearer provider-test-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "request_id": "req_local_1",
    "client_task_id": "task_local_1",
    "model": "gpt-image-2",
    "operation": "generation",
    "input": {
      "text": "a mechanical cat watching sunset"
    },
    "parameters": {
      "size": "1024x1024",
      "n": 1,
      "output_format": "png"
    },
    "executor": {
      "type": "provider_direct_lease",
      "lease_id": "lease_task_local_1",
      "resolve_url": "http://mock-new-api:3999/api/internal/image/credential-leases/lease_task_local_1/resolve",
      "secret_id": "image_handle_1"
    },
    "callback": {
      "url": "http://mock-new-api:3999/api/task/callback/external-image/task_local_1",
      "batch_url": "http://mock-new-api:3999/api/task/callback/external-image/batch",
      "secret_id": "channel_123"
    },
    "metadata": {
      "channel_id": "channel_123"
    }
  }'
```

异步编辑图使用同一个接口，`operation` 改为 `edit`，并把待编辑图片放到 `input.images`：

```bash
curl http://127.0.0.1:8787/v1/image/tasks \
  -H 'Authorization: Bearer provider-test-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "request_id": "req_edit_1",
    "client_task_id": "task_edit_1",
    "model": "gpt-image-2",
    "operation": "edit",
    "input": {
      "text": "把图片里的角色改成正在吃铜锣烧的机器猫",
      "images": ["https://img.example.com/source/input.png"],
      "mask": null
    },
    "parameters": {
      "size": "1024x1024",
      "n": 1,
      "output_format": "png"
    },
    "executor": {
      "type": "provider_direct_lease",
      "lease_id": "lease_task_edit_1",
      "resolve_url": "http://mock-new-api:3999/api/internal/image/credential-leases/lease_task_edit_1/resolve",
      "secret_id": "image_handle_1"
    }
  }'
```

同步等待包装接口复用同一个请求体，只把路径换成 `/v1/image/tasks/sync`。它会先创建任务并入队，然后等待 worker 写入终态：

```bash
curl http://127.0.0.1:8787/v1/image/tasks/sync \
  -H 'Authorization: Bearer provider-test-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "request_id": "req_sync_1",
    "client_task_id": "task_sync_1",
    "model": "gpt-image-2",
    "operation": "generation",
    "input": {
      "text": "a mechanical cat watching sunset"
    },
    "parameters": {
      "size": "1024x1024",
      "n": 1,
      "output_format": "png"
    },
    "executor": {
      "type": "provider_direct_lease",
      "lease_id": "lease_task_sync_1",
      "resolve_url": "http://mock-new-api:3999/api/internal/image/credential-leases/lease_task_sync_1/resolve",
      "secret_id": "image_handle_1"
    }
  }'
```

同步等待接口在任务完成时返回 `200` 和 `succeeded/failed`；超过 `SYNC_TASK_TIMEOUT_MS` 时返回 `202` 和当前 `processing/queued` 状态，任务继续由 worker 在后台执行，new-api 继续用 callback 或查询兜底。

同步等待接口可以额外传 `"result_data_format": "base64"`，只在当前 HTTP 响应里返回 `result.images[].b64_json`。普通异步接口、任务查询和 callback 仍然只返回 R2 URL；base64 不写 PostgreSQL、不进 callback，单次响应上限固定为 100MB。

查询单个任务：

```bash
curl http://127.0.0.1:8787/v1/image/tasks/imgtask_xxx \
  -H 'Authorization: Bearer provider-test-key'
```

批量查询：

```bash
curl http://127.0.0.1:8787/v1/image/tasks/query \
  -H 'Authorization: Bearer provider-test-key' \
  -H 'Content-Type: application/json' \
  -d '{"task_ids":["imgtask_xxx"]}'
```

异步任务的事实库是 PostgreSQL。Redis 用于 BullMQ 队列、分布式限速、重试和短期协调。异步 worker 不维护长期上游密钥，而是通过 `executor.resolve_url` 向 new-api 领取短期 credential lease，再直连 OpenAI-compatible 上游执行并上传 R2。

## Docker Compose 部署

开发环境，从完整源码构建：

```bash
cd deploy
cp .env.dev.example .env
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml up -d image-handle-postgres image-handle-redis mock-new-api
docker compose -f docker-compose.dev.yml up -d image-api image-worker image-notifier
```

生产主节点，使用预构建镜像并部署 image-handle 专用 PostgreSQL/Redis：

```bash
cd deploy
cp .env.prod.example .env
# 填好真实配置后：
./image-handle.sh --env prod start full
```

如果 new-api 已经在外部 Docker 网络中，例如 `ai-gateway`，image-handle 可通过同一网络直接访问 new-api 容器：

```env
IMAGE_HANDLE_GATEWAY_NETWORK=ai-gateway
NEW_API_BASE_URL=http://newapi-master:3000
```

如果 PostgreSQL/Redis 已经部署在独立机器或云服务上，只启动业务服务：

```bash
cd deploy
./image-handle.sh --env prod start all
```

新增一台处理机器加入生产共享基础设施：

```bash
cd deploy
./image-handle.sh --env worker start all
```

同一台机器扩容任务处理和回调投递进程：

```bash
cd deploy
./image-handle.sh --env prod start async --scale image-worker=5 --scale image-notifier=2
```

多机生产环境下，所有业务节点必须使用同一套 `POSTGRES_URL`、`REDIS_URL`、R2 配置和上游配置。PostgreSQL/Redis 可以由生产主节点的 `./image-handle.sh --env prod start infra` 部署，也可以使用独立数据库服务；不要在每台处理机器上各自启动一套 PostgreSQL 或 Redis。部署文件统一放在 `deploy/` 目录。`docker-compose.dev.yml` 用于本地/源码构建；`docker-compose.prod.yml` 和 `docker-compose.worker.yml` 用于生产镜像部署。

端口也都通过 `deploy/.env` 配置。`PORT` 是 image-api 容器内监听端口，`IMAGE_API_HOST_PORT` 是映射到宿主机的端口。开发环境还可以配置 `POSTGRES_HOST_PORT`、`REDIS_HOST_PORT`、`MOCK_NEW_API_HOST_PORT`，用于避免和本机其他服务冲突。

## 内存和并发

图片响应在处理过程中可能同时占用上游 JSON 文本、base64 字符串、解码后的图片 Buffer 和 SDK 上传 Buffer。即使机器内存较大，也建议保留服务级并发限制。

大机器的建议起始配置：

```env
MAX_CONCURRENT_GENERATIONS=1000
MAX_CONCURRENT_IMAGE_PROCESSING=50
MAX_PROCESS_RSS_MB=28672
PM2_MAX_MEMORY_RESTART=30G
NODE_MAX_OLD_SPACE_SIZE_MB=24576
```

`MAX_CONCURRENT_GENERATIONS` 限制总在途生图请求数，包括等待 new-api/OpenAI 返回的长耗时阶段。`MAX_CONCURRENT_IMAGE_PROCESSING` 限制 `b64_json` 返回后的高内存阶段，也就是解码和上传 R2。

如果 4K PNG 比预期更大，优先降低 `MAX_CONCURRENT_IMAGE_PROCESSING`。如果压测时服务器长期空闲，再逐步上调。

`MAX_PROCESS_RSS_MB` 是服务级内存保护阈值。当 RSS 达到该阈值时，服务会在接收更多图片任务前返回 `503 server_memory_limit_exceeded`。PM2 的 `max_memory_restart` 只作为最后兜底的重启保护。

## 本地冒烟测试

这个流程用于验证 wrapper -> mock new-api -> R2 -> public URL，不会消耗真实生图请求。

终端 1：

```bash
npm run mock:new-api
```

终端 2：

```bash
cp .env.example .env
# 在 .env 中填入 R2_ACCESS_KEY_ID 和 R2_SECRET_ACCESS_KEY。
# 本地冒烟测试保持 NEW_API_BASE_URL=http://127.0.0.1:3999。
npm run dev
```

终端 3：

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H 'Authorization: Bearer local-test' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2-count",
    "prompt": "local smoke test"
  }'
```

预期响应：

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

在浏览器打开返回的 URL。如果能正常加载，说明 R2 凭证、自定义域名和公开访问都正常。

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

使用 `gpt-image-2-count` 的低成本生图请求：

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H 'Authorization: Bearer NEW_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2-count",
    "prompt": "a mechanical cat watching sunset on a cyberpunk rooftop",
    "size": "1024x1024",
    "quality": "high"
  }'
```

使用 `gpt-image-2` 的官方 API 生图请求：

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H 'Authorization: Bearer NEW_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a mechanical cat watching sunset on a cyberpunk rooftop",
    "size": "2560x1440",
    "quality": "high",
    "n": 2
  }'
```

使用原生 multipart 参数的低成本编辑图请求：

```bash
curl http://127.0.0.1:8787/v1/images/edits \
  -H 'Authorization: Bearer NEW_API_KEY' \
  -F 'model=gpt-image-2-count' \
  -F 'prompt=replace the sky with a clean sunset' \
  -F 'image=@./input.png' \
  -F 'size=1024x1024'
```

使用 JSON 图片 URL 的官方 API 编辑图请求：

```bash
curl http://127.0.0.1:8787/v1/images/edits \
  -H 'Authorization: Bearer NEW_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2",
    "prompt": "replace the sky with a clean sunset",
    "image": [
      {
        "image_url": "https://example.com/input.png"
      }
    ],
    "size": "2560x1440",
    "quality": "high"
  }'
```

响应：

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

## R2 设置

- Bucket：R2 图片 bucket
- 自定义域名：公开图片访问域名
- 生命周期规则：建议 1 天后删除 `images/` 前缀下的对象
- 上传对象头：
  - `Content-Type: image/png`
  - `Cache-Control: public, max-age=86400`
- 上传重试：
  - `R2_UPLOAD_MAX_RETRIES=3`
  - `R2_UPLOAD_RETRY_BASE_DELAY_MS=300`
  - `R2_UPLOAD_RETRY_MAX_DELAY_MS=3000`

## 管理台

服务内置中文管理台，路径为 `/image-wrapper/admin`。执行 `npm run build` 后，由同一个 Fastify 进程提供访问。

必填配置：

```env
ADMIN_PASSWORD=<admin-console-password>
ADMIN_SESSION_SECRET=<long-random-session-secret>
ADMIN_DB_PATH=./data/admin.sqlite
ADMIN_RETENTION_DAYS=7
ADMIN_RECENT_LIMIT=1000
ADMIN_BASE_PATH=/image-wrapper/admin
```

生产环境必须使用固定的 `ADMIN_SESSION_SECRET`，否则每次重启都会导致会话失效。登录态使用 HttpOnly cookie，并限定在 `ADMIN_BASE_PATH` 路径下。

管理台会把最近请求指标写入 SQLite，用于排障：操作类型、状态、耗时、模型、图片尺寸、错误码和返回图片 URL。上游失败时，也会记录截断到 500 字符的上游错误信息。它不会保存 prompt、上传原图、mask、Authorization 请求头、R2 密钥或 new-api key。

管理台还包含 drain mode，用于维护或重启。开启后，已有图片请求继续执行，新 generation/edit 请求会返回 `503 service_draining` 和 `Retry-After: 120`。只有当管理台显示可以安全重启时再重启服务。

管理台接口：

```text
GET  /image-wrapper/admin/login
POST /image-wrapper/admin/login
POST /image-wrapper/admin/logout
GET  /image-wrapper/admin/api/summary
GET  /image-wrapper/admin/api/drain
POST /image-wrapper/admin/api/drain
GET  /image-wrapper/admin/api/requests
GET  /image-wrapper/admin/api/errors
```

## nginx

参考 `nginx/image-wrapper.conf`。关键配置：

```nginx
proxy_read_timeout 1800s;
proxy_send_timeout 1800s;
proxy_buffering off;
client_max_body_size 100m;
```

## PM2

先构建，再用 PM2 启动：

```bash
npm install
npm run build
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
```

常用命令：

```bash
pm2 status image-handle
pm2 logs image-handle
pm2 restart image-handle
pm2 stop image-handle
```

代码更新后：

```bash
git pull
npm install
npm run build
pm2 restart image-handle
```

配置机器重启后自动拉起 PM2：

```bash
pm2 startup
pm2 save
```
