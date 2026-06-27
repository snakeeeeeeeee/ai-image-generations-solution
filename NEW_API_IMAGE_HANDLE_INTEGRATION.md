# new-api 对接 image-handle 图片任务文档

本文档给 new-api 侧对接 `image-handle` 图片任务执行服务使用，包含异步接口和同步等待包装接口。旧同步兼容接口 `/v1/images/generations`、`/v1/images/edits` 保持原逻辑不变。

`image-handle` 不参与用户鉴权、扣费、结算或退款。new-api 负责用户鉴权、预扣费、选择并锁定真实渠道、提供短期凭证、接收终态 callback，并按自己的计价规则结算或退款。

## 1. 整体流程

```text
用户
  -> new-api 鉴权 / 预扣费 / 选择真实渠道
  -> new-api POST /v1/image/tasks 或 /v1/image/tasks/sync 提交任务到 image-handle
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
- 编辑图任务 payload 只传图片 URL；如果用户输入是 multipart 或 base64，new-api 先调用 image-handle 上传接口换成临时 R2 URL。
- image-handle 不选择 provider/channel，只执行 new-api 已锁定的真实渠道。
- 默认图片结果返回 R2 URL；`base64` 只允许同步等待接口短期返回，不进入 callback 或查询结果。
- 上游错误不做业务隐藏：标准 `error` 会返回上游 HTTP 状态码、上游 error code/type/message/param；`raw_response` 会返回安全版上游原始 JSON。

## 2. image-handle 鉴权

new-api 调 image-handle 时使用服务鉴权 key：

```http
Authorization: Bearer <image_handle_api_key>
```

该 key 配置在 image-handle 的 `PROVIDER_API_KEYS`，不是最终用户的 OpenAI/xAI/第三方平台 key。

## 3. 提交图片任务

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
| `result_data_format` | 否 | 返回结果格式，默认 `url`。普通异步接口只支持 `url`；同步等待接口可传 `base64`。 |
| `input.text` | 是 | 统一文本输入，worker 调上游时映射为 OpenAI Images 的 `prompt`。 |
| `input.images` | edit 必填 | 编辑图输入图片 URL 数组。任务接口只支持 URL；multipart/base64 先走上传接口。 |
| `input.mask` | 否 | 编辑图 mask URL；multipart/base64 mask 先走上传接口。 |
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

## 4. 同步等待包装接口

如果 new-api 希望在同一个 HTTP 请求里等待 worker 执行结果，可以调用：

```http
POST /v1/image/tasks/sync
Authorization: Bearer <image_handle_api_key>
Content-Type: application/json
```

请求体与 `POST /v1/image/tasks` 完全一致。该接口不会在 API 进程里直接执行生图，流程仍然是：

```text
创建任务
-> 入 Redis 队列
-> worker 抢任务执行
-> API 轮询 PostgreSQL 等待终态
```

这个接口适合 new-api 需要“看起来像同步调用”的场景，但它不是旧的 `/v1/images/generations` 兼容接口；执行、上传、状态写入仍然由 image-worker 完成。多机 worker 部署时，任意 worker 消费任务并写入 PostgreSQL 终态后，原 HTTP 请求所在的 image-api 节点都能读到结果并返回。

## 5. result_data_format 返回格式

`result_data_format` 是 image-handle 的返回控制字段，不会透传给上游模型。

```json
{
  "result_data_format": "url"
}
```

可选值：

| 值 | 支持接口 | 行为 |
| --- | --- | --- |
| `url` | `/v1/image/tasks`、`/v1/image/tasks/sync` | 默认值。worker 上传 R2，任务查询和 callback 都返回 R2 URL。 |
| `base64` | 仅 `/v1/image/tasks/sync` | worker 仍会上传 R2 并写 URL 终态；API 只在当前同步等待 HTTP 响应里返回短期 base64。 |

重要限制：

- `POST /v1/image/tasks` 传 `result_data_format=base64` 会返回 `400 unsupported_result_data_format`。
- `GET /v1/image/tasks/{provider_task_id}`、`POST /v1/image/tasks/query` 和 callback 永远返回 URL，不返回 base64。
- `base64` 结果不写 PostgreSQL、不进 callback、不在管理台展示，只短期写 Redis 给当前同步等待请求读取。
- 第一版 `base64` 只面向 OpenAI Images 兼容响应中的 `data[].b64_json`。如果上游只返回 URL，`base64` 同步任务会失败。
- 单次 base64 响应上限固定为 100MB，超过会失败为 `base64_result_too_large`。
- 同一个 `client_task_id` 重复提交时，以第一次创建任务时保存的 `result_data_format` 为准；new-api 不要用同一个任务 ID 在 `url/base64` 之间切换。

new-api 推荐处理方式：

- 用户/上游调用方要 URL：调用 `/v1/image/tasks` 或 `/v1/image/tasks/sync`，不传 `result_data_format`。
- 用户/上游调用方要 base64：只调用 `/v1/image/tasks/sync`，传 `"result_data_format": "base64"`。
- 即使同步 base64 已经返回成功，new-api 仍要保存 `provider_task_id` 并处理后续 callback 幂等，因为 callback/查询是任务事实结果，仍会返回 R2 URL。

如果误把 base64 发到普通异步接口，会返回：

```json
{
  "error": {
    "message": "result_data_format=base64 is only supported by /v1/image/tasks/sync",
    "type": "invalid_request_error",
    "code": "unsupported_result_data_format"
  }
}
```

## 5.1 编辑图输入上传接口

编辑图任务的 `input.images` 和 `input.mask` 仍然只接收 `http/https` URL。用户上传的是 multipart 文件或 base64 时，new-api 先调用 image-handle 的临时上传接口，由 image-handle 上传到 R2 并返回临时 URL，然后 new-api 再把这些 URL 放进 `/v1/image/tasks` 或 `/v1/image/tasks/sync`。

这样可以让 multipart/base64 编辑图也走 image-worker，同时避免把大 base64 或 multipart 文件塞进任务队列和 PostgreSQL。

multipart 上传：

```http
POST /v1/image/uploads
Authorization: Bearer <image_handle_api_key>
Content-Type: multipart/form-data
```

示例：

```bash
curl --location 'https://api.supertoken.cc/image-wrapper/v1/image/uploads' \
  -H "Authorization: Bearer <image_handle_api_key>" \
  -F 'image=@./input.png' \
  -F 'mask=@./mask.png'
