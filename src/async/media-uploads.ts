import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { AppConfig } from "../config.js";
import { AppError, sendAppError } from "../errors.js";
import { authorizeProviderKey } from "./request.js";

const MAX_FILES = 12;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const PRESIGN_TTL_SECONDS = 15 * 60;
const PENDING_SESSION_TTL_SECONDS = 30 * 60;
const COMPLETED_SESSION_TTL_SECONDS = 24 * 60 * 60;

type MediaKind = "image" | "video" | "audio";

const MIME_RULES: Record<
  string,
  { kind: MediaKind; extension: string; maxBytes: number }
> = {
  "image/jpeg": { kind: "image", extension: "jpg", maxBytes: 20 * 1024 * 1024 },
  "image/png": { kind: "image", extension: "png", maxBytes: 20 * 1024 * 1024 },
  "image/webp": {
    kind: "image",
    extension: "webp",
    maxBytes: 20 * 1024 * 1024,
  },
  "video/mp4": { kind: "video", extension: "mp4", maxBytes: 64 * 1024 * 1024 },
  "video/quicktime": {
    kind: "video",
    extension: "mov",
    maxBytes: 64 * 1024 * 1024,
  },
  "audio/mpeg": { kind: "audio", extension: "mp3", maxBytes: 32 * 1024 * 1024 },
  "audio/wav": { kind: "audio", extension: "wav", maxBytes: 32 * 1024 * 1024 },
  "audio/x-wav": {
    kind: "audio",
    extension: "wav",
    maxBytes: 32 * 1024 * 1024,
  },
  "audio/mp4": { kind: "audio", extension: "m4a", maxBytes: 32 * 1024 * 1024 },
  "audio/x-m4a": {
    kind: "audio",
    extension: "m4a",
    maxBytes: 32 * 1024 * 1024,
  },
  "audio/aac": { kind: "audio", extension: "aac", maxBytes: 32 * 1024 * 1024 },
};

interface MediaUploadFileRequest {
  clientId?: string;
  kind: MediaKind;
  filename?: string;
  mimeType: string;
  sizeBytes: number;
}

interface MediaUploadSession {
  id: string;
  ownerId: string;
  clientId?: string;
  kind: MediaKind;
  key: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  status: "pending" | "completed";
  url?: string;
}

export interface MediaUploadSessionStore {
  get(id: string): Promise<MediaUploadSession | undefined>;
  set(session: MediaUploadSession, ttlSeconds: number): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface MediaUploadObjectStore {
  presignPut(key: string, mimeType: string, expiresIn: number): Promise<string>;
  head(key: string): Promise<{ sizeBytes: number; mimeType: string }>;
  delete(key: string): Promise<void>;
}

interface MediaUploadRoutesOptions {
  config: AppConfig;
  sessions: MediaUploadSessionStore;
  objects: MediaUploadObjectStore;
}

export class RedisMediaUploadSessionStore implements MediaUploadSessionStore {
  constructor(private readonly redis: Redis) {}

  async get(id: string): Promise<MediaUploadSession | undefined> {
    const value = await this.redis.get(sessionKey(id));
    if (!value) {
      return undefined;
    }
    try {
      return JSON.parse(value) as MediaUploadSession;
    } catch {
      await this.redis.del(sessionKey(id));
      return undefined;
    }
  }

  async set(session: MediaUploadSession, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      sessionKey(session.id),
      JSON.stringify(session),
      "EX",
      ttlSeconds,
    );
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(sessionKey(id));
  }
}

export class S3MediaUploadObjectStore implements MediaUploadObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly config: AppConfig,
  ) {}

  async presignPut(
    key: string,
    mimeType: string,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.r2.bucket,
        Key: key,
        ContentType: mimeType,
        CacheControl: this.config.r2.cacheControl,
      }),
      { expiresIn },
    );
  }

  async head(key: string): Promise<{ sizeBytes: number; mimeType: string }> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.r2.bucket, Key: key }),
    );
    return {
      sizeBytes: Number(result.ContentLength ?? -1),
      mimeType: normalizeMimeType(result.ContentType),
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.r2.bucket, Key: key }),
    );
  }
}

