import type { AppConfig } from './config.js';
import { AppError } from './errors.js';
import { readImageMetadata } from './image.js';
import {
  loadImageSource,
  type UpstreamDispatcher,
  type UpstreamRequestPayload
} from './image-runner.js';
import {
  normalizeUpstreamImageUrl,
  type ImageModelStrategy,
  type ImageSource,
  type StrategyUpstreamImageResponse
} from './image-strategy.js';
import type { AsyncTaskRecord } from './async/types.js';

export const GEMINI_PROVIDER = 'google_gemini';
export const GEMINI_REQUEST_FORMAT = 'gemini_generate_content';

const SUPPORTED_MODELS = new Set([
  'gemini-3.1-flash-image',
  'gemini-3-pro-image-count'
]);
const GEMINI_FLASH_MODEL = 'gemini-3.1-flash-image';
const GEMINI_PRO_MODEL = 'gemini-3-pro-image-count';

const SIZE_MAP = new Map<string, { aspectRatio: string; imageSize: string }>([
  ['1024x1024', { aspectRatio: '1:1', imageSize: '1K' }],
  ['1024x1536', { aspectRatio: '2:3', imageSize: '1K' }],
  ['1536x1024', { aspectRatio: '3:2', imageSize: '1K' }],
  ['2048x2048', { aspectRatio: '1:1', imageSize: '2K' }],
  ['2048x3072', { aspectRatio: '2:3', imageSize: '2K' }],
  ['3072x2048', { aspectRatio: '3:2', imageSize: '2K' }]
]);

const ASPECT_RATIOS = new Set([
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9'
]);

const IMAGE_SIZES = new Set(['512', '1K', '2K', '4K']);

interface GeminiInlineImage {
  mimeType: string;
  data: string;
}

interface GeminiRequestSettings {
  generationConfig: Record<string, unknown>;
  safetySettings?: Array<Record<string, unknown>>;
}

export interface GeminiCredentialLease {
  provider: string;
  request_format: string;
  base_url: string;
  endpoint_url?: string;
  api_key: string;
  model: string;
  channel_id?: string;
  expires_at?: string;
}

function invalidRequest(message: string, code: string, param?: string): never {
  throw new AppError(message, {
    statusCode: 400,
    type: 'invalid_request_error',
    code,
    cause: {
      retryable: false,
      ...(param ? { param } : {})
    }
  });
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function getNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getInteger(value: unknown, param: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    invalidRequest(`${param} must be an integer`, 'invalid_provider_options', param);
  }
  return value;
}

function getFiniteNumber(value: unknown, param: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidRequest(`${param} must be a finite number`, 'invalid_provider_options', param);
  }
  return value;
}

function getBoolean(value: unknown, param: string): boolean {
  if (typeof value !== 'boolean') {
    invalidRequest(`${param} must be a boolean`, 'invalid_provider_options', param);
  }
  return value;
}

function normalizeAliasedObject(
  source: Record<string, unknown>,
  aliases: Record<string, string>,
  allowed: Set<string>,
  path: string
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = aliases[rawKey] ?? rawKey;
    if (!allowed.has(key)) {
      invalidRequest(`${path}.${rawKey} is not supported`, 'invalid_provider_options', `${path}.${rawKey}`);
    }
    if (key in normalized) {
      invalidRequest(
        `${path}.${rawKey} duplicates ${path}.${key}`,
        'duplicate_parameter',
        `${path}.${rawKey}`
      );
    }
    normalized[key] = value;
  }
  return normalized;
}

function optionalObject(value: unknown, param: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidRequest(`${param} must be an object`, 'invalid_provider_options', param);
  }
  return value as Record<string, unknown>;
}

function normalizeImageSize(value: unknown, publicModel: string, param: string): string {
  const raw = getString(value)?.toUpperCase();
  const imageSize = raw === '0.5K' ? '512' : raw;
  if (!imageSize || !IMAGE_SIZES.has(imageSize)) {
    invalidRequest(`${param} is unsupported`, 'unsupported_image_resolution', param);
  }
  if (publicModel === GEMINI_PRO_MODEL && imageSize === '512') {
    invalidRequest(
      `${param} is unsupported for ${GEMINI_PRO_MODEL}`,
      'unsupported_image_resolution',
      param
    );
  }
  return imageSize;
}