```

base64 上传：

```http
POST /v1/image/uploads/base64
Authorization: Bearer <image_handle_api_key>
Content-Type: application/json
```

示例：

```json
{
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
}
```

也支持显式 `uploads` 数组：

```json
{
  "uploads": [
    {
      "field": "image",
      "filename": "input.png",
      "b64_json": "iVBORw0KGgo..."
    },
    {
      "field": "mask",
      "filename": "mask.png",
      "b64_json": "iVBORw0KGgo..."
    }
  ]
}
```

上传响应：

```json
{
  "uploads": [
    {
      "id": "upload_xxx",
      "field": "image",
      "filename": "input.png",
      "key": "images/tmp/uploads/2026/06/27/upload_xxx.png",
      "url": "https://img.example.com/images/tmp/uploads/2026/06/27/upload_xxx.png",
      "mime_type": "image/png",
      "bytes": 12345,
      "width": 1024,
      "height": 1024,
      "format": "png",
      "temporary": true
    }
  ],
  "images": [
    "https://img.example.com/images/tmp/uploads/2026/06/27/upload_xxx.png"
  ],
  "mask": "https://img.example.com/images/tmp/uploads/2026/06/27/upload_yyy.png",
  "by_field": {
    "image": [
      "https://img.example.com/images/tmp/uploads/2026/06/27/upload_xxx.png"
    ],
    "mask": [
      "https://img.example.com/images/tmp/uploads/2026/06/27/upload_yyy.png"
    ]
  }
}
```

new-api 后续提交编辑图任务时使用响应里的 `images` 和 `mask`：

```json
{
  "operation": "edit",
  "input": {
    "text": "改成赛博朋克风格",
    "images": ["https://img.example.com/images/tmp/uploads/2026/06/27/upload_xxx.png"],
    "mask": "https://img.example.com/images/tmp/uploads/2026/06/27/upload_yyy.png"
  }
}
```

上传接口说明：

- 鉴权同任务接口，使用 `PROVIDER_API_KEYS`。
- 支持 `png`、`jpeg`、`webp`，会返回图片宽高和 mime type。
- 上传对象路径为 `R2_KEY_PREFIX/tmp/uploads/YYYY/MM/DD/upload_xxx.ext`。
- 临时文件生命周期建议在 R2 上配置规则清理，例如 1 天后删除 `tmp/uploads/`。
- 上传接口只负责把输入图变成 URL，不创建任务、不触发计费、不调用上游模型。
- 如果上传失败，new-api 不应提交后续 edit 任务，应按自己的预扣费逻辑释放或退款。

## 6. 同步等待响应

任务在 `SYNC_TASK_TIMEOUT_MS` 内完成时返回 `200`：

```json
{
  "task_id": "imgtask_xxx",
  "provider_task_id": "imgtask_xxx",
  "client_task_id": "task_xxx",
  "status": "succeeded",
  "progress": "100%",
  "result_data_format": "url",
  "result": {
    "images": [
      {
        "url": "https://img.example.com/images/xxx.png",
        "mime_type": "image/png",
        "format": "png",
        "width": 1024,
        "height": 1024,
        "size_bytes": 1234567,
        "filename": "xxx.png",
        "revised_prompt": "..."
      }
    ],
    "output": {
      "created": 1782581166,
      "background": "opaque",
      "output_format": "png",
      "quality": "high",
      "size": "1024x1024"
    },
    "metadata": {
      "image_count": 1,
      "input_image_count": 0,
      "mask_used": false
    }
  },
  "usage": {
    "total_tokens": 123
  },
  "error": null,
  "sync_wait": {
    "completed": true,
    "timeout_ms": 300000
  }
}
```

如果同步等待请求传入 `"result_data_format": "base64"`，成功时当前 HTTP 响应会改为：

```json
{
  "task_id": "imgtask_xxx",
  "provider_task_id": "imgtask_xxx",
  "client_task_id": "task_xxx",
  "status": "succeeded",
  "progress": "100%",
  "result_data_format": "base64",
  "result": {
    "images": [
      {
        "b64_json": "iVBORw0KGgo...",
        "mime_type": "image/png"
      }
    ]
  },
  "usage": {
    "total_tokens": 123
  },
  "error": null,
  "sync_wait": {
    "completed": true,
    "timeout_ms": 300000
  }
}
```

注意：同一个任务的 callback 和后续查询仍然返回 R2 URL。

如果任务在等待窗口内进入失败终态，也返回 `200`，但 `status` 是 `failed`。new-api 必须以 `status` 判断结算或退款，不要只用 HTTP 状态码判断任务成功：

```json
{
  "task_id": "imgtask_xxx",
  "provider_task_id": "imgtask_xxx",
  "client_task_id": "task_xxx",
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
  "raw_response_omitted_fields": [],
  "sync_wait": {
    "completed": true,
    "timeout_ms": 300000
  }
}
```

如果等待超时，接口返回 `202`，任务继续在后台执行：

```json
{
  "task_id": "imgtask_xxx",
  "provider_task_id": "imgtask_xxx",
  "client_task_id": "task_xxx",
  "status": "processing",
  "progress": "50%",
  "result_data_format": "url",
  "result": null,
  "usage": null,
  "error": null,
  "sync_wait": {
    "completed": false,
    "timeout_ms": 300000
  }
}
```

new-api 对同步等待接口的处理建议：

- `HTTP 200 + status=succeeded`：按 `result.images[].url` 和 `usage/raw_response` 结算成功。
- `HTTP 200 + status=failed`：按 `error` 做失败终态处理，释放预扣或退款。
- `HTTP 202 + status=queued/processing`：不要结算为成功或失败，任务继续后台执行，等待 callback 或批量查询兜底。
- `HTTP 4xx/5xx`：表示提交或等待接口本身失败，按错误码判断是否重试提交；幂等键仍是 `image_handle_api_key + client_task_id`。

new-api 必须保留 callback 或批量查询兜底，因为同步等待可能因 HTTP 超时、客户端断连、网关超时等原因提前结束。即使同步等待已经返回 `200`，后续 callback 也可能投递到达，new-api 需要按 `client_task_id` 做终态幂等，避免重复结算或退款。

相关 image-handle 配置：

```env
SYNC_TASK_TIMEOUT_MS=300000
SYNC_TASK_POLL_INTERVAL_MS=500
SYNC_WAIT_CONCURRENCY=200
```

## 7. 幂等和查询

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

## 8. credential lease resolve 协议

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

## 9. worker 上游调用

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

## 10. callback 协议

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
  "result_data_format": "url",
  "result": {
    "images": [
      {
        "url": "https://r2.xxx/a.png",
        "mime_type": "image/png",
        "format": "png",
        "width": 1024,
        "height": 1024,
        "size_bytes": 1234567,
        "filename": "a.png",
        "revised_prompt": "..."
      }
    ],
    "output": {
      "created": 1782581166,
      "background": "opaque",
      "output_format": "png",
      "quality": "high",
      "size": "1024x1024"
    },
    "metadata": {
      "image_count": 1,
      "input_image_count": 0,
      "mask_used": false
    }
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
```

