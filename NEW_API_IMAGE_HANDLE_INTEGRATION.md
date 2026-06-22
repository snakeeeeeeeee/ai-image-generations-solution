# new-api 对接 image-handle 异步图片任务文档

本文档给 new-api 侧对接 `image-handle` 异步图片执行服务使用。

`image-handle` 只负责图片任务执行、R2 上传、状态记录和终态通知，不参与用户鉴权、扣费、结算或退款。new-api 继续负责用户侧鉴权、预扣费、任务记录、成功结算和失败退款。

异步任务只支持 `new_api_internal` 执行模式：image-handle worker 不再维护真实上游密钥，也不根据平台或模型自己选择渠道；它只调用 new-api 提供的 internal execute 地址，由 new-api 使用已锁定的真实渠道完成上游生图或编辑图。同步兼容接口 `/v1/images/generations`、`/v1/images/edits` 保持原逻辑不变。

## 1. 整体流程

```text
用户
  -> new-api
  -> image-handle POST /v1/image/tasks
  -> image-handle 处理进程调用 new-api internal execute
  -> new-api 使用已锁定渠道调上游生图
  -> image-handle 上传 R2
  -> image-handle 写 PostgreSQL 终态
  -> image-handle 回调通知 new-api
  -> new-api 结算或退款
```

建议 new-api 同时支持：

- 回调：用于实时接收终态。
- 批量轮询：用于回调丢失、超时或验签失败后的兜底。

## 2. 鉴权

new-api 调 image-handle 时使用服务鉴权 key：

```http
Authorization: Bearer <image_handle_api_key>
```

这里的 `<image_handle_api_key>` 指 image-handle 服务鉴权 key，不是真实上游密钥。它需要配置在 image-handle 的 `PROVIDER_API_KEYS` 中。多个 key 可用英文逗号分隔，便于轮换。

## 3. 提交任务

```http
POST /v1/image/tasks
Authorization: Bearer <image_handle_api_key>
Content-Type: application/json
```

请求体：

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

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `request_id` | 是 | new-api 本次请求 ID，用于排查链路。 |
| `client_task_id` | 是 | new-api 侧任务 ID，例如 `task_xxx`。这是幂等关键字段。 |
| `model` | 是 | 上游模型，例如 `gpt-image-2`。 |
| `operation` | 是 | `generation` 或 `edit`。 |
| `input.text` | 是 | 统一文本输入，new-api internal execute 根据已保存任务决定如何映射到真实上游。 |
| `input.images` | 否 | 图生图/编辑图输入图片 URL 数组。 |
| `input.mask` | 否 | 编辑图 mask URL。 |
| `parameters` | 否 | 通用模型参数，例如 `size`、`quality`、`n`、`output_format`。 |
| `executor.type` | 是 | 固定为 `new_api_internal`。 |
| `executor.execute_url` | 是 | image-handle worker 调用的 new-api internal execute 地址。 |
| `executor.secret_id` | 是 | internal execute 签名密钥 ID。 |
| `callback.url` | 建议 | 单任务回调地址。没有 `url` 时不会产生回调。 |
| `callback.batch_url` | 建议 | 批量回调地址。存在时优先使用批量回调。 |
| `callback.secret_id` | 建议 | 回调密钥标识，image-handle 会放到 `X-Callback-Secret-Id`。 |
| `metadata.channel_id` | 建议 | 用于按 `new_api_internal + model + channel_id` 做限速维度。 |

返回：

```json
{
  "provider_task_id": "imgtask_xxx",
  "client_task_id": "task_xxx",
  "status": "queued"
}
```

new-api 对外仍然只暴露自己的 `client_task_id`，不要把 `provider_task_id` 暴露给最终用户。new-api 内部需要保存 `provider_task_id`，用于后续查询 image-handle。

## 4. 幂等规则

image-handle 的唯一键是：

```text
image_handle_api_key + client_task_id
```

如果 new-api 用同一个服务鉴权 key 和同一个 `client_task_id` 重复提交，image-handle 会返回第一次创建的同一个 `provider_task_id`，不会重复入队，也不会重复生图。

new-api 建议：

- 用户发起请求后先在 new-api 创建任务并预扣费。
- 调 image-handle 超时或网络失败时，可以用同一个 `client_task_id` 重试提交。
- 收到同一个 `provider_task_id` 视为同一任务，不重复扣费。

## 5. 查询任务

单个查询：

```http
GET /v1/image/tasks/{provider_task_id}
Authorization: Bearer <image_handle_api_key>
```

