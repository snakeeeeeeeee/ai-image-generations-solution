import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../config.js';
import { AppError, sendAppError } from '../errors.js';
import { buildImageKey, decodeBase64Image, readImageMetadata, type ImageMetadata } from '../image.js';
import { uploadImageToR2 } from '../r2.js';
import { uploadWithRetry } from '../upload-retry.js';
import { authorizeProviderKey } from './request.js';

type UploadImageToR2 = typeof uploadImageToR2;

interface UploadRoutesOptions {
  config: AppConfig;
  r2Client?: S3Client;
  upload?: UploadImageToR2;
}

interface UploadInput {
  field: string;
  filename?: string;
  buffer: Buffer;
}

interface UploadRecord {
  id: string;
  field: string;
  filename?: string;
  key: string;
  url: string;
  mime_type: string;
  bytes: number;
  width: number;
  height: number;
  format: ImageMetadata['format'];
  temporary: true;
}

export function registerImageUploadRoutes(app: FastifyInstance, options: UploadRoutesOptions): void {
  app.post('/v1/image/uploads', async (request, reply) => {
    try {
      authorizeProviderKey(request.headers.authorization, options.config.asyncTasks.providerApiKeys);
      assertUploadEnabled(options);
      const inputs = await readMultipartUploads(request, options.config.bodyLimitBytes);
      const uploads = await uploadInputs({ inputs, request, options });
      return reply.send(formatUploadResponse(uploads));
    } catch (error) {
      return sendAppError(reply, normalizeUploadError(error));
    }
  });

  app.post('/v1/image/uploads/base64', async (request, reply) => {
    try {
      authorizeProviderKey(request.headers.authorization, options.config.asyncTasks.providerApiKeys);
      assertUploadEnabled(options);
      const inputs = readBase64Uploads(request.body);
      const uploads = await uploadInputs({ inputs, request, options });
      return reply.send(formatUploadResponse(uploads));
    } catch (error) {
      return sendAppError(reply, normalizeUploadError(error));
    }
  });
}

function assertUploadEnabled(options: UploadRoutesOptions): asserts options is UploadRoutesOptions & { r2Client: S3Client } {
  if (!options.r2Client) {
    throw new AppError('Image upload storage is not configured', {
      statusCode: 501,
      type: 'server_error',
      code: 'image_upload_unavailable'
    });
  }
}

async function readMultipartUploads(request: FastifyRequest, maxUploadBytes: number): Promise<UploadInput[]> {
  if (!request.isMultipart()) {
    throw new AppError('Request body must be multipart/form-data', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_upload_body'
    });
  }

  const uploads: UploadInput[] = [];
  for await (const part of request.parts()) {
    if (part.type !== 'file') {
      continue;
    }
    const buffer = await part.toBuffer();
    assertUploadBuffer(buffer);
    if (buffer.length > maxUploadBytes) {
      throw new AppError('Uploaded image exceeds size limit', {
        statusCode: 413,
        type: 'invalid_request_error',
        code: 'upload_file_too_large'
      });
    }
    uploads.push({
      field: normalizeField(part.fieldname),
      filename: part.filename || undefined,
      buffer
    });
  }

  if (uploads.length === 0) {
    throw new AppError('At least one image file is required', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'missing_upload_file'
    });
  }
  return uploads;
}

function readBase64Uploads(body: unknown): UploadInput[] {
  const payload = safeObject(body);
  const uploads: UploadInput[] = [];
  const explicit = Array.isArray(payload.uploads) ? payload.uploads : undefined;

  if (explicit) {
    explicit.forEach((item, index) => {
      uploads.push(readBase64UploadItem(item, `upload-${index + 1}`, 'image'));
    });
  } else {
    if (Array.isArray(payload.images)) {
      payload.images.forEach((item, index) => {
        uploads.push(readBase64UploadItem(item, `image-${index + 1}`, 'image'));
      });
    }
    if (payload.mask !== undefined && payload.mask !== null) {
      uploads.push(readBase64UploadItem(payload.mask, 'mask', 'mask'));
    }
  }

  if (uploads.length === 0) {
    throw new AppError('uploads, images, or mask is required', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'missing_base64_uploads'
    });
  }
  return uploads;
}

