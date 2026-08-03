import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { Agent } from 'undici';
import type { AppConfig } from '../src/config.js';
import {
  parseAdobeTaskState,
  queryAdobeImageTasks,
  shouldUseAdobeAsyncDriver,
  submitAdobeImageTask
} from '../src/async/adobe-driver.js';
import { normalizePolledSequence } from '../src/async/worker.js';
import type { AsyncTaskRecord } from '../src/async/types.js';

function buildTask(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    provider_task_id: 'imgtask_1',
    client_task_id: 'client_1',
    request_id: 'request_1',
    request_fingerprint: 'fingerprint',
    provider_api_key_hash: 'hash',
    provider: 'provider_direct_lease',
    model: 'adobe-gpt-image-2',
    operation: 'generation',
    status: 'processing',
    input: { text: 'draw a red cube' },
    parameters: { n: 1, quality: 'high', size: '1024x1024' },
    provider_options: {},
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: 'https://new-api.example.com/resolve',
      secret_id: 'image_handle_1'
    },
    callback: {},
    metadata: { result_data_format: 'url' },
    result: null,
    usage: null,
    error: null,
    attempts: 1,
    assignment_version: 1,
    created_at: '2026-08-02T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
    ...overrides
  };
}

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    asyncTasks: {
      adobeAsyncImageEnabled: true,
      adobeAsyncCallbackBaseUrl: 'http://image-handle:8787',
      adobeAsyncCallbackSecretId: 'adobe2api',
      ...overrides
    }
  } as unknown as AppConfig;
}

const lease = {
  provider: 'openai_compatible',
  request_format: 'openai_images',
  base_url: 'http://127.0.0.1:1',
  api_key: 'secret-key',
  model: 'adobe-gpt-image-2',
  execution_driver: 'adobe2api_async_image_v1'
};

test('Adobe async driver is strictly opt-in and safely falls back', () => {
  assert.equal(shouldUseAdobeAsyncDriver(buildTask(), lease, config()), true);
  assert.equal(shouldUseAdobeAsyncDriver(
    buildTask({ parameters: { n: 2 } }), lease, config()
  ), false);
  assert.equal(shouldUseAdobeAsyncDriver(
    buildTask({ operation: 'edit' }), lease, config()
  ), false);
  assert.equal(shouldUseAdobeAsyncDriver(
    buildTask({ metadata: { result_data_format: 'base64' } }), lease, config()
  ), true);
  assert.equal(shouldUseAdobeAsyncDriver(
    buildTask(), { ...lease, execution_driver: 'legacy_sync' }, config()
  ), false);
  assert.equal(shouldUseAdobeAsyncDriver(
    buildTask(), lease, config({ adobeAsyncImageEnabled: false })
  ), false);
});

test('Adobe async driver submits an idempotent single-image task and batch queries it', async () => {
  const upstream = Fastify();
  let submittedBody: Record<string, unknown> | undefined;
  let submittedAuthorization = '';
  upstream.post('/v1/image/tasks', async (request, reply) => {
    submittedBody = request.body as Record<string, unknown>;
    submittedAuthorization = String(request.headers.authorization || '');
    return reply.status(202).send({
      task_id: 'img_upstream_1',
      client_task_id: 'imgtask_1',
      status: 'queued',
      progress: 0,
      progress_known: false,
      progress_source: 'queue',
      stage: 'queued',
      sequence: 1
    });
  });
  upstream.post('/v1/image/tasks/query', async (request) => {
    assert.deepEqual(request.body, { task_ids: ['img_upstream_1'] });
    return {
      data: [{
        task_id: 'img_upstream_1',
        client_task_id: 'imgtask_1',
        status: 'in_progress',
        progress: 37,
        progress_known: true,
        progress_source: 'upstream_percent',
        stage: 'generating',
        sequence: 2
      }]
    };
  });
  await upstream.listen({ host: '127.0.0.1', port: 0 });
  const address = upstream.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server has no TCP address');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const dispatcher = new Agent();
  try {
    const accepted = await submitAdobeImageTask({
      task: buildTask(),
      lease: { ...lease, base_url: baseUrl },
      config: config(),
      dispatcher
    });
    assert.equal(accepted.taskId, 'img_upstream_1');
    assert.equal(accepted.sequence, 1);
    assert.equal(submittedAuthorization, 'Bearer secret-key');
    assert.equal(submittedBody?.client_task_id, 'imgtask_1');
    assert.deepEqual(submittedBody?.input, { text: 'draw a red cube' });
    assert.deepEqual(
      submittedBody?.callback,
      {
        url: 'http://image-handle:8787/internal/adobe/image-task-callback',
        secret_id: 'adobe2api'
      }
    );

    const [progress] = await queryAdobeImageTasks({
      baseUrl,
      apiKey: 'secret-key',
      taskIds: ['img_upstream_1'],
      dispatcher
    });
    assert.equal(progress?.progress, 37);
    assert.equal(progress?.progressKnown, true);
    assert.equal(progress?.sequence, 2);
  } finally {
    await dispatcher.close();
    await upstream.close();
  }
});

test('Adobe task errors are normalized without exposing the supplier name', () => {
  const state = parseAdobeTaskState({
    task_id: 'img_upstream_2',
    status: 'failed',
    progress: 100,
    progress_known: false,
    sequence: 3,
    error: {
      code: 'generation_failed',
      message: 'Adobe generation failed before submission'
    }
  });
  assert.equal(state.error?.message, 'upstream generation failed before submission');
});

test('poll fallback advances sequence only when a callback update was missed', () => {
  const task = buildTask({
    execution_driver: 'adobe2api_async_image_v1',
    upstream_task_id: 'img_upstream_3',
    upstream_status: 'in_progress',
    upstream_sequence: 4,
    progress: 25,
    progress_known: true,
    progress_source: 'upstream_percent',
    stage: 'generating'
  });
  const completed = normalizePolledSequence(task, {
    taskId: 'img_upstream_3',
    status: 'completed',
    progress: 100,
    progressKnown: true,
    progressSource: 'upstream_percent',
    stage: 'completed',
    sequence: 4,
    result: { data: [{ url: 'https://example.com/result.png' }] },
    usage: null,
    error: null
  });
  assert.equal(completed?.sequence, 5);
  assert.equal(completed?.status, 'completed');

  const unchanged = normalizePolledSequence(task, {
    taskId: 'img_upstream_3',
    status: 'in_progress',
    progress: 25,
    progressKnown: true,
    progressSource: 'upstream_percent',
    stage: 'generating',
    sequence: 4,
    result: null,
    usage: null,
    error: null
  });
  assert.equal(unchanged, undefined);
});