批量查询：

```http
POST /v1/image/tasks/query
Authorization: Bearer <image_handle_api_key>
Content-Type: application/json
```

```json
{
  "task_ids": ["imgtask_xxx", "imgtask_yyy"]
}
```

批量查询一次最多 100 个 ID。

响应示例：

```json
{
  "data": [
    {
      "task_id": "imgtask_xxx",
      "provider_task_id": "imgtask_xxx",
      "client_task_id": "task_xxx",
      "status": "succeeded",
      "progress": "100%",
      "result": {
        "images": [
          {
            "url": "https://img.example.com/images/2026/06/22/xxx.webp"
          }
        ]
      },
      "usage": {
        "total_tokens": 0,
        "actual_quota": 0
      },
      "error": null
    }
  ]
}
```

对外状态只有：

```text
submitted
queued
processing
succeeded
failed
```

当前实现中提交成功后通常直接进入 `queued`。

## 6. new-api internal execute 协议

image-handle worker 消费任务后，会调用 `executor.execute_url`：

```http
POST /api/internal/image/tasks/{task_id}/execute
Content-Type: application/json
X-ImageHandle-Timestamp: 1782140000
X-ImageHandle-Signature: <hex_hmac_sha256>
X-ImageHandle-Event-Id: evt_xxx
X-ImageHandle-Secret-Id: image_handle_1
```

body：

```json
{
  "provider_task_id": "imgtask_xxx",
  "attempt": 1
}
```

签名算法：

```text
HMAC-SHA256(timestamp + "." + raw_body, internal_execute_secret)
```

new-api 使用 `X-ImageHandle-Secret-Id` 找到 internal execute secret 验签。这个密钥建议和 callback secret 分开。

成功响应：

```json
{
  "status": "succeeded",
  "images": [
    {
      "url": "https://example.com/original-image.png",
      "b64_json": null,
      "mime_type": "image/png"
    }
  ],
  "usage": {
    "actual_quota": 1234
  }
}
```

失败响应：

```json
{
  "status": "failed",
  "error": {
    "code": "upstream_error",
    "message": "upstream provider error message",
    "retryable": true
  }
}
```

说明：

- `images[].url` 或 `images[].b64_json` 至少有一个。
- 如果返回 URL，image-handle 容器必须能访问该 URL。
- image-handle 会把返回图片重新上传到 R2，callback 给 new-api 的是最终 R2 URL。
- `usage` 会原样写入任务结果并透传到 callback。
- `status=failed` 且 `error.retryable=true` 时，image-handle 会做有限次数退避重试；不可重试或超过次数后进入 `failed` 并 callback。

## 7. 回调协议

image-handle 只在任务进入终态后发送回调：

- `succeeded`
- `failed`

如果请求中有 `callback.batch_url`，优先批量发送；否则使用 `callback.url` 单条发送。字段名仍然保持 `callback`，用于和接口协议兼容。

### 7.1 批量回调请求

```http
POST <callback.batch_url>
Content-Type: application/json
X-Callback-Timestamp: 1782120000
X-Callback-Signature: <hex_hmac_sha256>
X-Callback-Event-Id: evt_xxx
X-Callback-Secret-Id: channel_123
```

body：

```json
{
  "events": [
    {
      "event_id": "evt_xxx",
      "client_task_id": "task_xxx",
      "provider_task_id": "imgtask_xxx",
      "status": "succeeded",
      "progress": "100%",
      "result": {
        "images": [
          {
            "url": "https://img.example.com/images/2026/06/22/xxx.webp"
          }
        ]
      },
      "usage": {
        "total_tokens": 0,
        "actual_quota": 0
      },
      "error": null
    }
  ]
}
```

一个批次只会包含同一个 `callback_url/batch_url + secret_id` 的事件，因此整批可以用同一个密钥验签。

### 7.2 单条回调请求

```http
POST <callback.url>
Content-Type: application/json
X-Callback-Timestamp: 1782120000
X-Callback-Signature: <hex_hmac_sha256>
X-Callback-Event-Id: evt_xxx
X-Callback-Secret-Id: channel_123
```

body：

```json
{
  "event_id": "evt_xxx",
  "client_task_id": "task_xxx",
  "provider_task_id": "imgtask_xxx",
  "status": "failed",
  "progress": "100%",
  "result": null,
  "usage": null,
  "error": {
    "code": "generation_failed",
    "message": "upstream error message",
    "retryable": false
  }
}
```

## 8. 回调验签

签名算法：

