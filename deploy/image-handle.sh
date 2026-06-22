#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENVIRONMENT="prod"
ENV_FILE="${SCRIPT_DIR}/.env"
NO_PULL=0
NO_BUILD=0
FORCE_BUILD=0
FORCE_RECREATE=0
SHOW_SECRETS=0
SCALE_ARGS=()

usage() {
  cat <<'EOF'
image-handle 部署管理脚本

用法:
  ./image-handle.sh [--env dev|prod|worker] <命令> [服务...] [选项]

命令:
  build       构建镜像。dev 会 docker compose build；prod/worker 默认提示使用 pull。
  pull        拉取镜像。prod/worker 常用；dev 一般不需要。
  start       启动服务。prod 默认先 pull；dev 默认先 build。
  restart     重建/拉取后强制重启服务。
  stop        停止服务。
  down        停止并移除当前 compose 项目容器。
  ps          查看容器状态。
  logs        查看日志。
  config      输出 compose 解析后的配置。

服务:
  all         当前环境的全部业务服务。dev 包含基础设施和 mock；prod 只包含业务服务。
  full        prod/dev 专用: 基础设施 + 业务服务。prod 主节点自带 PG/Redis 时使用。
  api         image-api
  worker      image-worker
  notifier    image-notifier
  async       image-worker + image-notifier
  infra       dev/prod 专用: image-handle-postgres + image-handle-redis
  mock        dev 专用: mock-new-api

常用:
  # 本地开发，构建并启动全部
  ./image-handle.sh --env dev start all

  # 本地只重建并重启 API
  ./image-handle.sh --env dev restart api

  # 生产启动新老能力: API + Worker + Notifier
  ./image-handle.sh --env prod start all

  # 生产主节点自带 PostgreSQL/Redis，并启动新老能力
  ./image-handle.sh --env prod start full

  # 生产只重启 Worker 和 Notifier
  ./image-handle.sh --env prod restart async

  # 新机器只加入处理节点
  ./image-handle.sh --env worker start all

选项:
  --env <name>       dev、prod 或 worker，默认 prod。
  --env-file <path>  指定 env 文件，默认 deploy/.env。
  --no-pull          start/restart 时跳过 pull。
  --no-build         dev start/restart 时跳过 build。
  --build            prod/worker start/restart 前用本机 Dockerfile 构建 IMAGE_HANDLE_IMAGE。
  --force-recreate   start 时也强制重建容器。
  --scale svc=n      透传 compose scale，例如 --scale image-worker=5。
  --show-secrets     允许 config 命令输出完整配置。默认禁止，避免打印密钥。
  -h, --help         显示帮助。
EOF
}

fail() {
  echo "错误: $*" >&2
  exit 1
}

compose_file() {
  case "${ENVIRONMENT}" in
    dev) echo "${SCRIPT_DIR}/docker-compose.dev.yml" ;;
    prod) echo "${SCRIPT_DIR}/docker-compose.prod.yml" ;;
    worker) echo "${SCRIPT_DIR}/docker-compose.worker.yml" ;;
    *) fail "未知环境 ${ENVIRONMENT}" ;;
  esac
}

compose() {
  local args=(--env-file "${ENV_FILE}" -f "$(compose_file)")
  local gateway_network
  gateway_network="$(env_value IMAGE_HANDLE_GATEWAY_NETWORK)"
  if [[ -n "${gateway_network}" ]]; then
    if [[ "${ENVIRONMENT}" == "worker" ]]; then
      args+=(-f "${SCRIPT_DIR}/docker-compose.gateway.worker.yml")
    else
      args+=(-f "${SCRIPT_DIR}/docker-compose.gateway.yml")
    fi
  fi
  IMAGE_HANDLE_ENV_FILE="${ENV_FILE}" docker compose "${args[@]}" "$@"
}

env_value() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "${value}"
}

image_name() {
  local value
  value="$(env_value IMAGE_HANDLE_IMAGE)"
  if [[ -n "${value}" ]]; then
    printf '%s' "${value}"
    return
  fi
  if [[ "${ENVIRONMENT}" == "dev" ]]; then
    printf '%s' "image-handle:dev"
  else
    printf '%s' "image-handle:latest"
  fi
}

