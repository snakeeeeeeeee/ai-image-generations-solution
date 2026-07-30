import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  registerMediaUploadRoutes,
  type MediaUploadObjectStore,
  type MediaUploadSessionStore,
} from "../src/async/media-uploads.js";
import type { AppConfig } from "../src/config.js";

type StoredSession = Awaited<ReturnType<MediaUploadSessionStore["get"]>>;

class MemorySessions implements MediaUploadSessionStore {
  readonly values = new Map<string, NonNullable<StoredSession>>();

  async get(id: string): Promise<StoredSession> {
    return this.values.get(id);
  }

  async set(session: NonNullable<StoredSession>): Promise<void> {
    this.values.set(session.id, structuredClone(session));
  }

  async delete(id: string): Promise<void> {
    this.values.delete(id);
  }
}

class MemoryObjects implements MediaUploadObjectStore {
  readonly heads = new Map<string, { sizeBytes: number; mimeType: string }>();
  readonly deleted: string[] = [];

  async presignPut(key: string): Promise<string> {
    return `https://r2.example.com/presigned/${encodeURIComponent(key)}`;
  }

  async head(key: string): Promise<{ sizeBytes: number; mimeType: string }> {
    const value = this.heads.get(key);
    if (!value) {
      throw new Error("not found");
    }
    return value;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
}

function config(): AppConfig {
  return {
    asyncTasks: { providerApiKeys: ["provider-test-key"] },
    r2: {
      bucket: "test",
      publicUrl: "https://media.example.com",
      keyPrefix: "images",
      cacheControl: "public, max-age=86400",
    },
  } as AppConfig;
}

test("media upload sessions presign direct PUTs and complete from HEAD metadata", async () => {
  const app = Fastify({ logger: false });
  const sessions = new MemorySessions();
  const objects = new MemoryObjects();
  registerMediaUploadRoutes(app, { config: config(), sessions, objects });

  const create = await app.inject({
    method: "POST",
    url: "/internal/v1/media/uploads",
    headers: { authorization: "Bearer provider-test-key" },
    payload: {
      owner_id: "user-7",
      files: [
        {
          client_id: "video-1",
          kind: "video",
          filename: "clip.mp4",
          mime_type: "video/mp4",
          size_bytes: 4096,
        },
      ],
    },
  });
  assert.equal(create.statusCode, 200);
  const created = create.json() as {
    object: string;
    data: Array<{
      id: string;
      upload_url: string;
      headers: Record<string, string>;
    }>;
  };
  assert.equal(created.object, "media.upload.session.list");
  assert.equal(created.data.length, 1);
  assert.match(
    created.data[0]!.upload_url,
    /^https:\/\/r2\.example\.com\/presigned\//,
  );
  assert.equal(created.data[0]!.headers["Content-Type"], "video/mp4");

  const stored = await sessions.get(created.data[0]!.id);
  assert.ok(stored);
  assert.equal(stored.url, undefined);
  objects.heads.set(stored.key, { sizeBytes: 4096, mimeType: "video/mp4" });

  const complete = await app.inject({
    method: "POST",
    url: "/internal/v1/media/uploads/complete",
    headers: { authorization: "Bearer provider-test-key" },
    payload: { owner_id: "user-7", upload_ids: [stored.id] },
  });
  assert.equal(complete.statusCode, 200);
  const completed = complete.json() as {
    data: Array<{
      url: string;
      kind: string;
      size_bytes: number;
      temporary: boolean;
    }>;
  };
  assert.match(
    completed.data[0]!.url,
    /^https:\/\/media\.example\.com\/images\/media\/tmp\/uploads\//,
  );
  assert.equal(completed.data[0]!.kind, "video");
  assert.equal(completed.data[0]!.size_bytes, 4096);
  assert.equal(completed.data[0]!.temporary, true);

  const replay = await app.inject({
    method: "POST",
    url: "/internal/v1/media/uploads/complete",
    headers: { authorization: "Bearer provider-test-key" },
    payload: { owner_id: "user-7", upload_ids: [stored.id] },
  });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), complete.json());
  await app.close();
});

test("media upload completion deletes objects whose metadata does not match", async () => {
  const app = Fastify({ logger: false });
  const sessions = new MemorySessions();
  const objects = new MemoryObjects();
  registerMediaUploadRoutes(app, { config: config(), sessions, objects });

  const create = await app.inject({
    method: "POST",
    url: "/internal/v1/media/uploads",
    headers: { authorization: "Bearer provider-test-key" },
    payload: {
      owner_id: "user-8",
      files: [{ kind: "audio", mime_type: "audio/mpeg", size_bytes: 100 }],
    },
  });
  const id = (create.json() as { data: Array<{ id: string }> }).data[0]!.id;
  const stored = await sessions.get(id);
  assert.ok(stored);
  objects.heads.set(stored.key, { sizeBytes: 101, mimeType: "audio/mpeg" });

  const complete = await app.inject({
    method: "POST",
    url: "/internal/v1/media/uploads/complete",
    headers: { authorization: "Bearer provider-test-key" },
    payload: { owner_id: "user-8", upload_ids: [id] },
  });
  assert.equal(complete.statusCode, 400);
  assert.equal(
    (complete.json() as { error: { code: string } }).error.code,
    "media_upload_verification_failed",
  );
  assert.deepEqual(objects.deleted, [stored.key]);
  assert.equal(await sessions.get(id), undefined);
  await app.close();
});

test("media upload sessions enforce kind counts and per-file limits", async () => {
  const app = Fastify({ logger: false });
  registerMediaUploadRoutes(app, {
    config: config(),
    sessions: new MemorySessions(),
    objects: new MemoryObjects(),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/v1/media/uploads",
    headers: { authorization: "Bearer provider-test-key" },
    payload: {
      owner_id: "user-9",
      files: Array.from({ length: 4 }, (_, index) => ({
        client_id: `video-${index}`,
        kind: "video",
        mime_type: "video/mp4",
        size_bytes: 1024,
      })),
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "media_count_exceeded",
  );
  await app.close();
});
