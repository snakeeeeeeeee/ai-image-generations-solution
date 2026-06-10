import { AppError } from './errors.js';
import {
  applyImageDefaults,
  normalizeImageRequestBody,
  type ImageDefaults,
  type ImageFormat,
  type ImageRequestBody
} from './image.js';

export type ImageSourceType = 'base64' | 'url';

export interface ImageSource {
  type: ImageSourceType;
  value: string;
  declaredMimeType?: string;
}

export interface StrategyUpstreamImageItem {
  b64_json?: unknown;
  url?: unknown;
  mime_type?: unknown;
  mimeType?: unknown;
  [key: string]: unknown;
}

export interface StrategyUpstreamImageResponse {
  data?: StrategyUpstreamImageItem[];
  [key: string]: unknown;
}

export interface ImageModelStrategy {
  name: string;
  allowedFormats: ImageFormat[];
  match(body: ImageRequestBody): boolean;
  applyRequestDefaults(body: unknown, defaults: ImageDefaults): ImageRequestBody;
  extractImages(response: StrategyUpstreamImageResponse): ImageSource[];
}

const XAI_IMAGE_MODELS = new Set([
  'grok-imagine-image-quality',
  'grok-imagine-image'
]);

function normalizeModel(model: unknown): string {
  return typeof model === 'string' ? model.trim().toLowerCase() : '';
}

export function isXaiGrokImagineModel(model: unknown): boolean {
  return XAI_IMAGE_MODELS.has(normalizeModel(model));
}

export function isGptImageModel(model: unknown): boolean {
  return normalizeModel(model).startsWith('gpt-image-');
}

function getData(response: StrategyUpstreamImageResponse): StrategyUpstreamImageItem[] {
  return Array.isArray(response.data) ? response.data : [];
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function getDeclaredMimeType(item: StrategyUpstreamImageItem): string | undefined {
  return getString(item.mime_type) ?? getString(item.mimeType);
}

function extractBase64Only(response: StrategyUpstreamImageResponse): ImageSource[] {
  return getData(response).map((item) => {
    const b64Json = getString(item.b64_json);
    if (!b64Json) {
      throw new AppError('new-api returned image data without b64_json', {
        statusCode: 502,
        type: 'server_error',
        code: 'missing_b64_json'
      });
    }

    return {
      type: 'base64',
      value: b64Json,
      declaredMimeType: getDeclaredMimeType(item)
    };
  });
}

function extractUrlOrBase64(response: StrategyUpstreamImageResponse): ImageSource[] {
  return getData(response).map((item) => {
    const b64Json = getString(item.b64_json);
    if (b64Json) {
      return {
        type: 'base64',
        value: b64Json,
        declaredMimeType: getDeclaredMimeType(item)
      };
    }

    const url = getString(item.url);
    if (url) {
      return {
        type: 'url',
        value: url,
        declaredMimeType: getDeclaredMimeType(item)
      };
    }

    throw new AppError('new-api returned image data without url or b64_json', {
      statusCode: 502,
      type: 'server_error',
      code: 'missing_image_source'
    });
  });
}

export const xaiGrokImagineStrategy: ImageModelStrategy = {
  name: 'xai-grok-imagine',
  allowedFormats: ['png', 'jpeg', 'webp'],
  match: (body) => isXaiGrokImagineModel(body.model),
  applyRequestDefaults: (body) => normalizeImageRequestBody(body),
  extractImages: extractUrlOrBase64
};

export const gptImageStrategy: ImageModelStrategy = {
  name: 'gpt-image',
  allowedFormats: ['png'],
  match: (body) => isGptImageModel(body.model),
  applyRequestDefaults: applyImageDefaults,
  extractImages: extractBase64Only
};

export const genericOpenAICompatibleStrategy: ImageModelStrategy = {
  name: 'generic-openai-compatible',
  allowedFormats: ['png', 'jpeg', 'webp'],
  match: () => true,
  applyRequestDefaults: applyImageDefaults,
  extractImages: extractUrlOrBase64
};

export function pickImageStrategy(body: ImageRequestBody): ImageModelStrategy {
  if (xaiGrokImagineStrategy.match(body)) {
    return xaiGrokImagineStrategy;
  }
  if (gptImageStrategy.match(body)) {
    return gptImageStrategy;
  }
  return genericOpenAICompatibleStrategy;
}
