# new-api 对接 image-handle 异步图片任务文档

本文档给 new-api 侧对接 `image-handle` 异步图片执行服务使用。同步兼容接口 `/v1/images/generations`、`/v1/images/edits` 保持原逻辑不变。

`image-handle` 不参与用户鉴权、扣费、结算或退款。new-api 负责用户鉴权、预扣费、选择并锁定真实渠道、提供短期凭证、接收终态 callback，并按自己的计价规则结算或退款。

## 1. 整体流程

```text
用户
  -> new-api 鉴权 / 预扣费 / 选择真实渠道
  -> new-api POST /v1/image/tasks 提交任务到 image-handle
  -> image-worker resolve credential lease
  -> image-worker 使用 base_url/api_key/model 直连上游
  -> image-worker 上传 R2
  -> image-handle 写 PostgreSQL 终态
  -> image-handle callback new-api
  -> new-api 结算或退款
```

核心原则：

- 任务 payload 不传真实上游 `api_key`。
- new-api 不再中转大图 base64。
- image-handle 不选择 provider/channel，只执行 new-api 已锁定的真实渠道。
- 图片结果统一返回 R2 URL。

## 2. image-handle 鉴权

new-api 调 image-handle 时使用服务鉴权 key：

```http
Authorization: Bearer <image_handle_api_key>
```

该 key 配置在 image-handle 的 `PROVIDER_API_KEYS`，不是最终用户的 OpenAI/xAI/第三方平台 key。

## 3. 提交异步任务

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
    "type": "provider_direct_lease",
    "lease_id": "lease_xxx",
    "resolve_url": "http://newapi-master:3000/api/internal/image/credential-leases/lease_xxx/resolve",
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
| `request_id` | 是 | new-api 本次请求 ID，用于链路排查。 |
| `client_task_id` | 是 | new-api 侧任务 ID，也是幂等关键字段。 |
| `model` | 是 | 用户请求模型。worker 最终使用 resolve 返回的真实模型。 |
| `operation` | 是 | `generation` 或 `edit`。 |
| `input.text` | 是 | 统一文本输入，worker 调上游时映射为 OpenAI Images 的 `prompt`。 |
| `input.images` | edit 必填 | 编辑图输入图片 URL 数组。第一版只支持 URL。 |
| `input.mask` | 否 | 编辑图 mask URL。 |
| `parameters` | 否 | 通用模型参数，例如 `size`、`quality`、`n`、`output_format`。 |
| `executor.type` | 是 | 固定为 `provider_direct_lease`。 |
| `executor.lease_id` | 是 | new-api 创建的短期执行租约 ID。 |
| `executor.resolve_url` | 是 | image-worker 领取短期凭证的内部地址。 |
| `executor.secret_id` | 是 | resolve HMAC 密钥 ID。 |
| `callback.url` | 建议 | 单任务 callback 地址。 |
| `callback.batch_url` | 建议 | 批量 callback 地址，存在时优先批量投递。 |
| `callback.secret_id` | 建议 | callback HMAC 密钥 ID，会放到 `X-Callback-Secret-Id`。 |
| `metadata.channel_id` | 建议 | 用于限速维度和管理台展示。 |

返回：

```json
{
  "provider_task_id": "imgtask_xxx",
  "client_task_id": "task_xxx",
  "status": "queued"
}
```

new-api 对外仍只暴露自己的 `client_task_id`，不要把 `provider_task_id` 暴露给最终用户。

## 4. 幂等和查询

幂等键：

```text
image_handle_api_key + client_task_id
```

重复提交返回同一个 `provider_task_id`，不会重复入队。

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

对外状态：

```text
submitted
queued
processing
succeeded
failed
```

## 5. credential lease resolve 协议

worker 消费任务后会调用 `executor.resolve_url`：

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

new-api 用 `X-ImageHandle-Secret-Id` 找到密钥验签。该密钥建议和 callback secret 分开。

成功响应第一版固定为 OpenAI Images 兼容格式：

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

`base_url` 拼接规则：

```text
https://api.xxx.com/v1 + /images/generations
https://api.xxx.com/v1 + /images/edits
```

不要返回已经包含 `/images/generations` 的完整地址，也不要让 image-handle 额外拼 `/v1`。

resolve 失败响应：

```json
{
  "error": {
    "code": "lease_expired",
    "message": "credential lease expired",
    "retryable": false
  }
}
```

image-handle 会按 `retryable` 判断是否重试。签名失败、lease 过期、任务取消、模型不支持等不可恢复错误不要返回 `retryable: true`。

## 6. worker 上游调用

生图：

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

编辑图第一版只从任务 `input.images` 和 `input.mask` 下载 URL，再由 worker 构造 multipart。new-api 不需要再中转图片 base64。