function normalizeAspectRatio(value: unknown, param: string): string {
  const aspectRatio = getString(value);
  if (!aspectRatio || !ASPECT_RATIOS.has(aspectRatio)) {
    invalidRequest(`${param} is unsupported`, 'unsupported_aspect_ratio', param);
  }
  return aspectRatio;
}

function normalizeImageConfig(
  value: unknown,
  publicModel: string
): Record<string, unknown> | undefined {
  const source = optionalObject(value, 'provider_options.google.generationConfig.imageConfig');
  if (!source) {
    return undefined;
  }
  const normalized = normalizeAliasedObject(
    source,
    {
      aspect_ratio: 'aspectRatio',
      image_size: 'imageSize'
    },
    new Set(['aspectRatio', 'imageSize']),
    'provider_options.google.generationConfig.imageConfig'
  );

  if (normalized.aspectRatio !== undefined) {
    normalized.aspectRatio = normalizeAspectRatio(
      normalized.aspectRatio,
      'provider_options.google.generationConfig.imageConfig.aspectRatio'
    );
  }
  if (normalized.imageSize !== undefined) {
    normalized.imageSize = normalizeImageSize(
      normalized.imageSize,
      publicModel,
      'provider_options.google.generationConfig.imageConfig.imageSize'
    );
  }
  return normalized;
}

function normalizeThinkingConfig(value: unknown): Record<string, unknown> | undefined {
  const source = optionalObject(value, 'provider_options.google.generationConfig.thinkingConfig');
  if (!source) {
    return undefined;
  }
  const normalized = normalizeAliasedObject(
    source,
    {
      thinking_budget: 'thinkingBudget',
      thinking_level: 'thinkingLevel',
      include_thoughts: 'includeThoughts'
    },
    new Set(['thinkingBudget', 'thinkingLevel', 'includeThoughts']),
    'provider_options.google.generationConfig.thinkingConfig'
  );

  if (normalized.thinkingBudget !== undefined) {
    normalized.thinkingBudget = getInteger(
      normalized.thinkingBudget,
      'provider_options.google.generationConfig.thinkingConfig.thinkingBudget'
    );
  }
  if (normalized.thinkingLevel !== undefined) {
    const level = getString(normalized.thinkingLevel);
    if (!level) {
      invalidRequest(
        'provider_options.google.generationConfig.thinkingConfig.thinkingLevel must be a string',
        'invalid_provider_options',
        'provider_options.google.generationConfig.thinkingConfig.thinkingLevel'
      );
    }
    normalized.thinkingLevel = level;
  }
  if (normalized.includeThoughts !== undefined) {
    normalized.includeThoughts = getBoolean(
      normalized.includeThoughts,
      'provider_options.google.generationConfig.thinkingConfig.includeThoughts'
    );
  }
  return normalized;
}

function normalizeGenerationConfig(
  value: unknown,
  publicModel: string
): Record<string, unknown> {
  const source = optionalObject(value, 'provider_options.google.generationConfig') ?? {};
  const normalized = normalizeAliasedObject(
    source,
    {
      top_p: 'topP',
      top_k: 'topK',
      image_config: 'imageConfig',
      thinking_config: 'thinkingConfig'
    },
    new Set(['temperature', 'topP', 'topK', 'seed', 'imageConfig', 'thinkingConfig']),
    'provider_options.google.generationConfig'
  );

  for (const key of ['temperature', 'topP'] as const) {
    if (normalized[key] !== undefined) {
      normalized[key] = getFiniteNumber(
        normalized[key],
        `provider_options.google.generationConfig.${key}`
      );
    }
  }
  for (const key of ['topK', 'seed'] as const) {
    if (normalized[key] !== undefined) {
      normalized[key] = getInteger(
        normalized[key],
        `provider_options.google.generationConfig.${key}`
      );
    }
  }

  const imageConfig = normalizeImageConfig(normalized.imageConfig, publicModel);
  const thinkingConfig = normalizeThinkingConfig(normalized.thinkingConfig);
  if (imageConfig) {
    normalized.imageConfig = imageConfig;
  }
  if (thinkingConfig) {
    normalized.thinkingConfig = thinkingConfig;
  }
  return normalized;
}