service_names_for_token() {
  local token="$1"
  case "${token}" in
    all)
      case "${ENVIRONMENT}" in
        dev) echo "image-handle-postgres image-handle-redis mock-new-api image-api image-worker image-notifier" ;;
        prod) echo "image-api image-worker image-notifier" ;;
        worker) echo "image-worker image-notifier" ;;
      esac
      ;;
    full)
      case "${ENVIRONMENT}" in
        dev) echo "image-handle-postgres image-handle-redis mock-new-api image-api image-worker image-notifier" ;;
        prod) echo "image-handle-postgres image-handle-redis image-api image-worker image-notifier" ;;
        worker) fail "worker 环境只用于新增处理节点，不应启动基础设施" ;;
      esac
      ;;
    api|image-api) echo "image-api" ;;
    worker|image-worker) echo "image-worker" ;;
    notifier|image-notifier) echo "image-notifier" ;;
    async) echo "image-worker image-notifier" ;;
    infra)
      [[ "${ENVIRONMENT}" == "dev" || "${ENVIRONMENT}" == "prod" ]] || fail "infra 只适用于 dev/prod 环境"
      echo "image-handle-postgres image-handle-redis"
      ;;
    mock|mock-new-api)
      [[ "${ENVIRONMENT}" == "dev" ]] || fail "mock 只适用于 dev 环境"
      echo "mock-new-api"
      ;;
    postgres|image-handle-postgres)
      [[ "${ENVIRONMENT}" == "dev" || "${ENVIRONMENT}" == "prod" ]] || fail "postgres 容器只适用于 dev/prod 环境"
      echo "image-handle-postgres"
      ;;
    redis|image-handle-redis)
      [[ "${ENVIRONMENT}" == "dev" || "${ENVIRONMENT}" == "prod" ]] || fail "redis 容器只适用于 dev/prod 环境"
      echo "image-handle-redis"
      ;;
    *) fail "未知服务 ${token}" ;;
  esac
}

resolve_services() {
  local tokens=("$@")
  if [[ ${#tokens[@]} -eq 0 ]]; then
    tokens=("all")
  fi

  local output=()
  local item service
  for item in "${tokens[@]}"; do
    for service in $(service_names_for_token "${item}"); do
      output+=("${service}")
    done
  done

  printf '%s\n' "${output[@]}" | awk '!seen[$0]++'
}

ensure_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    fail "找不到 env 文件: ${ENV_FILE}。请先复制对应示例，例如 cp ${SCRIPT_DIR}/.env.prod.example ${ENV_FILE}"
  fi
}

maybe_build() {
  local services=("$@")
  [[ "${NO_BUILD}" == "0" ]] || return 0
  if [[ "${ENVIRONMENT}" == "dev" ]]; then
    local build_services=()
    local service
    for service in "${services[@]}"; do
      case "${service}" in
        image-api|image-worker|image-notifier|mock-new-api)
          build_services+=("${service}")
          ;;
      esac
    done
    if [[ ${#build_services[@]} -gt 0 ]]; then
      echo "构建 dev 镜像: ${build_services[*]}"
      compose build "${build_services[@]}"
    fi
  elif [[ "${FORCE_BUILD}" == "1" ]]; then
    local image
    image="$(image_name)"
    echo "使用本机源码构建镜像: ${image}"
    docker build -t "${image}" -f "${PROJECT_ROOT}/Dockerfile" "${PROJECT_ROOT}"
  fi
}

maybe_pull() {
  local services=("$@")
  [[ "${NO_PULL}" == "0" ]] || return 0
  [[ "${FORCE_BUILD}" == "0" ]] || return 0
  if [[ "${ENVIRONMENT}" != "dev" ]]; then
    echo "拉取镜像: ${services[*]}"
    compose pull "${services[@]}"
  fi
}

run_up() {
  local services=("$@")
  local args=(up -d)
  if [[ "${FORCE_RECREATE}" == "1" ]]; then
    args+=(--force-recreate)
  fi
  if [[ ${#SCALE_ARGS[@]} -gt 0 ]]; then
    for scale in "${SCALE_ARGS[@]}"; do
      args+=(--scale "${scale}")
    done
  fi
  args+=("${services[@]}")
  compose "${args[@]}"
}

contains_service() {
  local expected="$1"
  shift
  local service
  for service in "$@"; do
    [[ "${service}" == "${expected}" ]] && return 0
  done
  return 1
}

has_business_service() {
  local service
  for service in "$@"; do
    case "${service}" in
      image-api|image-worker|image-notifier) return 0 ;;
    esac
  done
  return 1
}

wait_for_healthy() {
  local service="$1"
  local timeout_seconds="${2:-120}"
  local started_at
  started_at="$(date +%s)"

  while true; do
    local container_id status now
    container_id="$(compose ps -q "${service}" | head -n 1 || true)"
    if [[ -n "${container_id}" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck:{{.State.Status}}{{end}}' "${container_id}" 2>/dev/null || true)"
      if [[ "${status}" == "healthy" || "${status}" == "no-healthcheck:running" ]]; then
        echo "${service} 已就绪"
        return 0
      fi
    fi

    now="$(date +%s)"
    if (( now - started_at >= timeout_seconds )); then
      fail "${service} 在 ${timeout_seconds}s 内未就绪，请查看日志: ./image-handle.sh --env ${ENVIRONMENT} logs ${service}"
    fi
    sleep 2
  done
}

run_up_ordered() {
  local services=("$@")

  if [[ "${ENVIRONMENT}" == "prod" ]] &&
    contains_service "image-handle-postgres" "${services[@]}" &&
    contains_service "image-handle-redis" "${services[@]}" &&
    has_business_service "${services[@]}"; then
    local business_services=()
    local service
    for service in "${services[@]}"; do
      case "${service}" in
        image-api|image-worker|image-notifier) business_services+=("${service}") ;;
      esac
    done

    echo "先启动生产 PostgreSQL/Redis"
    run_up image-handle-postgres image-handle-redis
    wait_for_healthy image-handle-postgres 120
    wait_for_healthy image-handle-redis 120
    echo "再启动 image-handle 业务服务"
    run_up "${business_services[@]}"
    return
  fi

  run_up "${services[@]}"
}

if [[ $# -eq 0 ]]; then
  usage
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || fail "--env 需要值"
      ENVIRONMENT="$2"
      shift 2
      ;;
    --env=*)
      ENVIRONMENT="${1#*=}"
      shift
      ;;
    --env-file)
      [[ $# -ge 2 ]] || fail "--env-file 需要值"
      ENV_FILE="$2"
      shift 2
      ;;
    --env-file=*)
      ENV_FILE="${1#*=}"
      shift
      ;;
    --no-pull)
      NO_PULL=1
      shift
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --build)
      FORCE_BUILD=1
      shift
      ;;
    --force-recreate)
      FORCE_RECREATE=1
      shift
      ;;
    --show-secrets)
      SHOW_SECRETS=1
      shift
      ;;
    --scale)
      [[ $# -ge 2 ]] || fail "--scale 需要值"
      SCALE_ARGS+=("$2")
      shift 2
      ;;
    --scale=*)
      SCALE_ARGS+=("${1#*=}")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

[[ $# -ge 1 ]] || fail "缺少命令。使用 --help 查看用法"
COMMAND="$1"
shift

SERVICE_TOKENS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pull)
      NO_PULL=1
      shift
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --build)
      FORCE_BUILD=1
      shift
      ;;
    --force-recreate)
      FORCE_RECREATE=1
      shift
      ;;
    --show-secrets)
      SHOW_SECRETS=1
      shift
      ;;
    --scale)
      [[ $# -ge 2 ]] || fail "--scale 需要值"
      SCALE_ARGS+=("$2")
      shift 2
      ;;
    --scale=*)
      SCALE_ARGS+=("${1#*=}")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      fail "未知选项 $1"
      ;;
    *)
      SERVICE_TOKENS+=("$1")
      shift
      ;;
  esac
done

case "${ENVIRONMENT}" in
  dev|prod|worker) ;;
  *) fail "--env 只能是 dev、prod 或 worker" ;;
