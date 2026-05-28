import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { R2Config } from './config.js';

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

export async function uploadPngToR2({
  client,
  config,
  key,
  buffer
}: {
  client: S3Client;
  config: R2Config;
  key: string;
  buffer: Buffer;
}): Promise<string> {
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: buffer,
    ContentType: 'image/png',
    CacheControl: config.cacheControl
  }));

  return `${config.publicUrl}/${key}`;
}
