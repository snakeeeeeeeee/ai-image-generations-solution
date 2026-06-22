# 多机异步图片任务方案

## 目标

`image-handle` 为 new-api 提供可横向扩展的异步图片任务执行模式。new-api 负责用户鉴权、预扣费、结算和退款；image-handle 只负责执行图片任务、记录执行状态、上传 R2，并在任务进入终态后通知 new-api。

## 运行拓扑

```text
负载均衡
  -> image-api x N
  -> 共享 PostgreSQL
  -> 共享 Redis/BullMQ
  -> image-worker x M
  -> new-api internal execute
  -> R2
  -> image-notifier x K
  -> 回调通知 new-api
```

API、任务处理进程、回调投递进程都是无状态进程。新机器只要运行同一个镜像，并使用同一套 `.env` 指向共享的 `POSTGRES_URL`、`REDIS_URL`、R2 和 new-api internal execute 配置，就可以加入处理。

PostgreSQL 是任务状态、结果 URL、错误和回调发件箱的事实库。Redis 只用于 BullMQ 队列、全局限速和短期协调。

## 对外接口

提交任务：

```http
POST /v1/image/tasks
Authorization: Bearer <image_handle_api_key>
Content-Type: application/json
```

```json
{
  "request_id": "req_xxx",
  "client_task_id": "task_xxx",
  "model": "gpt-image-2",
  "operation": "generation",
  "input": {
    "text": "prompt text",
    "images": [],
    "mask": null
  },
  "parameters": {
    "size": "2048x2048",
    "quality": "high",
    "n": 1,
    "output_format": "webp",
    "output_compression": 85
  },
  "executor": {
    "type": "new_api_internal",
    "execute_url": "http://newapi-master:3000/api/internal/image/tasks/task_xxx/execute",
    "secret_id": "image_handle_1"
  },
  "callback": {
    "url": "https://new-api.example.com/api/task/callback/external-image/task_xxx",
    "batch_url": "https://new-api.example.com/api/task/callback/external-image/batch",
    "secret_id": "channel_123"
  },
  "metadata": {
    "tenant_id": "user_123",
    "channel_id": "channel_123"
  }
}
```

返回：

```json
{
  "provider_task_id": "imgtask_xxx",
  "client_task_id": "task_xxx",
  "status": "queued"
}
```

查询：

```http
GET /v1/image/tasks/{provider_task_id}
POST /v1/image/tasks/query
```

new-api 对最终用户只暴露自己的 `task_xxx`。`provider_task_id` 只作为 new-api 和 image-handle 之间的内部任务 ID。

## 状态和幂等

对外状态：

```text
submitted
queued
processing
succeeded
failed
```

幂等键是 `image_handle_api_key + client_task_id`。重复提交会返回已有的 `provider_task_id`，不会重复入队，也不会重复生图。

任务处理进程在把任务推进到 `processing` 和终态时都使用 PostgreSQL CAS 更新，避免多台机器同时消费同一个 Redis 队列时重复执行同一任务。

异步任务只支持 `executor.type = "new_api_internal"`。image-handle 不再维护真实上游密钥，也不根据模型自己选择渠道；worker 调用 `executor.execute_url`，由 new-api 使用已锁定的真实渠道完成生图或编辑图。同步 `/v1/images/generations`、`/v1/images/edits` 兼容接口保持原有上游转发逻辑。

## 回调协议

回调是至少一次投递。new-api 必须用 CAS 或幂等记录处理重复终态事件，确保只结算或退款一次。

HMAC 输入：

```text
HMAC-SHA256(timestamp + "." + raw_body, callback_secret)
```

请求头：

```text
X-Callback-Timestamp: 1710000000
X-Callback-Signature: <signature>
X-Callback-Event-Id: evt_xxx
X-Callback-Secret-Id: channel_123
```

批量回调事件总是包含 `client_task_id`，并按相同回调地址和 `secret_id` 分组，因此一个批次可以用同一个 HMAC 密钥验签。

## Docker Compose 部署

开发环境，从完整源码构建：

```bash
cd deploy
cp .env.dev.example .env
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml up -d image-handle-postgres image-handle-redis mock-new-api
docker compose -f docker-compose.dev.yml up -d image-api image-worker image-notifier
```

生产环境，使用预构建镜像和共享 PostgreSQL/Redis：

```bash
cd deploy
cp .env.prod.example .env
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d image-api image-worker image-notifier
```

同一台机器扩容处理进程：

```bash
cd deploy
docker compose -f docker-compose.prod.yml up -d --scale image-worker=5 --scale image-notifier=2
```

生产环境新增机器：

```bash
cd deploy
docker compose -f docker-compose.worker.yml up -d image-worker image-notifier
```

多机生产环境不要在每台机器上各自启动 PostgreSQL 或 Redis。所有业务节点必须指向同一套共享 `POSTGRES_URL` 和 `REDIS_URL`。`docker-compose.dev.yml` 用于源码开发构建；`docker-compose.prod.yml` 和 `docker-compose.worker.yml` 使用预构建镜像，可以只拷贝 `deploy/` 目录部署。

端口通过 `.env` 控制：`PORT` 是 image-api 容器内监听端口，`IMAGE_API_HOST_PORT` 是宿主机映射端口；开发环境的 `POSTGRES_HOST_PORT`、`REDIS_HOST_PORT`、`MOCK_NEW_API_HOST_PORT` 用于避免本机端口冲突。