function normalizeSafetySettings(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    invalidRequest(
      'provider_options.google.safetySettings must be an array',
      'invalid_provider_options',
      'provider_options.google.safetySettings'
    );
  }
  return value.map((item, index) => {
    const source = optionalObject(item, `provider_options.google.safetySettings[${index}]`);
    const normalized = normalizeAliasedObject(
      source ?? {},
      {},
      new Set(['category', 'threshold']),
      `provider_options.google.safetySettings[${index}]`
    );
    const category = getString(normalized.category);
    const threshold = getString(normalized.threshold);
    if (!category || !threshold) {
      invalidRequest(
        'Gemini safety settings require category and threshold',
        'invalid_provider_options',
        `provider_options.google.safetySettings[${index}]`
      );
    }
    return { category, threshold };
  });
}

function normalizeProviderOptions(
  value: Record<string, unknown>,
  publicModel: string
): GeminiRequestSettings {
  const top = normalizeAliasedObject(
    value,
    {},
    new Set(['google']),
    'provider_options'
  );
  const googleSource = optionalObject(top.google, 'provider_options.google') ?? {};
  const google = normalizeAliasedObject(
    googleSource,
    {
      generation_config: 'generationConfig',
      safety_settings: 'safetySettings'
    },
    new Set(['generationConfig', 'safetySettings']),
    'provider_options.google'
  );
  return {
    generationConfig: normalizeGenerationConfig(google.generationConfig, publicModel),
    safetySettings: normalizeSafetySettings(google.safetySettings)
  };
}

function optionalScalar(value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    return value as string | number | boolean;
  }
  return undefined;
}

function assertGeminiTask(task: AsyncTaskRecord): void {
  const model = task.model.trim().toLowerCase();
  if (!SUPPORTED_MODELS.has(model)) {
    invalidRequest('Gemini image model is unsupported', 'model_not_supported', 'model');
  }

  const mask = getString(task.input.mask);
  if (mask) {
    invalidRequest('Gemini image editing does not support masks', 'unsupported_mask', 'input.mask');
  }

  const nValue = optionalScalar(task.parameters.n);
  const count = nValue === undefined ? 1 : Number(nValue);
  if (!Number.isSafeInteger(count) || count !== 1) {
    invalidRequest('Gemini image tasks support exactly one output image', 'unsupported_image_count', 'n');
  }

  const quality = getString(task.parameters.quality)?.toLowerCase();
  if (quality && quality !== 'auto') {
    invalidRequest('Gemini image tasks only support quality=auto', 'unsupported_quality', 'quality');
  }

  const outputFormat = getString(task.parameters.output_format)?.toLowerCase();
  if (outputFormat && outputFormat !== 'png') {
    invalidRequest('Gemini image tasks only support PNG output', 'unsupported_output_format', 'output_format');
  }

  for (const key of ['output_compression', 'background', 'input_fidelity']) {
    if (optionalScalar(task.parameters[key]) !== undefined) {
      invalidRequest(`Gemini image tasks do not support ${key}`, 'unsupported_parameter', key);
    }
  }

  if (task.operation === 'edit') {
    const images = Array.isArray(task.input.images)
      ? task.input.images.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : [];
    if (images.length === 0) {
      invalidRequest('Gemini image edits require at least one input image', 'missing_edit_images', 'input.images');
    }
  }
}

function applySize(
  generationConfig: Record<string, unknown>,
  parameters: Record<string, unknown>,
  publicModel: string
): void {
  const existing = safeObject(generationConfig.imageConfig);
  const explicitSize = getString(parameters.size);
  const hasProviderImageConfig = Object.hasOwn(generationConfig, 'imageConfig');
  const explicitAspectRatio = getString(parameters.aspect_ratio);
  const explicitResolution = getString(parameters.resolution);

  if (explicitSize && (
    explicitAspectRatio ||
    explicitResolution ||
    hasProviderImageConfig
  )) {
    invalidRequest(
      'size duplicates Gemini aspect ratio or resolution controls',
      'duplicate_parameter',
      'size'
    );
  }

  if (explicitSize) {
    const mapped = SIZE_MAP.get(explicitSize);
    if (!mapped) {
      invalidRequest('Gemini image size is unsupported', 'unsupported_image_size', 'size');
    }
    generationConfig.imageConfig = { ...mapped };
    return;
  }

  if (explicitAspectRatio && existing.aspectRatio !== undefined) {
    invalidRequest(
      'aspect_ratio duplicates provider_options.google.generationConfig.imageConfig.aspectRatio',
      'duplicate_parameter',
      'aspect_ratio'
    );
  }
  if (explicitResolution && existing.imageSize !== undefined) {
    invalidRequest(
      'resolution duplicates provider_options.google.generationConfig.imageConfig.imageSize',
      'duplicate_parameter',
      'resolution'
    );
  }

  generationConfig.imageConfig = {
    aspectRatio: explicitAspectRatio
      ? normalizeAspectRatio(explicitAspectRatio, 'aspect_ratio')
      : getString(existing.aspectRatio) ?? '1:1',
    imageSize: explicitResolution
      ? normalizeImageSize(explicitResolution, publicModel, 'resolution')
      : getString(existing.imageSize) ?? '1K'
  };
}

