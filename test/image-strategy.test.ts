import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGptImageModel, isXaiGrokImagineModel, pickImageStrategy } from '../src/image-strategy.js';

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
