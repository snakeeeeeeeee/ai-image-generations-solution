# new-api 本地联调 image-handle 图片任务对接文档

本文档给 new-api 本地开发联调用。完整协议说明见 `NEW_API_IMAGE_HANDLE_INTEGRATION.md`。

本次对接图片任务链路，包括异步接口 `/v1/image/tasks` 和同步等待包装接口 `/v1/image/tasks/sync`。旧同步兼容接口 `/v1/images/generations`、`/v1/images/edits` 仍保持原逻辑，不需要 new-api 为旧接口做额外改造。

## 1. 职责边界

new-api 负责：

- 用户鉴权、预扣费、任务记录。
- 选择并锁定真实上游渠道。
- 保存真实上游 `base_url / api_key / model / channel_id`。
- 提供 credential lease resolve 接口。
- 接收 image-handle callback，并按 new-api 自己的计价规则结算或退款。

image-handle 负责：

- 接收 new-api 提交的异步任务。
- PostgreSQL 记录任务状态，Redis 做队列、限速和协调。
- worker 调 new-api 的 resolve 接口领取短期凭证。
- worker 直连真实上游生成图片、上传 R2。
- 终态 callback new-api。

核心约束：

- 任务 payload 里不要传真实上游 `api_key`。
- 编辑图任务 payload 只传图片 URL；如果用户输入是 multipart 或 base64，new-api 先调用 image-handle 上传接口换成临时 R2 URL。
- image-handle 不做渠道选择、不做计费、不判断余额。
- 默认图片结果返回 R2 URL；如果 new-api 需要给调用方同步返回 base64，只能调用 `/v1/image/tasks/sync` 并传 `result_data_format=base64`。
- 上游错误不做业务隐藏：标准 `error` 会返回上游 HTTP 状态码、上游 error code/type/message/param；`raw_response` 会返回安全版上游原始 JSON。
- new-api 对外仍只暴露自己的 `client_task_id`，不要把 `provider_task_id` 暴露给最终用户。

## 2. 本地网络建议

### 方案 A：new-api 跑在宿主机

new-api 调 image-handle：

```text
http://127.0.0.1:8787
```

但 image-worker 是 Docker 容器，`executor.resolve_url` 不能写 `127.0.0.1:3000`，否则会指向 worker 容器自己。Mac/Windows Docker Desktop 本地调试建议写：

```text
http://host.docker.internal:3000/api/internal/image/credential-leases/{lease_id}/resolve
```

同时 image-handle 的 `deploy/.env` 需要允许这个 host：

```env
CREDENTIAL_LEASE_ALLOWED_HOSTS=host.docker.internal:3000
```

### 方案 B：new-api 跑在 Docker 容器

推荐把 new-api 和 image-handle 加到同一个外部 Docker 网络，例如 `ai-gateway`。

image-handle `deploy/.env`：

```env
IMAGE_HANDLE_GATEWAY_NETWORK=ai-gateway
CREDENTIAL_LEASE_ALLOWED_HOSTS=newapi-master:3000
```

new-api 容器也加入 `ai-gateway` 后，任务里的 resolve/callback 地址可以用容器名：

```text
http://newapi-master:3000/api/internal/image/credential-leases/{lease_id}/resolve
http://newapi-master:3000/api/task/callback/external-image/batch
```

如果 new-api 也需要从容器内调 image-handle，可使用：

```text
http://image-api:8787
```

## 3. image-handle 本地启动

在 image-handle 仓库：

```bash
cd deploy
cp .env.dev.example .env
```

确认 `deploy/.env` 至少包含：

```env
PROVIDER_API_KEYS=test-api-key

CREDENTIAL_LEASE_SECRETS_JSON={"image_handle_1":"local-credential-lease-secret"}
CREDENTIAL_LEASE_ALLOWED_HOSTS=host.docker.internal:3000

CALLBACK_DEFAULT_SECRET=local-callback-secret
CALLBACK_SECRETS_JSON={"channel_123":"local-callback-secret"}
RAW_RESPONSE_MAX_BYTES=262144
```

启动：