export function buildGeminiRequestBody({
  publicModel,
  prompt,
  images = [],
  parameters = {},
  providerOptions = {}
}: {
  publicModel: string;
  prompt: string;
  images?: GeminiInlineImage[];
  parameters?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}): Record<string, unknown> {
  const normalizedPublicModel = publicModel.trim().toLowerCase();
  if (!SUPPORTED_MODELS.has(normalizedPublicModel)) {
    invalidRequest('Gemini image model is unsupported', 'model_not_supported', 'model');
  }
  const settings = normalizeProviderOptions(providerOptions, normalizedPublicModel);
  applySize(settings.generationConfig, parameters, normalizedPublicModel);
  settings.generationConfig.responseModalities = ['IMAGE'];

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const image of images) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.data
      }
    });
  }

  return {
    contents: [{
      role: 'user',
      parts
    }],
    generationConfig: settings.generationConfig,
    ...(settings.safetySettings ? { safetySettings: settings.safetySettings } : {})
  };
}

function parseGeminiImageSources(response: StrategyUpstreamImageResponse): ImageSource[] {
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const sources: ImageSource[] = [];

  for (const candidateValue of candidates) {
    const candidate = safeObject(candidateValue);
    const content = safeObject(candidate.content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const partValue of parts) {
      const part = safeObject(partValue);
      const inlineData = safeObject(part.inlineData ?? part.inline_data);
      const inlineValue = getString(inlineData.data);
      const inlineMime = getString(inlineData.mimeType ?? inlineData.mime_type);
      if (inlineValue && inlineMime?.toLowerCase().startsWith('image/')) {
        sources.push({
          type: 'base64',
          value: inlineValue,
          declaredMimeType: inlineMime
        });
        continue;
      }

      const fileData = safeObject(part.fileData ?? part.file_data);
      const fileUri = getString(fileData.fileUri ?? fileData.file_uri);
      const fileMime = getString(fileData.mimeType ?? fileData.mime_type);
      if (fileUri && fileMime?.toLowerCase().startsWith('image/')) {
        sources.push({
          type: 'url',
          value: normalizeUpstreamImageUrl(fileUri),
          declaredMimeType: fileMime
        });
      }
    }
  }

  if (sources.length === 0) {
    throw new AppError('Gemini response did not include an image', {
      statusCode: 502,
      type: 'upstream_error',
      code: 'gemini_missing_image',
      cause: { retryable: false }
    });
  }
  if (sources.length !== 1) {
    throw new AppError('Gemini response included more than one image', {
      statusCode: 502,
      type: 'upstream_error',
      code: 'gemini_multiple_images',
      cause: { retryable: false, image_count: sources.length }
    });
  }
  return sources;
}

export const geminiGenerateContentStrategy: ImageModelStrategy = {
  name: 'gemini-generate-content',
  allowedFormats: ['png'],
  match: (body) => SUPPORTED_MODELS.has(getString(body.model)?.toLowerCase() ?? ''),
  applyRequestDefaults: (body) => body as never,
  extractImages: parseGeminiImageSources
};

