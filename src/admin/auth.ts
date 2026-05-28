import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AdminConfig } from './types.js';

const COOKIE_NAME = 'image_handle_admin';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export function adminCookieName(): string {
  return COOKIE_NAME;
}

export function createSessionToken(config: AdminConfig, now = Date.now()): string {
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
  const nonce = randomBytes(16).toString('hex');
  const payload = `${expiresAt}.${nonce}`;
  const signature = sign(payload, config.sessionSecret);
  return `${payload}.${signature}`;
}

export function verifySessionToken(config: AdminConfig, token?: string): boolean {
  if (!token) {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }

  const [expiresAtRaw, nonce, signature] = parts;
  const expiresAt = Number.parseInt(expiresAtRaw ?? '', 10);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !nonce || !signature) {
    return false;
  }

  const payload = `${expiresAt}.${nonce}`;
  return safeEqual(signature, sign(payload, config.sessionSecret));
}

export function verifyPassword(config: AdminConfig, password: unknown): boolean {
  if (!config.password || typeof password !== 'string') {
    return false;
  }
  return safeEqual(password, config.password);
}

export function sessionCookieOptions(config: AdminConfig): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/admin',
    maxAge: SESSION_MAX_AGE_SECONDS
  };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