```text
HMAC-SHA256(timestamp + "." + raw_body, callback_secret)
```

其中：

- `timestamp` 来自 `X-Callback-Timestamp`。
- `raw_body` 必须使用 HTTP 请求原始 body 字节串，不要重新 JSON stringify。
- `callback_secret` 是由 `X-Callback-Secret-Id` 映射得到的回调密钥。
- 签名结果是 hex 字符串，对比 `X-Callback-Signature`。

new-api 建议：

- 校验 timestamp 与当前时间差，例如 5 分钟内有效。
- 使用 constant-time compare 比较签名。
- `X-Callback-Secret-Id` 找不到密钥时拒绝。
- 对同一个 `event_id` 做幂等，重复回调直接返回 accepted 或 ignored。

## 9. 回调响应

new-api 返回 2xx 表示 HTTP 层成功。image-handle 会继续解析 body 中的 `results`，决定哪些事件标记为已投递。

推荐响应：

```json
{
  "code": "success",
  "results": [
    {
      "event_id": "evt_xxx",
      "client_task_id": "task_xxx",
      "status": "accepted"
    }
  ]
}
```

也支持用 `provider_task_id` 或 `task_id` 匹配：

```json
{
  "code": "success",
  "results": [
    {
      "client_task_id": "task_xxx",
      "status": "ignored_terminal"
    }
  ]
}
```

`status` 只有以下两个值会被 image-handle 视为该事件已成功投递：

```text
accepted
ignored_terminal
```

如果 HTTP 非 2xx、网络失败、body 中某个事件没有被 accepted，image-handle 会对未确认事件指数退避重试，默认最长保留 24 小时。

## 10. new-api 侧结算建议

建议 new-api 状态机：

```text
created/pre_charged
  -> submitted_to_provider
  -> processing
  -> succeeded_settled
  -> failed_refunded
```

处理规则：

- 提交 image-handle 成功后保存 `provider_task_id`。
- 回调 `succeeded`：校验图片 URL 后结算。
- 回调 `failed`：退款或释放预扣费。
- 回调丢失：使用批量查询兜底。
- 收到重复回调：如果 new-api 任务已终态，返回 `ignored_terminal`。

## 11. 错误格式

接口错误通常是：

```json
{
  "error": {
    "message": "Invalid image-handle API key",
    "type": "invalid_request_error",
    "code": "invalid_provider_api_key"
  }
}
```

常见错误：

| HTTP | code | 说明 |
| --- | --- | --- |
| 400 | `invalid_request_body` | body 不是 JSON 对象。 |
| 400 | `missing_client_task_id` | 缺少必填字段。 |
| 400 | `missing_input_text` | 缺少 `input.text`。 |
| 400 | `unsupported_operation` | `operation` 不是 `generation` 或 `edit`。 |
| 400 | `unsupported_executor` | `executor.type` 不是 `new_api_internal`。 |
| 400 | `invalid_execute_url` | `executor.execute_url` 非法。 |
| 400 | `invalid_task_ids` | 批量查询 ID 列表非法。 |
| 401 | `missing_authorization` | 缺少 Bearer token。 |
| 401 | `invalid_provider_api_key` | 服务鉴权 key 不匹配。 |
| 404 | `task_not_found` | 任务不存在。 |

## 12. 配置对齐清单

image-handle 侧：

```env
PROVIDER_API_KEYS=image-handle-key-from-new-api
POSTGRES_URL=postgres://...
REDIS_URL=redis://...
NEW_API_BASE_URL=http://new-api-internal:3000
CALLBACK_DEFAULT_SECRET=default-callback-secret
CALLBACK_SECRETS_JSON={"channel_123":"real-callback-secret"}
INTERNAL_EXECUTE_SECRETS_JSON={"image_handle_1":"real-internal-execute-secret"}
INTERNAL_EXECUTE_ALLOWED_HOSTS=newapi-master:3000
```

new-api 侧需要保存或配置：

- 调 image-handle 的服务鉴权 key。
- 每个 channel 的回调密钥。
- 每个 image-handle executor 的 internal execute 验签密钥。
- `client_task_id -> provider_task_id` 映射。
- 回调事件幂等表或幂等记录。
- 失败兜底轮询任务列表。

## 13. 最小联调命令

### 13.1 异步生图

使用线上域名时，把 `<image_handle_api_key>` 替换成 image-handle `PROVIDER_API_KEYS` 中配置的服务鉴权 key。这个 key 是 new-api 调 image-handle 用的，不是最终用户的 OpenAI key。

