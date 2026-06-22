import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adminCookieName, createSessionToken, sessionCookieOptions, verifyPassword, verifySessionToken } from './auth.js';
import type { AdminStore } from './store.js';
import type { AdminConfig, AdminRuntimeStats } from './types.js';
import { AppError, sendAppError } from '../errors.js';
import type { AsyncTaskStore } from '../async/store.js';
import type { Queue } from 'bullmq';
import type { TaskQueuePayload } from '../async/types.js';

interface AdminRoutesOptions {
  config: AdminConfig;
  store: AdminStore;
  getRuntimeStats: () => AdminRuntimeStats;
  maxUploadBytes: number;
  uploadImage?: AdminUploadHandler;
  asyncTaskStore?: AsyncTaskStore;
  taskQueue?: Queue<TaskQueuePayload>;
}

interface LoginBody {
  password?: string;
}

interface PageQuery {
  page?: string;
  page_size?: string;
}

interface DrainBody {
  draining?: boolean;
  reason?: string;
}

export interface AdminUploadFile {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}

export interface AdminUploadResult {
  url: string;
  key: string;
  filename: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  uploadedAt: string;
}

export type AdminUploadHandler = (file: AdminUploadFile, request: FastifyRequest) => Promise<AdminUploadResult>;

export function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): void {
  app.register(cookie);

  const basePath = options.config.basePath;
  const route = (path = '') => `${basePath}${path}`;
  const adminDist = resolve('dist/admin-ui');
  const adminAssetsDist = join(adminDist, 'assets');
  if (existsSync(adminAssetsDist)) {
    app.register(fastifyStatic, {
      root: adminAssetsDist,
      prefix: route('/assets/'),
      decorateReply: false
    });
  }

  app.post(route('/login'), async (request: FastifyRequest<{ Body: LoginBody }>, reply) => {
    if (!verifyPassword(options.config, request.body?.password)) {
      return reply.status(401).send({
        error: {
          message: '密码不正确',
          code: 'invalid_admin_password'
        }
      });
    }

    reply.setCookie(
      adminCookieName(),
      createSessionToken(options.config),
      sessionCookieOptions(options.config)
    );

    return reply.send({ ok: true });
  });

  app.post(route('/logout'), async (_request, reply) => {
    reply.clearCookie(adminCookieName(), {
      path: basePath
    });
    return reply.send({ ok: true });
  });

  app.get(route('/api/summary'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async () => ({
    runtime: options.getRuntimeStats(),
    summary: options.store.getSummary()
  }));

  app.get(route('/api/drain'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async () => ({
    data: options.store.getDrainState()
  }));

  app.post(route('/api/drain'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (request: FastifyRequest<{ Body: DrainBody }>) => {
    const state = options.store.setDrainState({
      draining: request.body?.draining === true,
      reason: typeof request.body?.reason === 'string' ? request.body.reason.slice(0, 200) : undefined
    });

    return {
      data: state
    };
  });

  app.post(route('/api/upload'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (request, reply) => {
    if (!options.uploadImage) {
      return reply.status(501).send({
        error: {
          message: '后台上传未启用',
          code: 'admin_upload_disabled'
        }
      });
    }

    try {
      if (!request.isMultipart()) {
        throw new AppError('Request body must be multipart/form-data', {
          statusCode: 400,
          type: 'invalid_request_error',
          code: 'invalid_upload_body'
        });
      }

      const part = await request.file({
        limits: {
          files: 1,
          fileSize: options.maxUploadBytes
        }
      });
      if (!part) {
        throw new AppError('请选择要上传的图片文件', {
          statusCode: 400,
          type: 'invalid_request_error',
          code: 'missing_upload_file'
        });
      }

      const result = await options.uploadImage({
        buffer: await part.toBuffer(),
        filename: part.filename || 'image',
        mimetype: part.mimetype || 'application/octet-stream'
      }, request);

      return reply.send({ data: result });
    } catch (error) {
      if (isMultipartFileTooLargeError(error)) {
        return sendAppError(reply, new AppError('Uploaded image exceeds size limit', {
          statusCode: 413,
          type: 'invalid_request_error',
          code: 'upload_file_too_large'
        }));
      }

      return sendAppError(reply, error);
    }
  });

  app.get(route('/api/requests'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (request: FastifyRequest<{ Querystring: PageQuery }>) => {
    const page = parseBoundedInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parseBoundedInt(request.query.page_size, 20, 1, 100);
    return options.store.getRequestsPage(page, pageSize);
  });

  app.get(route('/api/images'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (request: FastifyRequest<{ Querystring: PageQuery }>) => {
    const page = parseBoundedInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parseBoundedInt(request.query.page_size, 10, 1, 100);
    return options.store.getImagesPage(page, pageSize);
  });

  app.get(route('/api/errors'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (request: FastifyRequest<{ Querystring: PageQuery }>) => {
    const page = parseBoundedInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parseBoundedInt(request.query.page_size, 5, 1, 100);
    return options.store.getErrorsPage(page, pageSize, 24);
  });

  app.get(route('/api/async/summary'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (_request, reply) => {
    if (!options.asyncTaskStore) {
      return reply.send({
        enabled: false,
        tasks: emptyTaskSummary(),
        callbacks: emptyCallbackSummary(),
        queue: null
      });
    }

    const [tasks, callbacks, queue] = await Promise.all([
      options.asyncTaskStore.getAdminTaskSummary(),
      options.asyncTaskStore.getAdminCallbackSummary(),
      getQueueStats(options.taskQueue)
    ]);

    return {
      enabled: true,
      tasks,
      callbacks,
      queue
    };
  });

  app.get<{ Querystring: PageQuery }>(route('/api/async/tasks'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (request, reply) => {
    if (!options.asyncTaskStore) {
      return reply.send(emptyPage(parseBoundedInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER), parseBoundedInt(request.query.page_size, 20, 1, 100)));
    }

    const page = parseBoundedInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parseBoundedInt(request.query.page_size, 20, 1, 100);
    return options.asyncTaskStore.getAdminTasksPage(page, pageSize);
  });

  app.get<{ Querystring: PageQuery }>(route('/api/async/callbacks'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (request, reply) => {
    if (!options.asyncTaskStore) {
      return reply.send(emptyPage(parseBoundedInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER), parseBoundedInt(request.query.page_size, 20, 1, 100)));
    }

    const page = parseBoundedInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parseBoundedInt(request.query.page_size, 20, 1, 100);
    return options.asyncTaskStore.getAdminCallbackEventsPage(page, pageSize);
  });

  app.get(route('/login'), async (_request, reply) => sendAdminShell(reply, adminDist));
  app.get(basePath, {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (_request, reply) => sendAdminShell(reply, adminDist));
  app.get(route('/*'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (_request, reply) => sendAdminShell(reply, adminDist));
}

async function getQueueStats(queue: Queue<TaskQueuePayload> | undefined): Promise<Record<string, number> | null> {
  if (!queue) {
    return null;
  }
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    paused: counts.paused ?? 0
  };
}

function emptyTaskSummary() {
  return {
    total: 0,
    submitted: 0,
    queued: 0,
    processing: 0,
    succeeded: 0,
    failed: 0
  };
}

function emptyCallbackSummary() {
  return {
    total: 0,
    pending: 0,
    processing: 0,
    delivered: 0,
    failed: 0
  };
}

function emptyPage(page: number, pageSize: number) {
  return {
    data: [],
    page,
    pageSize,
    total: 0,
    totalPages: 1
  };
}

function isMultipartFileTooLargeError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE'
  );
}

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

async function requireAdmin(config: AdminConfig, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (verifySessionToken(config, request.cookies?.[adminCookieName()])) {
    return;
  }

  if (request.url.startsWith(`${config.basePath}/api/`)) {
    await reply.status(401).send({
      error: {
        message: '需要登录',
        code: 'admin_auth_required'
      }
    });
    return;
  }

  await reply.redirect(`${config.basePath}/login`);
}

function sendAdminShell(reply: FastifyReply, adminDist: string): FastifyReply {
  const indexPath = join(adminDist, 'index.html');
  if (!existsSync(indexPath)) {
    return reply.type('text/html; charset=utf-8').send(`
      <!doctype html>
      <html lang="zh-CN">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>图片加速层监控台</title>
          <style>
            body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
            main { max-width: 720px; margin: 12vh auto; padding: 32px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; }
            code { background: #f1f5f9; padding: 2px 6px; border-radius: 6px; }
          </style>
        </head>
        <body>
          <main>
            <h1>管理台尚未构建</h1>
            <p>请先运行 <code>npm run build:admin</code>，再重启服务。</p>
          </main>
        </body>
      </html>
    `);
  }

  return reply.type('text/html; charset=utf-8').send(readFileSync(indexPath, 'utf8'));
}