```bash
./image-handle.sh --env dev start all
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

如果 new-api 在 Docker 共享网络里调试，把 `CREDENTIAL_LEASE_ALLOWED_HOSTS` 改成实际容器 host，例如：

```env
CREDENTIAL_LEASE_ALLOWED_HOSTS=newapi-master:3000
```

## 4. new-api 需要准备的配置

建议 new-api 本地先准备这些配置项，命名可按 new-api 项目习惯调整：

```env
IMAGE_HANDLE_BASE_URL=http://127.0.0.1:8787
IMAGE_HANDLE_API_KEY=test-api-key

IMAGE_HANDLE_EXECUTOR_SECRET_ID=image_handle_1
IMAGE_HANDLE_CREDENTIAL_LEASE_SECRET=local-credential-lease-secret

IMAGE_HANDLE_CALLBACK_SECRET_ID=channel_123
IMAGE_HANDLE_CALLBACK_SECRET=local-callback-secret
```

说明：

- `IMAGE_HANDLE_API_KEY` 对应 image-handle 的 `PROVIDER_API_KEYS`，用于 new-api 调 `POST /v1/image/tasks` 或 `POST /v1/image/tasks/sync`。
- `IMAGE_HANDLE_CREDENTIAL_LEASE_SECRET` 对应 image-handle 的 `CREDENTIAL_LEASE_SECRETS_JSON.image_handle_1`，用于 new-api 验证 image-worker 调 resolve 接口的签名。
- `IMAGE_HANDLE_CALLBACK_SECRET` 对应 image-handle 的 `CALLBACK_SECRETS_JSON.channel_123` 或 `CALLBACK_DEFAULT_SECRET`，用于 new-api 验证 callback 签名。
- credential lease secret 和 callback secret 建议分开，不要复用。

## 5. new-api 提交任务到 image-handle

异步接口：

```http
POST /v1/image/tasks
Authorization: Bearer <IMAGE_HANDLE_API_KEY>
Content-Type: application/json
```

同步等待包装接口：

```http
POST /v1/image/tasks/sync
Authorization: Bearer <IMAGE_HANDLE_API_KEY>
Content-Type: application/json
```

两个接口请求体一致。同步等待接口仍然由 worker 执行任务，API 请求只等待 PostgreSQL 里的终态。任务在 `SYNC_TASK_TIMEOUT_MS` 内完成时返回 `200`，超时则返回 `202` 和当前 `processing/queued` 状态，任务继续后台执行，new-api 后续用 callback 或批量查询兜底。

`result_data_format` 规则：

| 值 | 支持接口 | 说明 |
| --- | --- | --- |
| `url` | `/v1/image/tasks`、`/v1/image/tasks/sync` | 默认值。返回 R2 URL，callback 和查询也都是 URL。 |
| `base64` | 仅 `/v1/image/tasks/sync` | 只在当前同步等待 HTTP 响应里返回 `result.images[].b64_json`。 |

注意：

- 普通异步接口 `/v1/image/tasks` 传 `base64` 会返回 `400 unsupported_result_data_format`。
- 查询接口和 callback 永远返回 URL，不返回 base64。
- base64 不写入 PostgreSQL，不进入 callback，不在管理台展示，只短期写 Redis 给当前同步等待请求读取。
- 单次 base64 响应上限固定 100MB，超过会失败为 `base64_result_too_large`。
- 同一个 `client_task_id` 重复提交时，以第一次创建任务时的 `result_data_format` 为准，不要复用同一个任务 ID 切换 URL/base64。

编辑图输入规则：

- `/v1/image/tasks` 和 `/v1/image/tasks/sync` 的 `input.images`、`input.mask` 只接收 `http/https` URL。
- 用户上传 multipart 或 base64 图片时，new-api 先调用 `/v1/image/uploads` 或 `/v1/image/uploads/base64`。
- 上传接口返回临时 R2 URL 后，new-api 再提交 edit 任务。
- 上传接口只负责把输入图转成 URL，不创建任务、不触发上游调用。

multipart 上传示例：

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/image/uploads" \
  -H "Authorization: Bearer test-api-key" \
  -F "image=@./input.png" \
  -F "mask=@./mask.png"
```

base64 上传示例：

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/image/uploads/base64" \
  -H "Authorization: Bearer test-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "images": [
      {
        "b64_json": "iVBORw0KGgo...",
        "filename": "input.png"
      }
    ],
    "mask": {
      "b64_json": "iVBORw0KGgo...",
      "filename": "mask.png"
    }
  }'
