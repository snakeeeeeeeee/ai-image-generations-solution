# image-handle 部署说明

本目录专门放部署相关文件，基于 Docker Compose 提供三种使用方式：

- 开发环境：从源码构建镜像，并启动本地 PostgreSQL、Redis、mock new-api。
- 生产主节点：运行预构建镜像，可以同时部署 image-handle 专用 PostgreSQL、Redis。
- 生产业务节点：运行预构建镜像，连接共享 PostgreSQL、Redis、R2 和上游 new-api。
- 处理节点：在另一台机器上只增加任务处理和回调投递能力。

不要提交 `deploy/.env`，里面会包含 R2、上游服务和回调密钥。

## 推荐使用脚本

`deploy/image-handle.sh` 会自动选择对应 Compose 文件，并支持构建、拉取、启动、重启、停止、日志和扩容。

```bash
cd deploy
cp .env.prod.example .env
# 填好真实配置后，如果主节点也要部署 image-handle 专用 PG/Redis：
./image-handle.sh --env prod start full
```

常用命令：

```bash
# 生产：拉取镜像并启动 API、Worker、Notifier
./image-handle.sh --env prod start all

# 生产主节点：拉取镜像并启动 PG、Redis、API、Worker、Notifier
./image-handle.sh --env prod start full

# 生产主节点：只启动或重启 PG、Redis
./image-handle.sh --env prod start infra
./image-handle.sh --env prod restart infra

# 生产：只重启 API
./image-handle.sh --env prod restart api

# 生产：只重启任务处理和回调投递
./image-handle.sh --env prod restart async

# 生产：如果这台机器有完整源码，不走镜像仓库，先本机构建再重启
./image-handle.sh --env prod --build restart all

# 生产：扩容任务处理和回调投递进程
./image-handle.sh --env prod start async --scale image-worker=5 --scale image-notifier=2

# 新机器只加入处理节点
./image-handle.sh --env worker start all

# 查看状态和日志
./image-handle.sh --env prod ps all
./image-handle.sh --env prod logs api
```

脚本服务别名：

| 别名 | 实际服务 |
| --- | --- |
| `all` | 当前环境的全部服务；prod 为 `image-api image-worker image-notifier` |
| `full` | dev/prod 的基础设施 + 业务服务；prod 为 `image-handle-postgres image-handle-redis image-api image-worker image-notifier` |
| `api` | `image-api` |
| `worker` | `image-worker` |
| `notifier` | `image-notifier` |
| `async` | `image-worker image-notifier` |
| `infra` | dev/prod，本地 PostgreSQL + Redis |
| `mock` | dev 专用，mock-new-api |

`config` 命令默认会拒绝执行，因为 Compose 展开后的配置可能包含 R2 和回调密钥。确认需要时再加 `--show-secrets`。

## 开发环境

适用于本机或有完整源码的服务器：

```bash
cd deploy
cp .env.dev.example .env
# 如果要验证真实上传，请把 .env 里的 R2 配置填成真实值。
./image-handle.sh --env dev start all
```

同一台机器上增加任务处理和回调投递进程数量：

```bash
./image-handle.sh --env dev start async --scale image-worker=5 --scale image-notifier=2
```

开发环境端口都在 `deploy/.env` 中配置：

```env
# image-api 容器内监听端口
PORT=8787
# image-api 映射到宿主机的端口
IMAGE_API_HOST_PORT=8787

# PostgreSQL/Redis 映射到宿主机的端口
POSTGRES_HOST_PORT=5432
REDIS_HOST_PORT=6379

# mock-new-api 容器内端口和宿主机端口
MOCK_NEW_API_PORT=3999
MOCK_NEW_API_HOST_PORT=3999
```

如果同一台机器上已经有 PostgreSQL、Redis 或其他 image-handle 实例，只需要改宿主机端口，例如 `IMAGE_API_HOST_PORT=8877`、`POSTGRES_HOST_PORT=15432`、`REDIS_HOST_PORT=16379`。容器内部服务名和内部端口保持不变。

## 生产主节点自带 PostgreSQL/Redis

适用于你现在这种部署方式：生产环境要给 image-handle 专门部署一套 PostgreSQL 和 Redis。它们只应该部署一套，作为所有 image-handle 节点共享的基础设施。

```bash
cd deploy
cp .env.prod.example .env
# 填好真实镜像、R2、服务鉴权 key、回调密钥、上游配置，以及 PG/Redis 密码。
./image-handle.sh --env prod start full
```

如果 new-api 已经接入一个外部 Docker 网络，例如 `ai-gateway`，推荐让 image-handle 也加入这个网络，然后直接用 new-api 容器名访问：

