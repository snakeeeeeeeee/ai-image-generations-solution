import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyImageDefaults, assertPng, buildImageKey, decodeBase64Image, readImageMetadata, readPngMetadata } from '../src/image.js';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const tinyJpegBuffer = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x02, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xd9
]);
const tinyWebpBuffer = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00,
  0x02, 0x00, 0x00
]);

test('applyImageDefaults forces PNG output and default size', () => {
  const body = applyImageDefaults({
    model: 'gpt-image-2-count',
    prompt: 'test',
    output_format: 'webp'
  }, {
    size: '2560x1440',
    outputFormat: 'png'
  });

  assert.equal(body.size, '2560x1440');
  assert.equal(body.output_format, 'png');
});

test('decodeBase64Image decodes valid data URL base64', () => {
  const buffer = decodeBase64Image(`data:image/png;base64,${tinyPngBase64}`);
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('readPngMetadata reads PNG dimensions', () => {
  const buffer = decodeBase64Image(tinyPngBase64);
  assert.deepEqual(readPngMetadata(buffer), {
    format: 'png',
    width: 1,
    height: 1
  });
});

test('readImageMetadata reads JPEG dimensions and content type', () => {
  assert.deepEqual(readImageMetadata(tinyJpegBuffer), {
    format: 'jpeg',
    extension: 'jpg',
    mimeType: 'image/jpeg',
    width: 2,
    height: 1,
    bytes: tinyJpegBuffer.length
  });
});

test('readImageMetadata reads WebP dimensions and content type', () => {
  assert.deepEqual(readImageMetadata(tinyWebpBuffer), {
    format: 'webp',
    extension: 'webp',
    mimeType: 'image/webp',
    width: 2,
    height: 3,
    bytes: tinyWebpBuffer.length
  });
});

test('decodeBase64Image rejects invalid base64', () => {
  assert.throws(() => decodeBase64Image('not base64!!!'), /Invalid image base64/);
});

test('assertPng rejects non-PNG buffers', () => {
  assert.throws(() => assertPng(Buffer.from('hello')), /empty|PNG/);
});

test('buildImageKey uses images date prefix and png extension', () => {
  const key = buildImageKey('images', new Date('2026-05-29T12:00:00Z'), 'abc');
  assert.equal(key, 'images/2026/05/29/abc.png');
});

test('buildImageKey can use a non-PNG extension', () => {
  const key = buildImageKey('images', new Date('2026-05-29T12:00:00Z'), 'abc', 'jpg');
  assert.equal(key, 'images/2026/05/29/abc.jpg');
});