esac

if [[ "${ENV_FILE}" != /* ]]; then
  ENV_FILE="$(cd "$(dirname "${ENV_FILE}")" && pwd)/$(basename "${ENV_FILE}")"
fi

ensure_env_file
cd "${PROJECT_ROOT}"

SERVICES=()
if [[ ${#SERVICE_TOKENS[@]} -eq 0 ]]; then
  while IFS= read -r service; do
    SERVICES+=("${service}")
  done < <(resolve_services)
else
  while IFS= read -r service; do
    SERVICES+=("${service}")
  done < <(resolve_services "${SERVICE_TOKENS[@]}")
fi

case "${COMMAND}" in
  build)
    FORCE_BUILD=1
    maybe_build "${SERVICES[@]}"
    ;;
  pull)
    compose pull "${SERVICES[@]}"
    ;;
  start)
    maybe_pull "${SERVICES[@]}"
    maybe_build "${SERVICES[@]}"
    run_up_ordered "${SERVICES[@]}"
    ;;
  restart)
    maybe_pull "${SERVICES[@]}"
    maybe_build "${SERVICES[@]}"
    FORCE_RECREATE=1
    run_up_ordered "${SERVICES[@]}"
    ;;
  stop)
    compose stop "${SERVICES[@]}"
    ;;
  down)
    compose down
    ;;
  ps)
    compose ps "${SERVICES[@]}"
    ;;
  logs)
    compose logs -f --tail=200 "${SERVICES[@]}"
    ;;
  config)
    if [[ "${SHOW_SECRETS}" != "1" ]]; then
      fail "config 会输出完整环境变量，可能包含 R2/回调密钥。如确认需要，请追加 --show-secrets"
    fi
    compose config
    ;;
  *)
    fail "未知命令 ${COMMAND}。使用 --help 查看用法"
    ;;
esac