```bash
TASK_ID="task_test_$(date +%s)"

curl --location 'https://api.supertoken.cc/image-wrapper/v1/image/tasks' \
  -H "Authorization: Bearer <image_handle_api_key>" \
  -H 'Content-Type: application/json' \
  -d "{
    \"request_id\": \"req_${TASK_ID}\",
    \"client_task_id\": \"${TASK_ID}\",
    \"model\": \"gpt-image-2\",
    \"operation\": \"generation\",
    \"input\": {
      \"text\": \"吃铜锣烧的机器猫\"
    },
    \"parameters\": {
      \"size\": \"2560x1440\",
      \"quality\": \"auto\",
      \"n\": 1,
      \"output_format\": \"png\"
    },
    \"executor\": {
      \"type\": \"new_api_internal\",
      \"execute_url\": \"http://newapi-master:3000/api/internal/image/tasks/${TASK_ID}/execute\",
      \"secret_id\": \"image_handle_1\"
    },
    \"metadata\": {
      \"channel_id\": \"manual_test\"
    }
  }"
```

返回：

```json
{
  "provider_task_id": "imgtask_xxx",
  "client_task_id": "task_test_xxx",
  "status": "queued"
}
```

### 13.2 异步编辑图

编辑图使用同一个提交接口，区别是：

- `operation` 使用 `edit`。
- `input.images` 放待编辑图片 URL 数组。
- `input.mask` 可选，放 mask 图片 URL。
- `input.text` 仍然作为统一文本输入，真实上游字段映射由 new-api internal execute 负责。

```bash
TASK_ID="task_edit_$(date +%s)"

curl --location 'https://api.supertoken.cc/image-wrapper/v1/image/tasks' \
  -H "Authorization: Bearer <image_handle_api_key>" \
  -H 'Content-Type: application/json' \
  -d "{
    \"request_id\": \"req_${TASK_ID}\",
    \"client_task_id\": \"${TASK_ID}\",
    \"model\": \"gpt-image-2\",
    \"operation\": \"edit\",
    \"input\": {
      \"text\": \"把图片里的角色改成正在吃铜锣烧的机器猫，保持背景风格一致\",
      \"images\": [
        \"https://img.example.com/source/input.png\"
      ],
      \"mask\": null
    },
    \"parameters\": {
      \"size\": \"2560x1440\",
      \"quality\": \"auto\",
      \"n\": 1,
      \"output_format\": \"png\"
    },
    \"executor\": {
      \"type\": \"new_api_internal\",
      \"execute_url\": \"http://newapi-master:3000/api/internal/image/tasks/${TASK_ID}/execute\",
      \"secret_id\": \"image_handle_1\"
    },
    \"metadata\": {
      \"channel_id\": \"manual_test\"
    }
  }"
```

如果上游模型需要 mask，把 `mask` 改成公开可访问的 mask 图片 URL：

```json
{
  "input": {
    "text": "只替换透明区域里的主体",
    "images": ["https://img.example.com/source/input.png"],
    "mask": "https://img.example.com/source/mask.png"
  }
}
```

### 13.3 本地 mock 联调

提交任务：

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
      "text": "a clean product photo"
    },
    "parameters": {
      "size": "1024x1024",
      "n": 1,
      "output_format": "png"
    },
    "executor": {
      "type": "new_api_internal",
      "execute_url": "http://mock-new-api:3999/api/internal/image/tasks/task_local_1/execute",
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

### 13.4 查询任务

单个查询：

```bash
curl --location 'https://api.supertoken.cc/image-wrapper/v1/image/tasks/imgtask_xxx' \
  -H "Authorization: Bearer <image_handle_api_key>"
```

批量查询：

```bash
curl --location 'https://api.supertoken.cc/image-wrapper/v1/image/tasks/query' \
  -H "Authorization: Bearer <image_handle_api_key>" \
  -H 'Content-Type: application/json' \
  -d '{"task_ids":["imgtask_xxx"]}'
```

### 13.5 带回调的提交示例

手动测试时可以不传 `callback`。不传时任务仍会执行、写 PostgreSQL、上传 R2，只是不会通知 new-api。

new-api 正式对接时建议传：

```json
{
  "callback": {
    "url": "http://newapi-master:3000/api/task/callback/external-image/task_xxx",
    "batch_url": "http://newapi-master:3000/api/task/callback/external-image/batch",
    "secret_id": "channel_123"
  },
  "metadata": {
    "channel_id": "channel_123"
  }
}
```
