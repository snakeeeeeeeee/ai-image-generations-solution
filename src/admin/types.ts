export interface AdminConfig {
  basePath: string;
  password?: string;
  sessionSecret: string;
  dbPath: string;
  retentionDays: number;
  recentLimit: number;
  cookieSecure: boolean;
}

export interface AdminDrainState {
  draining: boolean;
  updatedAt?: string;
  reason?: string;
}

export interface ImageRequestRecord {
  requestId: string;
  createdAt: string;
  operation: 'generation' | 'edit';
  statusCode: number;
  success: boolean;
  model?: string;
  size?: string;
  totalMs: number;
  openaiMs: number;
  decodeMs: number;
  uploadMs: number;
  imageBytes: number;
  imageCount: number;
  errorCode?: string;
  errorMessage?: string;
  requestParams?: Record<string, unknown>;
  responseParams?: Record<string, unknown>;
  imageUrls: string[];
}

export interface AdminRuntimeStats {
  draining: boolean;
  safeToRestart: boolean;
  activeGenerations: number;
  queuedGenerations: number;
  maxConcurrentGenerations: number;
  activeImageProcessing: number;
  queuedImageProcessing: number;
  maxConcurrentImageProcessing: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    maxRssBytes: number;
  };
}
