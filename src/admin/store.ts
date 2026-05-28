import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ImageRequestRecord } from './types.js';

interface RequestRow {
  request_id: string;
  created_at: string;
  operation: 'generation' | 'edit';
  status_code: number;
  success: 0 | 1;
  model: string | null;
  size: string | null;
  total_ms: number;
  openai_ms: number;
  decode_ms: number;
  upload_ms: number;
  image_bytes: number;
  image_count: number;
  error_code: string | null;
  image_urls_json: string;
}

export interface PaginatedImageRequests {
  data: ImageRequestRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type PaginatedImageList = PaginatedImageRequests;

export class AdminStore {
  #db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS image_requests (
        request_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        operation TEXT NOT NULL DEFAULT 'generation',
        status_code INTEGER NOT NULL,
        success INTEGER NOT NULL,
        model TEXT,
        size TEXT,
        total_ms INTEGER NOT NULL,
        openai_ms INTEGER NOT NULL,
        decode_ms INTEGER NOT NULL,
        upload_ms INTEGER NOT NULL,
        image_bytes INTEGER NOT NULL,
        image_count INTEGER NOT NULL,
        error_code TEXT,
        image_urls_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_image_requests_created_at
        ON image_requests(created_at);

      CREATE INDEX IF NOT EXISTS idx_image_requests_error_code
        ON image_requests(error_code);
    `);

    this.#ensureColumn('image_requests', 'operation', "TEXT NOT NULL DEFAULT 'generation'");
  }

  #ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) {
      return;
    }

    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  recordRequest(record: ImageRequestRecord): void {
    this.#db.prepare(`
      INSERT OR REPLACE INTO image_requests (
        request_id,
        created_at,
        operation,
        status_code,
        success,
        model,
        size,
        total_ms,
        openai_ms,
        decode_ms,
        upload_ms,
        image_bytes,
        image_count,
        error_code,
        image_urls_json
      ) VALUES (
        @request_id,
        @created_at,
        @operation,
        @status_code,
        @success,
        @model,
        @size,
        @total_ms,
        @openai_ms,
        @decode_ms,
        @upload_ms,
        @image_bytes,
        @image_count,
        @error_code,
        @image_urls_json
      )
    `).run({
      request_id: record.requestId,
      created_at: record.createdAt,
      operation: record.operation,
      status_code: record.statusCode,
      success: record.success ? 1 : 0,
      model: record.model ?? null,
      size: record.size ?? null,
      total_ms: record.totalMs,
      openai_ms: record.openaiMs,
      decode_ms: record.decodeMs,
      upload_ms: record.uploadMs,
      image_bytes: record.imageBytes,
      image_count: record.imageCount,
      error_code: record.errorCode ?? null,
      image_urls_json: JSON.stringify(record.imageUrls)
    });
  }

  cleanup(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.#db.prepare('DELETE FROM image_requests WHERE created_at < ?').run(cutoff);
    return Number(result.changes);
  }

  getRecentRequests(limit: number): ImageRequestRecord[] {
    const rows = this.#db.prepare(`
      SELECT *
      FROM image_requests
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as RequestRow[];

    return rows.map(mapRow);
  }

