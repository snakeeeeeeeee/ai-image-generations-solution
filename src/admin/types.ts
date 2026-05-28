export interface AdminConfig {
  password?: string;
  sessionSecret: string;
  dbPath: string;
  retentionDays: number;
  recentLimit: number;
  cookieSecure: boolean;
}

export interface ImageRequestRecord {
  requestId: string;
  createdAt: string;
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
  imageUrls: string[];
}

export interface AdminRuntimeStats {
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
