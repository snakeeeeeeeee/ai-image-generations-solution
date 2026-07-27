import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from 'undici';
import type { AppConfig } from '../src/config.js';
import {
  buildGeminiRequestBody,
  buildGeminiUpstreamPayload,
  extractGeminiBase64Result,
  geminiGenerateContentStrategy,
  normalizeGeminiUsage
} from '../src/gemini-image.js';
import type { AsyncTaskRecord } from '../src/async/types.js';
import { sanitizeRawResponse } from '../src/async/raw-response.js';

const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function buildConfig(): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    bodyLimitBytes: 1024,
    role: 'worker',
    limits: {
      maxConcurrentGenerations: 1,
      maxConcurrentImageProcessing: 1,
      maxProcessRssBytes: 1024
    },
    upstream: {
      baseUrl: 'https://unused.example.com',
      imagesPath: '/v1/images/generations',
      imageEditsPath: '/v1/images/edits',
      timeoutMs: 5000
    },
    defaults: {
      size: '1024x1024',
      outputFormat: 'png'
    },
    upload: {
      maxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    },
    cors: {
      allowedOrigins: ['*'],
      maxAgeSeconds: 60
    },
    r2: {
      endpoint: 'https://r2.example.com',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      bucket: 'test',
      publicUrl: 'https://img.example.com',
      keyPrefix: 'images',
      cacheControl: 'public, max-age=60',
      forcePathStyle: false
    },
    admin: {
      basePath: '/admin',
      password: 'test',
      sessionSecret: 'test-session-secret-that-is-long-enough',
      dbPath: ':memory:',
      retentionDays: 1,
      recentLimit: 10,
      cookieSecure: false
    },
    asyncTasks: {
      postgresUrl: '',
      redisUrl: '',
      providerApiKeys: ['test'],
      workerNodeId: 'worker-01',
      workerAdvertisedIp: '192.0.2.10',
      workerConcurrency: 1,
      imageProcessingConcurrency: 1,
      globalRateLimitIpm: 60,
      providerRateLimitConfig: {},
      callbackBatchSize: 1,
      callbackFlushMs: 1000,
      callbackMaxRetryAgeHours: 1,
      callbackDefaultSecret: 'callback',
      callbackSecrets: {},
      credentialLeaseSecrets: { image_handle_1: 'internal' },
      credentialLeaseAllowedHosts: ['new-api.example.com'],
      imageUrlAllowPrivateNetwork: false,
      rawResponseMaxBytes: 1024,
      syncTaskTimeoutMs: 5000,
      syncTaskPollIntervalMs: 50,
      syncWaitConcurrency: 1,
      workerHeartbeatIntervalMs: 5000,
      workerHeartbeatTtlSeconds: 15,
      taskStaleProcessingTimeoutSeconds: 1800
    }
  };
}

function buildTask(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    provider_task_id: 'provider_task_1',
    client_task_id: 'task_1',
    request_id: 'req_1',
    request_fingerprint: 'fingerprint',
    provider_api_key_hash: 'hash',
    provider: 'new-api',
    model: 'gemini-3.1-flash-image',
    operation: 'generation',
    status: 'processing',
    input: { text: 'draw a blue square' },
    parameters: {},
    provider_options: {},
    executor: {
      type: 'provider_direct_lease',
      lease_id: 'lease_1',
      resolve_url: 'https://new-api.example.com/resolve',
      secret_id: 'image_handle_1'
    },
    callback: {},
    metadata: {},
    result: null,
    usage: null,
    error: null,
    attempts: 1,
    assignment_version: 1,
    created_at: '2026-07-28T00:00:00Z',
    updated_at: '2026-07-28T00:00:00Z',
    ...overrides
  };
}

test('Gemini request maps strict size and snake_case provider aliases', () => {
  const body = buildGeminiRequestBody({
    prompt: 'draw a blue square',
    parameters: { size: '3072x2048' },
    providerOptions: {
      google: {
        generation_config: {
          top_p: 0.9,
          top_k: 20,
          thinking_config: {
            thinking_budget: 128,
            include_thoughts: false
          }
        },
        safety_settings: [{
          category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
          threshold: 'BLOCK_NONE'
        }]
      }
    }
  });

  assert.deepEqual(body, {
    contents: [{
      role: 'user',
      parts: [{ text: 'draw a blue square' }]
    }],
    generationConfig: {
      topP: 0.9,
      topK: 20,
      thinkingConfig: {
        thinkingBudget: 128,
        includeThoughts: false
      },
      imageConfig: {
        aspectRatio: '3:2',
        imageSize: '2K'
      },
      responseModalities: ['IMAGE']
    },
    safetySettings: [{
      category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
      threshold: 'BLOCK_NONE'
    }]
  });
});

