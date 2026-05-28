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

export function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): void {
  app.register(cookie);

  const adminDist = resolve('dist/admin-ui');
  const adminAssetsDist = join(adminDist, 'assets');
  if (existsSync(adminAssetsDist)) {
    app.register(fastifyStatic, {
      root: adminAssetsDist,
      prefix: '/admin/assets/',
      decorateReply: false
    });
  }

  app.post('/admin/login', async (request: FastifyRequest<{ Body: LoginBody }>, reply) => {
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

  app.post('/admin/logout', async (_request, reply) => {
    reply.clearCookie(adminCookieName(), {
      path: '/admin'
    });
    return reply.send({ ok: true });
  });

  app.get('/admin/api/summary', {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async () => ({
    runtime: options.getRuntimeStats(),
    summary: options.store.getSummary()
  }));

  app.get('/admin/api/requests', {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async () => ({
    data: options.store.getRecentRequests(options.config.recentLimit)
  }));

  app.get('/admin/api/errors', {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async () => ({
    data: options.store.getErrors()
  }));

  app.get('/admin/login', async (_request, reply) => sendAdminShell(reply, adminDist));
  app.get('/admin', {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (_request, reply) => sendAdminShell(reply, adminDist));
  app.get('/admin/*', {
    preHandler: async (request, reply) => requireAdmin(options.config, request, reply)
  }, async (_request, reply) => sendAdminShell(reply, adminDist));
}

async function requireAdmin(config: AdminConfig, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (verifySessionToken(config, request.cookies?.[adminCookieName()])) {
    return;
  }

  if (request.url.startsWith('/admin/api/')) {
    await reply.status(401).send({
      error: {
        message: '需要登录',
        code: 'admin_auth_required'
      }
    });
    return;
  }

  await reply.redirect('/admin/login');
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