function readBase64UploadItem(value: unknown, fallbackFilename: string, fallbackField: string): UploadInput {
  if (typeof value === 'string') {
    return {
      field: fallbackField,
      filename: `${fallbackFilename}.png`,
      buffer: decodeUploadBase64(value)
    };
  }

  const item = safeObject(value);
  const b64 = getString(item.b64_json) ?? getString(item.base64) ?? getString(item.data);
  if (!b64) {
    throw new AppError('Upload item must include b64_json, base64, or data', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'missing_upload_base64'
    });
  }

  return {
    field: normalizeField(getString(item.field) ?? fallbackField),
    filename: getString(item.filename) ?? `${fallbackFilename}.png`,
    buffer: decodeUploadBase64(b64)
  };
}

function decodeUploadBase64(value: string): Buffer {
  try {
    const buffer = decodeBase64Image(value);
    assertUploadBuffer(buffer);
    return buffer;
  } catch (error) {
    throw new AppError('Uploaded image base64 is invalid', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_upload_base64',
      cause: error
    });
  }
}

async function uploadInputs({
  inputs,
  request,
  options
}: {
  inputs: UploadInput[];
  request: FastifyRequest;
  options: UploadRoutesOptions & { r2Client: S3Client };
}): Promise<UploadRecord[]> {
  const upload = options.upload ?? uploadImageToR2;
  const records: UploadRecord[] = [];
  for (const input of inputs) {
    const metadata = readUploadImageMetadata(input.buffer);
    const id = `upload_${randomUUID()}`;
    const key = buildImageKey(uploadPrefix(options.config), new Date(), id, metadata.extension);
    const url = await uploadWithRetry({
      upload,
      request,
      r2Client: options.r2Client,
      config: options.config,
      key,
      buffer: input.buffer,
      contentType: metadata.mimeType
    });
    records.push({
      id,
      field: input.field,
      filename: input.filename,
      key,
      url,
      mime_type: metadata.mimeType,
      bytes: metadata.bytes,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      temporary: true
    });
  }
  return records;
}

function readUploadImageMetadata(buffer: Buffer): ImageMetadata {
  try {
    return readImageMetadata(buffer);
  } catch (error) {
    throw new AppError('Uploaded image format is unsupported or invalid', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_upload_image',
      cause: error
    });
  }
}

function assertUploadBuffer(buffer: Buffer): void {
  if (buffer.length === 0) {
    throw new AppError('Uploaded image file is empty', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'empty_upload_file'
    });
  }
}

function formatUploadResponse(uploads: UploadRecord[]): Record<string, unknown> {
  const byField: Record<string, string[]> = {};
  for (const upload of uploads) {
    byField[upload.field] = [...(byField[upload.field] ?? []), upload.url];
  }
  const mask = byField.mask?.[0] ?? null;
  const images = uploads
    .filter((upload) => upload.field !== 'mask')
    .map((upload) => upload.url);

  return {
    uploads,
    images,
    mask,
    by_field: byField
  };
}

function uploadPrefix(config: AppConfig): string {
  return [config.r2.keyPrefix, 'tmp', 'uploads'].filter(Boolean).join('/');
}

function normalizeField(value: string): string {
  const field = value.trim();
  return field === '' ? 'image' : field;
}

function normalizeUploadError(error: unknown): unknown {
  if (isMultipartFileTooLargeError(error)) {
    return new AppError('Uploaded image exceeds size limit', {
      statusCode: 413,
      type: 'invalid_request_error',
      code: 'upload_file_too_large'
    });
  }
  return error;
}

function isMultipartFileTooLargeError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'FST_REQ_FILE_TOO_LARGE';
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