```env
IMAGE_HANDLE_GATEWAY_NETWORK=ai-gateway
NEW_API_BASE_URL=http://newapi-master:3000
```

脚本检测到 `IMAGE_HANDLE_GATEWAY_NETWORK` 不为空时，会自动追加 `docker-compose.gateway.yml`。这样不需要改 new-api 的 `127.0.0.1:3000->3000` 端口绑定，也不依赖 Docker 网关 IP。

主节点自带 PG/Redis 时，`.env` 里的连接串保持容器内服务名：

```env
POSTGRES_DB=image_handle
POSTGRES_USER=image_handle
POSTGRES_PASSWORD=<强密码>
POSTGRES_BIND_ADDR=0.0.0.0
POSTGRES_HOST_PORT=5432
POSTGRES_URL=postgres://image_handle:<强密码>@image-handle-postgres:5432/image_handle

REDIS_PASSWORD=<强密码>
REDIS_BIND_ADDR=0.0.0.0
REDIS_HOST_PORT=6379
REDIS_URL=redis://:<强密码>@image-handle-redis:6379
```

如果宿主机已经有 PostgreSQL 或 Redis，可以改对外映射端口，例如 `POSTGRES_HOST_PORT=15432`、`REDIS_HOST_PORT=16379`。容器之间访问仍然使用 `image-handle-postgres:5432` 和 `image-handle-redis:6379`。

如果只允许内网访问，建议把 `POSTGRES_BIND_ADDR` 和 `REDIS_BIND_ADDR` 改成主节点内网 IP，并在安全组/防火墙里只放行其他 image-handle 机器。不要把 PostgreSQL/Redis 暴露到公网。

只想先启动基础设施：

```bash
./image-handle.sh --env prod start infra
```

再启动业务服务：

```bash
./image-handle.sh --env prod start all
```

## 生产业务节点连接外部 PostgreSQL/Redis

如果 PostgreSQL/Redis 已经部署在云数据库、独立数据库机器或另一台 image-handle 主节点上，生产业务节点不要再启动本地 PG/Redis，只需要启动业务服务：

```bash
cd deploy
cp .env.prod.example .env
# POSTGRES_URL 和 REDIS_URL 改成共享基础设施的内网地址。
./image-handle.sh --env prod start all
```

同一台生产机器上增加任务处理和回调投递进程数量：

```bash
./image-handle.sh --env prod start async --scale image-worker=5 --scale image-notifier=2
```

生产环境如果 `image-api` 要映射到其他宿主机端口，修改 `deploy/.env`：

```env
PORT=8787
IMAGE_API_HOST_PORT=8877
```

这种模式下，`POSTGRES_URL` 和 `REDIS_URL` 应指向共享外部服务。

## 新增处理节点

适用于另一台机器，只加入异步任务处理能力：

```bash
cd deploy
cp .env.prod.example .env
# POSTGRES_URL 和 REDIS_URL 必须指向同一套生产共享服务。
./image-handle.sh --env worker start all
```

如果新增处理节点也需要访问同一个 Docker 外部网络里的 new-api，可同样配置：

```env
IMAGE_HANDLE_GATEWAY_NETWORK=ai-gateway
NEW_API_BASE_URL=http://newapi-master:3000
```

如果共享 PostgreSQL/Redis 是由主节点 `start full` 启动的，新增机器上的 `.env` 不要使用容器服务名，要改成主节点内网 IP：

```env
POSTGRES_URL=postgres://image_handle:<强密码>@<主节点内网IP>:5432/image_handle
REDIS_URL=redis://:<强密码>@<主节点内网IP>:6379
```

`docker-compose.worker.yml` 用于新增处理节点，要求 `IMAGE_HANDLE_IMAGE` 指向本机已有或镜像仓库可拉取的镜像。

## 只拷贝 deploy 目录部署

如果只拷贝 `deploy/` 目录，不带完整源码，请使用预构建镜像，并选择 `docker-compose.prod.yml` 或 `docker-compose.worker.yml`：

```env
IMAGE_HANDLE_IMAGE=registry.example.com/image-handle:latest
```

只有 `docker-compose.dev.yml` 依赖源码目录，因为它会使用 `context: ..` 从上级目录构建镜像。

## 注意事项

- 不要提交 `deploy/.env`，它包含密钥。
- PostgreSQL 是异步任务状态、结果和错误的事实库。
- Redis 用于 BullMQ 队列、限速和短期协调。
- 生产环境所有节点必须共享同一套 PostgreSQL 和 Redis。
- R2 配置从 `.env` 读取，默认不会启动本地对象存储。
