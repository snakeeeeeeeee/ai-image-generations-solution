import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { R2Config } from './config.js';

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

export async function uploadImageToR2({
  client,
  config,
  key,
  buffer,
  contentType
}: {
  client: S3Client;
  config: R2Config;
  key: string;
  buffer: Buffer;
  contentType: string;
}): Promise<string> {
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: config.cacheControl
  }));

  return `${config.publicUrl}/${key}`;
}

export async function uploadPngToR2(args: {
  client: S3Client;
  config: R2Config;
  key: string;
  buffer: Buffer;
}): Promise<string> {
  return uploadImageToR2({
    ...args,
    contentType: 'image/png'
  });
}