export function registerMediaUploadRoutes(
  app: FastifyInstance,
  options: MediaUploadRoutesOptions,
): void {
  app.post("/internal/v1/media/uploads", async (request, reply) => {
    try {
      authorizeProviderKey(
        request.headers.authorization,
        options.config.asyncTasks.providerApiKeys,
      );
      const body = requireObject(request.body);
      const ownerId = requireShortString(body.owner_id, "owner_id", 191);
      const files = parseFiles(body.files);
      const now = Math.floor(Date.now() / 1000);
      const data = [];
      for (const file of files) {
        const id = `upload_${randomUUID()}`;
        const rule = MIME_RULES[file.mimeType];
        const key = mediaObjectKey(options.config, now, id, rule.extension);
        const session: MediaUploadSession = {
          id,
          ownerId,
          clientId: file.clientId,
          kind: file.kind,
          key,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          createdAt: now,
          status: "pending",
        };
        await options.sessions.set(session, PENDING_SESSION_TTL_SECONDS);
        try {
          const uploadUrl = await options.objects.presignPut(
            key,
            file.mimeType,
            PRESIGN_TTL_SECONDS,
          );
          data.push({
            id,
            client_id: file.clientId,
            kind: file.kind,
            method: "PUT",
            upload_url: uploadUrl,
            headers: { "Content-Type": file.mimeType },
            expires_at: now + PRESIGN_TTL_SECONDS,
          });
        } catch (error) {
          await options.sessions.delete(id);
          throw error;
        }
      }
      return reply.send({ object: "media.upload.session.list", data });
    } catch (error) {
      return sendAppError(reply, normalizeMediaUploadError(error));
    }
  });

  app.post("/internal/v1/media/uploads/complete", async (request, reply) => {
    try {
      authorizeProviderKey(
        request.headers.authorization,
        options.config.asyncTasks.providerApiKeys,
      );
      const body = requireObject(request.body);
      const ownerId = requireShortString(body.owner_id, "owner_id", 191);
      const uploadIds = parseUploadIds(body.upload_ids);
      const data = [];
      for (const id of uploadIds) {
        const session = await options.sessions.get(id);
        if (!session || session.ownerId !== ownerId) {
          throw new AppError("Media upload session was not found", {
            statusCode: 404,
            type: "invalid_request_error",
            code: "media_upload_not_found",
          });
        }
        if (session.status === "completed" && session.url) {
          data.push(publicCompletedUpload(session));
          continue;
        }
        let head: { sizeBytes: number; mimeType: string };
        try {
          head = await options.objects.head(session.key);
        } catch (error) {
          throw new AppError("Media object is not available yet", {
            statusCode: 409,
            type: "invalid_request_error",
            code: "media_upload_incomplete",
            cause: error,
          });
        }
        if (
          head.sizeBytes !== session.sizeBytes ||
          head.mimeType !== session.mimeType
        ) {
          await options.objects.delete(session.key).catch(() => undefined);
          await options.sessions.delete(session.id);
          throw new AppError(
            "Uploaded media size or MIME type does not match the session",
            {
              statusCode: 400,
              type: "invalid_request_error",
              code: "media_upload_verification_failed",
            },
          );
        }
        session.status = "completed";
        session.url = publicObjectURL(options.config, session.key);
        await options.sessions.set(session, COMPLETED_SESSION_TTL_SECONDS);
        data.push(publicCompletedUpload(session));
      }
      return reply.send({ object: "media.upload.list", data });
    } catch (error) {
      return sendAppError(reply, normalizeMediaUploadError(error));
    }
  });
}

