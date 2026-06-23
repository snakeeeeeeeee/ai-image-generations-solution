const DEFAULT_OMITTED_FIELD = '$';
const DATA_URI_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const BASE64_LIKE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SENSITIVE_LARGE_KEYS = new Set([
  'b64_json',
  'base64',
  'image_base64',
  'imageBase64',
  'binary',
  'bytes'
]);

export interface SafeRawResponse {
  raw_response: unknown;
  raw_response_truncated: boolean;
  raw_response_omitted_fields: string[];
}

export function sanitizeRawResponse(value: unknown, maxBytes: number): SafeRawResponse {
  const omitted = new Set<string>();
  const sanitized = sanitizeValue(value, '$', omitted);
  const fit = fitJsonToLimit(sanitized, maxBytes);
  return {
    raw_response: fit.value,
    raw_response_truncated: omitted.size > 0 || fit.truncated,
    raw_response_omitted_fields: [...omitted]
  };
}

function sanitizeValue(value: unknown, path: string, omitted: Set<string>): unknown {
  if (typeof value === 'string') {
    if (isDataUriImage(value)) {
      omitted.add(path || DEFAULT_OMITTED_FIELD);
      return '[omitted]';
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, `${path}[${index}]`, omitted));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const itemPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_LARGE_KEYS.has(key) || (typeof item === 'string' && shouldOmitStringForKey(key, item))) {
      omitted.add(normalizePath(itemPath));
      result[key] = '[omitted]';
      continue;
    }
    result[key] = sanitizeValue(item, itemPath, omitted);
  }
  return result;
}

function shouldOmitString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 1024 || trimmed.length % 4 === 1) {
    return false;
  }
  return BASE64_LIKE_RE.test(trimmed);
}

function shouldOmitStringForKey(key: string, value: string): boolean {
  return isDataUriImage(value) || (SENSITIVE_LARGE_KEYS.has(key) && shouldOmitString(value));
}

function isDataUriImage(value: string): boolean {
  return DATA_URI_IMAGE_RE.test(value.trim());
}

function fitJsonToLimit(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= maxBytes) {
    return { value, truncated: false };
  }
  return {
    value: {
      truncated: true,
      message: `raw_response exceeded ${maxBytes} bytes`
    },
    truncated: true
  };
}

function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]').replace(/^\$\./, '');
}