  getRequestsPage(page: number, pageSize: number): PaginatedImageRequests {
    return this.#getPage({
      page,
      pageSize,
      where: '',
      params: []
    });
  }

  getImagesPage(page: number, pageSize: number): PaginatedImageList {
    return this.#getPage({
      page,
      pageSize,
      where: 'WHERE image_count > 0 AND image_urls_json != ?',
      params: ['[]']
    });
  }

  #getPage({
    page,
    pageSize,
    where,
    params
  }: {
    page: number;
    pageSize: number;
    where: string;
    params: unknown[];
  }): PaginatedImageRequests {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const totalRow = this.#db.prepare(`
      SELECT COUNT(*) as total
      FROM image_requests
      ${where}
    `).get(...params) as { total: number };
    const total = Number(totalRow.total);
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const currentPage = Math.min(safePage, totalPages);
    const offset = (currentPage - 1) * safePageSize;
    const rows = this.#db.prepare(`
      SELECT *
      FROM image_requests
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
      OFFSET ?
    `).all(...params, safePageSize, offset) as RequestRow[];

    return {
      data: rows.map(mapRow),
      page: currentPage,
      pageSize: safePageSize,
      total,
      totalPages
    };
  }

  getSummary(): {
    total: number;
    success: number;
    failed: number;
    successRate: number;
    avgTotalMs: number;
    p95TotalMs: number;
    p95OpenaiMs: number;
    p95UploadMs: number;
    avgImageBytes: number;
    uploadedBytes: number;
    requestsLastHour: Array<{ minute: string; total: number; success: number; failed: number; avgTotalMs: number }>;
  } {
    const allRows = this.#db.prepare('SELECT * FROM image_requests ORDER BY created_at ASC').all() as RequestRow[];
    const recentRows = this.#db.prepare(`
      SELECT *
      FROM image_requests
      WHERE created_at >= ?
      ORDER BY created_at ASC
    `).all(new Date(Date.now() - 60 * 60 * 1000).toISOString()) as RequestRow[];

    const total = allRows.length;
    const success = allRows.filter((row) => row.success === 1).length;
    const failed = total - success;
    const totalMs = allRows.map((row) => row.total_ms);
    const openaiMs = allRows.map((row) => row.openai_ms);
    const uploadMs = allRows.map((row) => row.upload_ms);
    const imageBytes = allRows.map((row) => row.image_bytes);
    const uploadedBytes = imageBytes.reduce((sum, value) => sum + value, 0);

    const buckets = new Map<string, { total: number; success: number; failed: number; totalMs: number }>();
    for (const row of recentRows) {
      const minute = row.created_at.slice(0, 16);
      const bucket = buckets.get(minute) ?? { total: 0, success: 0, failed: 0, totalMs: 0 };
      bucket.total += 1;
      bucket.success += row.success === 1 ? 1 : 0;
      bucket.failed += row.success === 1 ? 0 : 1;
      bucket.totalMs += row.total_ms;
      buckets.set(minute, bucket);
    }

    return {
      total,
      success,
      failed,
      successRate: total === 0 ? 0 : success / total,
      avgTotalMs: average(totalMs),
      p95TotalMs: percentile(totalMs, 0.95),
      p95OpenaiMs: percentile(openaiMs, 0.95),
      p95UploadMs: percentile(uploadMs, 0.95),
      avgImageBytes: average(imageBytes),
      uploadedBytes,
      requestsLastHour: Array.from(buckets.entries()).map(([minute, bucket]) => ({
        minute,
        total: bucket.total,
        success: bucket.success,
        failed: bucket.failed,
        avgTotalMs: bucket.total === 0 ? 0 : Math.round(bucket.totalMs / bucket.total)
      }))
    };
  }

  getErrors(): Array<{ code: string; count: number; lastSeenAt: string }> {
    return this.#db.prepare(`
      SELECT error_code as code, COUNT(*) as count, MAX(created_at) as lastSeenAt
      FROM image_requests
      WHERE error_code IS NOT NULL
      GROUP BY error_code
      ORDER BY count DESC, lastSeenAt DESC
    `).all() as Array<{ code: string; count: number; lastSeenAt: string }>;
  }

  close(): void {
    this.#db.close();
  }
}

function mapRow(row: RequestRow): ImageRequestRecord {
  return {
    requestId: row.request_id,
    createdAt: row.created_at,
    operation: row.operation === 'edit' ? 'edit' : 'generation',
    statusCode: row.status_code,
    success: row.success === 1,
    model: row.model ?? undefined,
    size: row.size ?? undefined,
    totalMs: row.total_ms,
    openaiMs: row.openai_ms,
    decodeMs: row.decode_ms,
    uploadMs: row.upload_ms,
    imageBytes: row.image_bytes,
    imageCount: row.image_count,
    errorCode: row.error_code ?? undefined,
    imageUrls: safeJsonArray(row.image_urls_json)
  };
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}