function parseFiles(value: unknown): MediaUploadFileRequest[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) {
    throw invalidRequest(
      `files must contain between 1 and ${MAX_FILES} items`,
      "invalid_media_files",
    );
  }
  const counts: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
  let totalBytes = 0;
  const files = value.map((item, index) => {
    const input = requireObject(item);
    const kind = requireMediaKind(input.kind, index);
    const mimeType = normalizeMimeType(input.mime_type);
    const rule = MIME_RULES[mimeType];
    if (!rule || rule.kind !== kind) {
      throw invalidRequest(
        `files[${index}].mime_type is not supported for ${kind}`,
        "invalid_media_mime",
      );
    }
    const sizeBytes = requirePositiveInteger(
      input.size_bytes,
      `files[${index}].size_bytes`,
    );
    if (sizeBytes > rule.maxBytes) {
      throw new AppError(`files[${index}] exceeds the ${kind} size limit`, {
        statusCode: 413,
        type: "invalid_request_error",
        code: "media_upload_too_large",
      });
    }
    counts[kind] += 1;
    totalBytes += sizeBytes;
    return {
      clientId: optionalShortString(
        input.client_id,
        `files[${index}].client_id`,
        100,
      ),
      kind,
      filename: optionalShortString(
        input.filename,
        `files[${index}].filename`,
        255,
      ),
      mimeType,
      sizeBytes,
    };
  });
  if (counts.image > 9 || counts.video > 3 || counts.audio > 3) {
    throw invalidRequest(
      "files exceed the 9 image, 3 video, or 3 audio limits",
      "media_count_exceeded",
    );
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new AppError("Declared media upload size exceeds 128 MiB", {
      statusCode: 413,
      type: "invalid_request_error",
      code: "media_upload_too_large",
    });
  }
  return files;
}

function parseUploadIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) {
    throw invalidRequest(
      `upload_ids must contain between 1 and ${MAX_FILES} items`,
      "invalid_upload_ids",
    );
  }
  const ids = value.map((item, index) =>
    requireShortString(item, `upload_ids[${index}]`, 100),
  );
  if (new Set(ids).size !== ids.length) {
    throw invalidRequest("upload_ids must be unique", "invalid_upload_ids");
  }
  return ids;
}

function requireMediaKind(value: unknown, index: number): MediaKind {
  if (value === "image" || value === "video" || value === "audio") {
    return value;
  }
  throw invalidRequest(
    `files[${index}].kind must be image, video, or audio`,
    "invalid_media_kind",
  );
}

function publicCompletedUpload(
  session: MediaUploadSession,
): Record<string, unknown> {
  return {
    id: session.id,
    client_id: session.clientId,
    kind: session.kind,
    url: session.url,
    mime_type: session.mimeType,
    size_bytes: session.sizeBytes,
    temporary: true,
    expires_at: session.createdAt + COMPLETED_SESSION_TTL_SECONDS,
  };
}

function mediaObjectKey(
  config: AppConfig,
  epochSeconds: number,
  id: string,
  extension: string,
): string {
  const date = new Date(epochSeconds * 1000);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return [
    config.r2.keyPrefix,
    "media",
    "tmp",
    "uploads",
    year,
    month,
    day,
    `${id}.${extension}`,
  ]
    .filter(Boolean)
    .join("/");
}

function publicObjectURL(config: AppConfig, key: string): string {
  return `${config.r2.publicUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function sessionKey(id: string): string {
  return `media-upload:${id}`;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(
      "Request body must be a JSON object",
      "invalid_request_body",
    );
  }
  return value as Record<string, unknown>;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw invalidRequest(
      `${field} must be a positive integer`,
      "invalid_media_size",
    );
  }
  return Number(value);
}

function requireShortString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.trim().length > maxLength
  ) {
    throw invalidRequest(
      `${field} must be a non-empty string no longer than ${maxLength}`,
      "invalid_request_body",
    );
  }
  return value.trim();
}

function optionalShortString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requireShortString(value, field, maxLength);
}

function normalizeMimeType(value: unknown): string {
  return typeof value === "string"
    ? value.split(";", 1)[0]!.trim().toLowerCase()
    : "";
}

function invalidRequest(message: string, code: string): AppError {
  return new AppError(message, {
    statusCode: 400,
    type: "invalid_request_error",
    code,
  });
}

function normalizeMediaUploadError(error: unknown): unknown {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError("Media upload service is temporarily unavailable", {
    statusCode: 503,
    type: "server_error",
    code: "media_upload_unavailable",
    cause: error,
  });
}