`error` 中会直接带上游错误字段，方便 new-api 计费、退款、展示和排障：

- `upstream_status`：上游 HTTP 状态码。
- `provider_error_code`：上游 `error.code`。
- `provider_error_type`：上游 `error.type`。
- `provider_error_message`：上游 `error.message`。
- `provider_error_param`：上游 `error.param`。
- `upstream_error`：上游原始错误 JSON。

`raw_response` 是安全版上游响应：保留有价值结构，但必须剔除 `b64_json`、base64 大字段、data URI 图片和超大 inline image。`RAW_RESPONSE_MAX_BYTES` 默认 `262144`。错误响应不会做业务隐藏；只有密钥、签名、base64 大字段这类不应外传的数据会被清理或省略。

成功结果字段说明：

- `result.images[].url`：image-handle 上传到 R2 后的稳定资源 URL。
- `result.images[].mime_type/format/width/height/size_bytes`：image-handle 按最终图片内容解析得到。
- `result.images[].filename`：从 R2 URL 中提取的文件名。
- `result.images[].revised_prompt`：如果上游 `data[]` 返回则透传。
- `result.output.created/background/output_format/quality/size`：从上游原始响应中提取的 OpenAI Images 常用输出字段。
- `result.metadata.image_count`：本次输出图片数量。
- `result.metadata.input_image_count/mask_used/input_fidelity`：编辑图执行元数据；`input_fidelity` 来自请求参数，不一定会在上游响应里出现。