## 7. callback 协议

callback header：

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

批量 callback 会按 `callback_url + secret_id` 分组，同一个 batch 只包含同一个 `secret_id`。

成功事件：

```json
{
  "status": "succeeded",
  "client_task_id": "task_xxx",
  "provider_task_id": "imgtask_xxx",
  "progress": "100%",
  "result": {
    "images": [
      {
        "url": "https://r2.xxx/a.png",
        "mime_type": "image/png"
      }
    ]
  },
  "usage": {
    "total_tokens": 123,
    "input_tokens": 100,
    "output_tokens": 23
  },
  "error": null,
  "raw_response": {
    "id": "xxx",
    "created": 123,
    "model": "gpt-image-2",
    "usage": {},
    "data": [
      {
        "url": "https://r2.xxx/a.png",
        "b64_json": "[omitted]",
        "revised_prompt": "..."
      }
    ]
  },
  "raw_response_truncated": true,
  "raw_response_omitted_fields": ["data[].b64_json"]
}
```

失败事件：

```json
{
  "status": "failed",
  "client_task_id": "task_xxx",
  "provider_task_id": "imgtask_xxx",
  "progress": "100%",
  "result": null,
  "usage": null,
  "error": {
    "code": "upstream_error",
    "message": "upstream returned 400",
    "retryable": false
  },
  "raw_response": {
    "error": {
      "message": "...",
      "type": "invalid_request_error",
      "code": "..."
    }
  },
  "raw_response_truncated": false,
  "raw_response_omitted_fields": []
}
```

`raw_response` 是安全版上游响应：保留有价值结构，但必须剔除 `b64_json`、base64 大字段、data URI 图片和超大 inline image。`RAW_RESPONSE_MAX_BYTES` 默认 `262144`。

new-api 需要保证 callback 幂等：同一个 `client_task_id` 的终态通知重复到达时，不重复结算、不重复退款。

## 8. 配置对齐清单

image-handle 侧：

```env
PROVIDER_API_KEYS=image-handle-key-from-new-api
POSTGRES_URL=postgres://...
REDIS_URL=redis://...
NEW_API_BASE_URL=http://new-api-internal:3000
CALLBACK_DEFAULT_SECRET=default-callback-secret
CALLBACK_SECRETS_JSON={"channel_123":"real-callback-secret"}
CREDENTIAL_LEASE_SECRETS_JSON={"image_handle_1":"real-credential-lease-secret"}
CREDENTIAL_LEASE_ALLOWED_HOSTS=newapi-master:3000
RAW_RESPONSE_MAX_BYTES=262144
```

new-api 侧需要保存或配置：

- 调 image-handle 的服务鉴权 key。
- 每个 channel 的 callback 密钥。
- 每个 image-handle worker 的 credential lease resolve 验签密钥。
- `client_task_id -> provider_task_id` 映射。
- `lease_id -> client_task_id/channel_id/model/operation/expires_at` 映射。
- 回调事件幂等表或幂等记录。
- 失败兜底批量轮询任务列表。

## 9. 最小联调命令

异步生图：

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
      \"type\": \"provider_direct_lease\",
      \"lease_id\": \"lease_${TASK_ID}\",
      \"resolve_url\": \"http://newapi-master:3000/api/internal/image/credential-leases/lease_${TASK_ID}/resolve\",
      \"secret_id\": \"image_handle_1\"
    },
    \"metadata\": {
      \"channel_id\": \"manual_test\"
    }
  }"
```

异步编辑图：

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
      \"text\": \"改成赛博朋克风格\",
      \"images\": [\"https://img.example.com/input.png\"],
      \"mask\": \"https://img.example.com/mask.png\"
    },
    \"parameters\": {
      \"size\": \"1024x1024\",
      \"n\": 1,
      \"output_format\": \"png\"
    },
    \"executor\": {
      \"type\": \"provider_direct_lease\",
      \"lease_id\": \"lease_${TASK_ID}\",
      \"resolve_url\": \"http://newapi-master:3000/api/internal/image/credential-leases/lease_${TASK_ID}/resolve\",
      \"secret_id\": \"image_handle_1\"
    }
  }"
```

查询：

```bash
curl 'https://api.supertoken.cc/image-wrapper/v1/image/tasks/imgtask_xxx' \
  -H "Authorization: Bearer <image_handle_api_key>"
```

批量查询：

```bash
curl 'https://api.supertoken.cc/image-wrapper/v1/image/tasks/query' \
  -H "Authorization: Bearer <image_handle_api_key>" \
  -H 'Content-Type: application/json' \
  -d '{"task_ids":["imgtask_xxx"]}'
```