test('Gemini request rejects duplicate aliases and duplicate size controls', () => {
  assert.throws(
    () => buildGeminiRequestBody({
      prompt: 'test',
      providerOptions: {
        google: {
          generationConfig: {
            topP: 0.8,
            top_p: 0.9
          }
        }
      }
    }),
    (error: any) => error?.code === 'duplicate_parameter'
  );

  assert.throws(
    () => buildGeminiRequestBody({
      prompt: 'test',
      parameters: { size: '1024x1024' },
      providerOptions: {
        google: {
          generationConfig: {
            imageConfig: { aspectRatio: '1:1' }
          }
        }
      }
    }),
    (error: any) => error?.code === 'duplicate_parameter'
  );
});

test('Gemini payload uses lease endpoint and x-goog-api-key without Bearer auth', async () => {
  const payload = await buildGeminiUpstreamPayload({
    task: buildTask(),
    lease: {
      provider: 'google_gemini',
      request_format: 'gemini_generate_content',
      base_url: 'https://generativelanguage.googleapis.com',
      endpoint_url:
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent',
      api_key: 'lease-secret',
      model: 'gemini-3.1-flash-image'
    },
    config: buildConfig(),
    dispatcher: new Agent()
  });

  assert.equal(
    payload.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent'
  );
  assert.equal(payload.headers['x-goog-api-key'], 'lease-secret');
  assert.equal(payload.headers.authorization, undefined);
  const body = JSON.parse(String(payload.body));
  assert.deepEqual(body.generationConfig.imageConfig, {
    aspectRatio: '1:1',
    imageSize: '1K'
  });
});

test('Gemini strategy extracts exactly one inline image or HTTP URL', () => {
  const inline = geminiGenerateContentStrategy.extractImages({
    candidates: [{
      content: {
        parts: [{
          inlineData: {
            mimeType: 'image/png',
            data: tinyPngBase64
          }
        }]
      }
    }]
  });
  assert.deepEqual(inline, [{
    type: 'base64',
    value: tinyPngBase64,
    declaredMimeType: 'image/png'
  }]);

  const url =
    'https://img.example.com/out.png?X-Amz-Credential=test%2Fscope&X-Amz-Signature=abc%2B123';
  assert.deepEqual(geminiGenerateContentStrategy.extractImages({
    candidates: [{
      content: {
        parts: [{
          fileData: {
            mimeType: 'image/png',
            fileUri: url
          }
        }]
      }
    }]
  }), [{
    type: 'url',
    value: url,
    declaredMimeType: 'image/png'
  }]);

  assert.throws(
    () => geminiGenerateContentStrategy.extractImages({
      candidates: [{
        content: {
          parts: [
            { inlineData: { mimeType: 'image/png', data: tinyPngBase64 } },
            { inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }
          ]
        }
      }]
    }),
    (error: any) => error?.code === 'gemini_multiple_images'
  );
});

test('Gemini usage keeps output image tokens in completion only', () => {
  assert.deepEqual(normalizeGeminiUsage({
    usageMetadata: {
      promptTokenCount: 26,
      toolUsePromptTokenCount: 4,
      candidatesTokenCount: 1120,
      thoughtsTokenCount: 10,
      totalTokenCount: 1160,
      cachedContentTokenCount: 3,
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 26 },
        { modality: 'IMAGE', tokenCount: 1032 }
      ],
      toolUsePromptTokensDetails: [
        { modality: 'AUDIO', tokenCount: 4 }
      ],
      candidatesTokensDetails: [
        { modality: 'IMAGE', tokenCount: 1120 }
      ]
    }
  }), {
    prompt_tokens: 30,
    completion_tokens: 1130,
    total_tokens: 1160,
    input_tokens: 30,
    output_tokens: 1130,
    cached_tokens: 3,
    image_tokens: 1032,
    audio_tokens: 4,
    prompt_tokens_details: {
      cached_tokens: 3,
      text_tokens: 26,
      audio_tokens: 4,
      image_tokens: 1032
    },
    input_tokens_details: {
      cached_tokens: 3,
      text_tokens: 26,
      audio_tokens: 4,
      image_tokens: 1032
    },
    completion_tokens_details: {
      reasoning_tokens: 10
    }
  });
});

test('Gemini Base64 extraction and raw response sanitization omit inline data', () => {
  const response = {
    candidates: [{
      content: {
        parts: [{
          inlineData: {
            mimeType: 'image/png',
            data: tinyPngBase64
          }
        }]
      }
    }],
    usageMetadata: {
      totalTokenCount: 10
    }
  };
  assert.deepEqual(extractGeminiBase64Result(response), {
    images: [{
      b64_json: tinyPngBase64,
      mime_type: 'image/png'
    }]
  });

  const safe = sanitizeRawResponse(response, 4096);
  assert.equal(
    (safe.raw_response as any).candidates[0].content.parts[0].inlineData.data,
    '[omitted]'
  );
  assert.deepEqual(safe.raw_response_omitted_fields, [
    'candidates[].content.parts[].inlineData.data'
  ]);
  assert.equal((safe.raw_response as any).usageMetadata.totalTokenCount, 10);
});