function validateEndpointUrl(value: string | undefined): string {
  if (!value) {
    invalidRequest('Gemini credential lease endpoint_url is required', 'invalid_credential_lease');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new AppError('Gemini credential lease endpoint_url is invalid', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_credential_lease',
      cause: error
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    invalidRequest('Gemini credential lease endpoint_url protocol is unsupported', 'invalid_credential_lease');
  }
  return parsed.toString();
}

export async function buildGeminiUpstreamPayload({
  task,
  lease,
  config,
  dispatcher
}: {
  task: AsyncTaskRecord;
  lease: GeminiCredentialLease;
  config: AppConfig;
  dispatcher: UpstreamDispatcher;
}): Promise<UpstreamRequestPayload> {
  assertGeminiTask(task);
  const inlineImages: GeminiInlineImage[] = [];
  const imageUrls = Array.isArray(task.input.images)
    ? task.input.images.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];

  for (const url of imageUrls) {
    const buffer = await loadImageSource({
      source: { type: 'url', value: url },
      config,
      dispatcher
    });
    const metadata = readImageMetadata(buffer);
    inlineImages.push({
      mimeType: metadata.mimeType,
      data: buffer.toString('base64')
    });
  }

  const body = buildGeminiRequestBody({
    publicModel: task.model,
    prompt: getString(task.input.text) ?? '',
    images: inlineImages,
    parameters: task.parameters,
    providerOptions: task.provider_options
  });

  return {
    url: validateEndpointUrl(lease.endpoint_url),
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': lease.api_key
    },
    strategy: geminiGenerateContentStrategy,
    metadata: {
      model: lease.model || task.model,
      size: getString(task.parameters.size)
    },
    requestParams: {
      model: lease.model || task.model,
      n: 1,
      size: getString(task.parameters.size) ?? '1024x1024',
      output_format: 'png'
    }
  };
}

function modalityTotals(value: unknown): { text: number; image: number; audio: number } {
  const totals = { text: 0, image: 0, audio: 0 };
  if (!Array.isArray(value)) {
    return totals;
  }
  for (const itemValue of value) {
    const item = safeObject(itemValue);
    const count = getNumber(item.tokenCount ?? item.token_count);
    switch (getString(item.modality)?.toUpperCase()) {
    case 'TEXT':
      totals.text += count;
      break;
    case 'IMAGE':
      totals.image += count;
      break;
    case 'AUDIO':
      totals.audio += count;
      break;
    }
  }
  return totals;
}

export function normalizeGeminiUsage(response: unknown): Record<string, unknown> {
  const metadata = safeObject(safeObject(response).usageMetadata ?? safeObject(response).usage_metadata);
  const promptTokens =
    getNumber(metadata.promptTokenCount ?? metadata.prompt_token_count) +
    getNumber(metadata.toolUsePromptTokenCount ?? metadata.tool_use_prompt_token_count);
  const thoughtsTokens = getNumber(metadata.thoughtsTokenCount ?? metadata.thoughts_token_count);
  const completionTokens =
    getNumber(metadata.candidatesTokenCount ?? metadata.candidates_token_count) +
    thoughtsTokens;
  const totalTokens =
    getNumber(metadata.totalTokenCount ?? metadata.total_token_count) ||
    promptTokens + completionTokens;
  const cachedTokens = getNumber(metadata.cachedContentTokenCount ?? metadata.cached_content_token_count);
  const promptDetails = modalityTotals(metadata.promptTokensDetails ?? metadata.prompt_tokens_details);
  const toolDetails = modalityTotals(metadata.toolUsePromptTokensDetails ?? metadata.tool_use_prompt_tokens_details);
  const imageTokens = promptDetails.image + toolDetails.image;
  const audioTokens = promptDetails.audio + toolDetails.audio;
  const textTokens = promptDetails.text + toolDetails.text;
  const inputDetails = {
    cached_tokens: cachedTokens,
    text_tokens: textTokens,
    audio_tokens: audioTokens,
    image_tokens: imageTokens
  };

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    cached_tokens: cachedTokens,
    image_tokens: imageTokens,
    audio_tokens: audioTokens,
    prompt_tokens_details: inputDetails,
    input_tokens_details: inputDetails,
    completion_tokens_details: {
      reasoning_tokens: thoughtsTokens
    }
  };
}

export function extractGeminiBase64Result(response: unknown): {
  images: Array<{ b64_json: string; mime_type?: string }>;
} {
  const sources = parseGeminiImageSources(safeObject(response));
  const source = sources[0];
  if (!source || source.type !== 'base64') {
    throw new AppError('Gemini response did not include Base64 image data', {
      statusCode: 502,
      type: 'upstream_error',
      code: 'missing_base64_result',
      cause: { retryable: false }
    });
  }
  return {
    images: [{
      b64_json: source.value,
      ...(source.declaredMimeType ? { mime_type: source.declaredMimeType } : {})
    }]
  };
}