```

上传响应里直接取 `images` 和 `mask` 提交 edit 任务：

```json
{
  "uploads": [
    {
      "field": "image",
      "url": "https://img.example.com/images/tmp/uploads/2026/06/27/upload_xxx.png",
      "mime_type": "image/png",
      "temporary": true
    }
  ],
  "images": [
    "https://img.example.com/images/tmp/uploads/2026/06/27/upload_xxx.png"
  ],
  "mask": "https://img.example.com/images/tmp/uploads/2026/06/27/upload_yyy.png",
  "by_field": {
    "image": ["https://img.example.com/images/tmp/uploads/2026/06/27/upload_xxx.png"],
    "mask": ["https://img.example.com/images/tmp/uploads/2026/06/27/upload_yyy.png"]
  }
}
```

文生图示例：

```json
{
  "request_id": "req_xxx",
  "client_task_id": "task_xxx",
  "model": "gpt-image-2",
  "operation": "generation",
  "input": {
    "text": "吃铜锣烧的机器猫"
  },
  "parameters": {
    "size": "2560x1440",
    "quality": "auto",
    "n": 1,
    "output_format": "png"
  },
  "executor": {
    "type": "provider_direct_lease",
    "lease_id": "lease_xxx",
    "resolve_url": "http://host.docker.internal:3000/api/internal/image/credential-leases/lease_xxx/resolve",
    "secret_id": "image_handle_1"
  },
  "callback": {
    "url": "http://host.docker.internal:3000/api/task/callback/external-image/task_xxx",
    "batch_url": "http://host.docker.internal:3000/api/task/callback/external-image/batch",
    "secret_id": "channel_123"
  },
  "metadata": {
    "channel_id": "channel_123"
  }
}
```

同步等待并返回 base64 时，在同一个请求体里额外加：

```json
{
  "result_data_format": "base64"
}
```

编辑图示例：

```json
{
  "request_id": "req_edit_xxx",
  "client_task_id": "task_edit_xxx",
  "model": "gpt-image-2",
  "operation": "edit",
  "input": {
    "text": "改成赛博朋克风格",
    "images": ["https://img.example.com/input.png"],
    "mask": "https://img.example.com/mask.png"
  },
  "parameters": {
    "size": "1024x1024",
    "n": 1,
    "output_format": "png"
  },
  "executor": {
    "type": "provider_direct_lease",
    "lease_id": "lease_edit_xxx",
    "resolve_url": "http://host.docker.internal:3000/api/internal/image/credential-leases/lease_edit_xxx/resolve",
    "secret_id": "image_handle_1"
  },
  "callback": {
    "batch_url": "http://host.docker.internal:3000/api/task/callback/external-image/batch",
    "secret_id": "channel_123"
  },
  "metadata": {
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

同步等待接口额外返回：

```json
{
  "result_data_format": "url",
  "result": {
    "images": [
      {
        "url": "https://img.example.com/images/xxx.png",
        "mime_type": "image/png"
      }
    ]
  },
  "sync_wait": {
    "completed": true,
    "timeout_ms": 300000
  }
}
```

如果请求里传了 `"result_data_format": "base64"`，同步等待成功响应会返回：

```json
{
  "status": "succeeded",
  "result_data_format": "base64",
  "result": {
    "images": [
      {
        "b64_json": "iVBORw0KGgo...",
        "mime_type": "image/png"
      }
    ]
  },
  "sync_wait": {
    "completed": true,
    "timeout_ms": 300000
  }
}
```

超时时：

```json
{
  "status": "processing",
  "result_data_format": "url",
  "sync_wait": {
    "completed": false,
    "timeout_ms": 300000
  }
}
```

幂等规则：

```text
image_handle_api_key + client_task_id
```

同一个 key 和同一个 `client_task_id` 重复提交，会返回同一个 `provider_task_id`，不会重复入队。

## 6. new-api 实现 credential lease resolve

image-worker 会调用任务里的 `executor.resolve_url`。

请求：

```http
POST /api/internal/image/credential-leases/{lease_id}/resolve
Content-Type: application/json
X-ImageHandle-Timestamp: <unix_seconds>
X-ImageHandle-Signature: <hex_hmac_sha256>
X-ImageHandle-Event-Id: <event_id>
X-ImageHandle-Secret-Id: image_handle_1
```

body：

```json
{
  "provider_task_id": "imgtask_xxx",
  "client_task_id": "task_xxx",
  "attempt": 1,
  "operation": "generation",
  "model": "gpt-image-2"
}
```

签名算法：

```text
HMAC-SHA256(timestamp + "." + raw_body, credential_lease_secret)
```

new-api 需要使用 `X-ImageHandle-Secret-Id` 找到对应密钥，并用原始 body 字符串验签。建议同时校验 timestamp 时间窗口，例如 5 分钟。

Node.js 验签示例：

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyImageHandleSignature({ timestamp, rawBody, signature, secret }) {
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

成功响应：

```json
{
  "provider": "openai_compatible",
  "request_format": "openai_images",
  "base_url": "https://api.xxx.com/v1",
  "api_key": "sk-xxx",
  "model": "gpt-image-2",
  "channel_id": "channel_123",
  "expires_at": "2026-06-24T12:30:00Z"
}
```

`base_url` 拼接规则固定：

```text
{base_url}/images/generations
{base_url}/images/edits
```

所以如果上游是 OpenAI 兼容接口，返回 `https://api.xxx.com/v1` 即可。不要返回已经带 `/images/generations` 的完整 URL，也不要让 image-handle 再额外拼 `/v1`。

本地不想调真实上游时，可以让 resolve 返回 image-handle dev compose 里的 mock upstream：

```json
{
  "provider": "openai_compatible",
  "request_format": "openai_images",
  "base_url": "http://mock-new-api:3999",
  "api_key": "mock-upstream-key",
  "model": "gpt-image-2",
  "channel_id": "channel_123",
  "expires_at": "2026-06-24T12:30:00Z"
}
```

失败响应：

```json
{
  "error": {
    "code": "lease_expired",
    "message": "credential lease expired",
    "retryable": false
  }
}
```

`retryable` 规则建议：

- 上游临时不可用、new-api 临时错误：`retryable: true`。
- 签名失败、lease 过期、任务取消、模型不支持、渠道不存在：`retryable: false`。

## 7. image-worker 直连上游的行为

文生图：

```http
POST {base_url}/images/generations
Authorization: Bearer <api_key>
Content-Type: application/json
```

编辑图：

```http
POST {base_url}/images/edits
Authorization: Bearer <api_key>
Content-Type: multipart/form-data
```

image-worker 会把任务里的：

- `input.text` 映射为 OpenAI Images 的 `prompt`。
- `parameters` 透传到上游请求体。
- resolve 返回的 `model` 作为真实上游模型。
- 编辑图的 `input.images` 和 `input.mask` URL 下载后组装 multipart。

`api_key` 只在 worker 内存中短暂使用，不入库、不写 Redis、不进 callback、不在管理台展示。

## 8. new-api 接收 callback

image-handle 优先发送批量 callback。如果任务 payload 有 `callback.batch_url`，请求体格式是：

```json
{
  "events": [
    {
      "event_id": "evt_xxx",
      "client_task_id": "task_xxx",
      "provider_task_id": "imgtask_xxx",
      "status": "succeeded",
      "progress": "100%",
      "result_data_format": "url",
      "result": {
        "images": [
          {
            "url": "https://img.xxx.com/images/xxx.png",
            "mime_type": "image/png"
          }
        ]
      },
      "usage": {
        "total_tokens": 123
      },
      "error": null,
      "raw_response": {
        "id": "resp_xxx",
        "created": 123,
        "model": "gpt-image-2",
        "usage": {},
        "data": [
          {
            "url": "https://img.xxx.com/images/xxx.png",
            "b64_json": "[omitted]",
            "revised_prompt": "..."
          }
        ]
      },
      "raw_response_truncated": true,
      "raw_response_omitted_fields": ["data[].b64_json"]
    }
  ]
}
```

失败事件：

```json
{
  "events": [
    {
      "event_id": "evt_xxx",
      "client_task_id": "task_xxx",
      "provider_task_id": "imgtask_xxx",
      "status": "failed",
      "progress": "100%",
      "result_data_format": "url",
      "result": null,
      "usage": null,
      "error": {
        "code": "new_api_error",
        "message": "size is not supported by this channel",
        "retryable": false,
        "upstream_status": 400,
        "provider_error_code": "unsupported_size",
        "provider_error_type": "invalid_request_error",
        "provider_error_message": "size is not supported by this channel",
        "provider_error_param": "size",
        "upstream_error": {
          "error": {
            "message": "size is not supported by this channel",
            "type": "invalid_request_error",
            "code": "unsupported_size",
            "param": "size"
          }
        }
      },
      "raw_response": {
        "error": {
          "message": "size is not supported by this channel",
          "type": "invalid_request_error",
          "code": "unsupported_size",
          "param": "size"
        }
      },
      "raw_response_truncated": false,
      "raw_response_omitted_fields": []
    }
  ]
}
```

callback headers：

```http
X-Callback-Timestamp: <unix_seconds>
X-Callback-Signature: <hex_hmac_sha256>
X-Callback-Event-Id: <event_id>
X-Callback-Secret-Id: <callback_secret_id>
```

签名算法：

```text
HMAC-SHA256(timestamp + "." + raw_body, callback_secret)
```

new-api 返回 2xx 即表示投递成功。如果想逐条确认，返回：

```json
{
  "results": [
    {
      "event_id": "evt_xxx",
      "client_task_id": "task_xxx",
      "status": "accepted"
    }
  ]
}
```

`status` 可用：

```text
accepted
ignored_terminal
```

new-api 必须保证 callback 幂等：同一个 `client_task_id` 或同一个 `event_id` 重复到达时，不重复结算、不重复退款。

## 9. 查询兜底

单个查询：

```http
GET /v1/image/tasks/{provider_task_id}
Authorization: Bearer <IMAGE_HANDLE_API_KEY>
```

批量查询：

```http
POST /v1/image/tasks/query
Authorization: Bearer <IMAGE_HANDLE_API_KEY>
Content-Type: application/json
```

```json
{
  "task_ids": ["imgtask_xxx", "imgtask_yyy"]
}
```

状态只会是：

```text
submitted
queued
processing
succeeded
failed
```

new-api 建议 callback 为主，批量查询为兜底。callback 丢失、验签失败或超时后，用内部保存的 `provider_task_id` 批量轮询。

## 10. 最小 curl 联调

异步文生图：

```bash
TASK_ID="task_test_$(date +%s)"

curl -sS -X POST "http://127.0.0.1:8787/v1/image/tasks" \
  -H "Authorization: Bearer test-api-key" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"req_${TASK_ID}\",
    \"client_task_id\": \"${TASK_ID}\",
    \"model\": \"gpt-image-2\",
    \"operation\": \"generation\",
    \"input\": {
      \"text\": \"吃铜锣烧的机器猫\"
    },
    \"parameters\": {
      \"size\": \"1024x1024\",
      \"quality\": \"auto\",
      \"n\": 1,
      \"output_format\": \"png\"
    },
    \"executor\": {
      \"type\": \"provider_direct_lease\",
      \"lease_id\": \"lease_${TASK_ID}\",
      \"resolve_url\": \"http://host.docker.internal:3000/api/internal/image/credential-leases/lease_${TASK_ID}/resolve\",
      \"secret_id\": \"image_handle_1\"
    },
    \"callback\": {
      \"batch_url\": \"http://host.docker.internal:3000/api/task/callback/external-image/batch\",
      \"secret_id\": \"channel_123\"
    },
    \"metadata\": {
      \"channel_id\": \"channel_123\"
    }
  }"
```

如果 new-api 在 Docker 网络里，把上面的 `host.docker.internal:3000` 换成 `newapi-master:3000`。

同步等待文生图只需要把路径换成 `/v1/image/tasks/sync`：

```bash
TASK_ID="task_sync_$(date +%s)"

curl -sS -X POST "http://127.0.0.1:8787/v1/image/tasks/sync" \
  -H "Authorization: Bearer test-api-key" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"req_${TASK_ID}\",
    \"client_task_id\": \"${TASK_ID}\",
    \"model\": \"gpt-image-2\",
    \"operation\": \"generation\",
    \"input\": {
      \"text\": \"吃铜锣烧的机器猫\"
    },
    \"parameters\": {
      \"size\": \"1024x1024\",
      \"quality\": \"auto\",
      \"n\": 1,
      \"output_format\": \"png\"
    },
    \"executor\": {
      \"type\": \"provider_direct_lease\",
      \"lease_id\": \"lease_${TASK_ID}\",
      \"resolve_url\": \"http://host.docker.internal:3000/api/internal/image/credential-leases/lease_${TASK_ID}/resolve\",
      \"secret_id\": \"image_handle_1\"
    },
    \"callback\": {
      \"batch_url\": \"http://host.docker.internal:3000/api/task/callback/external-image/batch\",
      \"secret_id\": \"channel_123\"
    },
    \"metadata\": {
      \"channel_id\": \"channel_123\"
    }
  }"
```

同步等待并直接返回 base64：

```bash
TASK_ID="task_sync_b64_$(date +%s)"

curl -sS -X POST "http://127.0.0.1:8787/v1/image/tasks/sync" \
  -H "Authorization: Bearer test-api-key" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"req_${TASK_ID}\",
    \"client_task_id\": \"${TASK_ID}\",
    \"model\": \"gpt-image-2\",
    \"operation\": \"generation\",
    \"result_data_format\": \"base64\",
    \"input\": {
      \"text\": \"吃铜锣烧的机器猫\"
    },
    \"parameters\": {
      \"size\": \"1024x1024\",
      \"quality\": \"auto\",
      \"n\": 1,
      \"output_format\": \"png\"
    },
    \"executor\": {
      \"type\": \"provider_direct_lease\",
      \"lease_id\": \"lease_${TASK_ID}\",
      \"resolve_url\": \"http://host.docker.internal:3000/api/internal/image/credential-leases/lease_${TASK_ID}/resolve\",
      \"secret_id\": \"image_handle_1\"
    },
    \"metadata\": {
      \"channel_id\": \"channel_123\"
    }
  }"
```

查询：

```bash
curl -sS "http://127.0.0.1:8787/v1/image/tasks/imgtask_xxx" \
  -H "Authorization: Bearer test-api-key"
```

批量查询：

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/image/tasks/query" \
  -H "Authorization: Bearer test-api-key" \
  -H "Content-Type: application/json" \
  -d '{"task_ids":["imgtask_xxx"]}'
```

## 11. 联调验收点

new-api 本地联调至少确认：

- 同一个 `client_task_id` 重复提交，image-handle 返回同一个 `provider_task_id`。
- 同步等待接口完成时返回 `200 + succeeded/failed`；超时时返回 `202 + processing/queued`，任务继续后台执行。
- `/v1/image/tasks` 传 `result_data_format=base64` 返回 `400 unsupported_result_data_format`。
- `/v1/image/tasks/sync` 传 `result_data_format=base64` 时，成功响应返回 `result.images[].b64_json`。
- new-api resolve 接口能收到并通过 `X-ImageHandle-*` HMAC 验签。
- resolve 返回的 `api_key` 不出现在 image-handle 查询结果、callback、日志和管理台里。
- worker 能按 resolve 返回的 `base_url / api_key / model` 直连上游。
- callback 能通过 `X-Callback-*` HMAC 验签。
- 成功 callback 只包含 R2 URL，不包含真实 `b64_json`；即使同步等待返回过 base64，callback 也仍是 URL。
- 失败 callback 带结构化 `error` 和安全版 `raw_response`。
- new-api 对 callback 做幂等，重复终态不会重复结算或退款。
- callback 丢失时，new-api 可以用批量查询兜底。

## 12. 常见坑

- `executor.resolve_url` 写 `127.0.0.1`：worker 容器会访问自己，不会访问宿主机 new-api。
- `CREDENTIAL_LEASE_ALLOWED_HOSTS` 没包含 resolve_url 的 host：worker 会拒绝任务。
- `base_url` 返回了完整 `/images/generations`：image-worker 会再拼一次路径，导致 URL 错误。
- credential lease secret 和 callback secret 混用：验签会变乱，排查困难。
- new-api 把 `provider_task_id` 暴露给最终用户：后续迁移或重试会被外部契约绑死。
- callback 没做幂等：重试投递可能导致重复结算或重复退款。
- 把 `result_data_format=base64` 发到 `/v1/image/tasks`：普通异步接口不支持 base64，只能发到 `/v1/image/tasks/sync`。
- 用同一个 `client_task_id` 一会儿要 URL、一会儿要 base64：幂等任务以第一次提交为准，应生成新的 `client_task_id`。