new-api 需要保证 callback 幂等：同一个 `client_task_id` 的终态通知重复到达时，不重复结算、不重复退款。

## 11. 配置对齐清单

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
SYNC_TASK_TIMEOUT_MS=300000
SYNC_TASK_POLL_INTERVAL_MS=500
SYNC_WAIT_CONCURRENCY=200
```

new-api 侧需要保存或配置：

- 调 image-handle 的服务鉴权 key。
- 每个 channel 的 callback 密钥。
- 每个 image-handle worker 的 credential lease resolve 验签密钥。
- `client_task_id -> provider_task_id` 映射。
- `lease_id -> client_task_id/channel_id/model/operation/expires_at` 映射。
- 回调事件幂等表或幂等记录。
- 失败兜底批量轮询任务列表。

## 12. 最小联调命令

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

同步等待生图：

```bash
TASK_ID="task_sync_$(date +%s)"

curl --location 'https://api.supertoken.cc/image-wrapper/v1/image/tasks/sync' \
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
    \"callback\": {
      \"url\": \"https://new-api.example.com/api/task/callback/external-image/${TASK_ID}\",
      \"batch_url\": \"https://new-api.example.com/api/task/callback/external-image/batch\",
      \"secret_id\": \"manual_test\"
    },
    \"metadata\": {
      \"channel_id\": \"manual_test\"
    }
  }"
```

同步等待并直接返回 base64：

```bash
TASK_ID="task_sync_b64_$(date +%s)"

curl --location 'https://api.supertoken.cc/image-wrapper/v1/image/tasks/sync' \
  -H "Authorization: Bearer <image_handle_api_key>" \
  -H 'Content-Type: application/json' \
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

同步等待编辑图：

```bash
TASK_ID="task_sync_edit_$(date +%s)"

curl --location 'https://api.supertoken.cc/image-wrapper/v1/image/tasks/sync' \
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
    },
    \"callback\": {
      \"url\": \"https://new-api.example.com/api/task/callback/external-image/${TASK_ID}\",
      \"batch_url\": \"https://new-api.example.com/api/task/callback/external-image/batch\",
      \"secret_id\": \"manual_test\"
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
