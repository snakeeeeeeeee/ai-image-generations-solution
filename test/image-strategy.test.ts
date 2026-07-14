import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors.js';
import {
  genericOpenAICompatibleStrategy,
  isGptImageModel,
  isXaiGrokImagineModel,
  pickImageStrategy,
  normalizeUpstreamImageUrl
} from '../src/image-strategy.js';

test('xAI image strategy only matches supported Grok Imagine image models', () => {
  assert.equal(isXaiGrokImagineModel('grok-imagine-image-quality'), true);
  assert.equal(isXaiGrokImagineModel('grok-imagine-image'), true);
  assert.equal(isXaiGrokImagineModel('grok-3'), false);
  assert.equal(isXaiGrokImagineModel('grok-4'), false);
  assert.equal(isXaiGrokImagineModel('grok-imagine-image-pro'), false);
});

test('GPT image strategy matches gpt-image model family', () => {
  assert.equal(isGptImageModel('gpt-image-2'), true);
  assert.equal(isGptImageModel('gpt-image-2-count'), true);
  assert.equal(isGptImageModel('gpt-4.1'), false);
});

test('pickImageStrategy uses xAI, GPT image, then generic order', () => {
  assert.equal(pickImageStrategy({ model: 'grok-imagine-image-quality' }).name, 'xai-grok-imagine');
  assert.equal(pickImageStrategy({ model: 'gpt-image-2-count' }).name, 'gpt-image');
  assert.equal(pickImageStrategy({ model: 'other-image-model' }).name, 'generic-openai-compatible');
});

test('normalizes only residual JSON ampersand escapes in signed image URLs', () => {
  const ordinary = 'https://img.example.com/out.png?a=1&b=2';
  assert.equal(normalizeUpstreamImageUrl(ordinary), ordinary);

  const residual = String.raw`https://img.example.com/out.png?x=1\u0026X-Amz-Credential=AKIA%2F20260714%2Fus-west-2%2Fs3%2Faws4_request\u0026X-Amz-Signature=abc%2B123`;
  const expected = 'https://img.example.com/out.png?x=1&X-Amz-Credential=AKIA%2F20260714%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Signature=abc%2B123';
  assert.equal(normalizeUpstreamImageUrl(residual), expected);
});

test('normal JSON unicode escapes are decoded before image URL normalization', () => {
  const parsed = JSON.parse(String.raw`{"data":[{"url":"https://img.example.com/out.png?x=1\u0026y=2"}]}`) as {
    data: Array<{ url: string }>;
  };
  const sources = genericOpenAICompatibleStrategy.extractImages(parsed);
  assert.equal(sources[0]?.value, 'https://img.example.com/out.png?x=1&y=2');
});

test('image extraction keeps base64 priority over URL', () => {
  const sources = genericOpenAICompatibleStrategy.extractImages({
    data: [{ b64_json: 'dGVzdA==', url: 'https://img.example.com/out.png' }]
  });
  assert.deepEqual(sources, [{ type: 'base64', value: 'dGVzdA==', declaredMimeType: undefined }]);
});

test('image URL passthrough still rejects invalid and non-http protocols', () => {
  assert.throws(
    () => normalizeUpstreamImageUrl('not a URL'),
    (error) => error instanceof AppError && error.code === 'invalid_image_url'
  );
  assert.throws(
    () => normalizeUpstreamImageUrl('file:///tmp/out.png'),
    (error) => error instanceof AppError && error.code === 'unsupported_image_url_protocol'
  );
});
