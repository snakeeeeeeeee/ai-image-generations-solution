import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyImageDefaults, assertPng, buildImageKey, decodeBase64Image, readPngMetadata } from '../src/image.js';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

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
