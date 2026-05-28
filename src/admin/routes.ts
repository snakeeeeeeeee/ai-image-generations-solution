import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adminCookieName, createSessionToken, sessionCookieOptions, verifyPassword, verifySessionToken } from './auth.js';
import type { AdminStore } from './store.js';
import type { AdminConfig, AdminRuntimeStats } from './types.js';

interface AdminRoutesOptions {
  config: AdminConfig;
  store: AdminStore;
  getRuntimeStats: () => AdminRuntimeStats;
}

interface LoginBody {
  password?: string;
}

interface PageQuery {
  page?: string;
  page_size?: string;
}

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
  }, async () => ({
    data: options.store.getErrors()
  }));

  app.get(route('/login'), async (_request, reply) => sendAdminShell(reply, adminDist));
  app.get(basePath, {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (_request, reply) => sendAdminShell(reply, adminDist));
  app.get(route('/*'), {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (_request, reply) => sendAdminShell(reply, adminDist));
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
