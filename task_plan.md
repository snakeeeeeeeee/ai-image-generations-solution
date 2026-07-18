# Task Plan

Goal: build a TypeScript OpenAI-compatible image generation wrapper service that proxies requests to new-api, converts upstream `b64_json` images into R2-hosted PNG URLs, and returns URL responses to clients.

Completed scope: a horizontally scalable async image task execution mode for new-api using PostgreSQL as the task fact store, Redis/BullMQ for queues and flow control, Docker Compose deployment, and durable callback notification.

## Phases

- [complete] Phase 1: Scaffold TypeScript Node service and configuration
- [complete] Phase 2: Implement `/v1/images/generations` proxy and R2 upload
- [complete] Phase 3: Add operational docs and nginx example
- [complete] Phase 4: Verify startup and basic behavior
- [complete] Phase 5: Add local smoke-test helper
- [complete] Phase 6: Add admin local image upload to R2 and show uploaded URLs in the panel
- [complete] Phase 7: Add multi-node async task API, PostgreSQL fact store, Redis/BullMQ queue, worker, notifier, Docker Compose, docs, and verification
- [complete] Phase 8: Switch async execution from new_api_internal to provider_direct_lease while preserving synchronous image endpoints
- [complete] Phase 9: Verify image pricing parameter contracts across synchronous/asynchronous generation/edit flows and lease-model override
- [complete] Phase 10: Pass through HTTP(S) output URLs without download/R2, retain base64 upload behavior, preserve signed queries, and complete live Adobe URL acceptance
- [complete] Phase 11: Add semantic async request fingerprints, persist provider options, secure image URL downloads, and complete new-api gateway integration

## Decisions

- External clients continue using their existing new-api `Authorization: Bearer ...` key.
- The wrapper service only uploads images and replaces `b64_json` with public URLs.
- Default output format is PNG, matching current product preference.
- R2 objects use the `images/YYYY/MM/DD/{uuid}.png` key prefix so the configured R2 lifecycle rule deletes them after 1 day.
- Public image base URL is configured through `R2_PUBLIC_URL`.
- Use TypeScript source files and compile to `dist/` for production.
- Admin local uploads should reuse the existing generated-image R2 key rule, including UTC `images/YYYY/MM/DD/{uuid}.{ext}` directories.
- Admin local uploads should be recorded in the existing admin image/request tables as `manual_upload` so the panel can show URLs after upload.
- Async image tasks use PostgreSQL as the source of truth; Redis is only queue, rate limit, coordination, and short-lived state.
- new-api owns user billing; image-handle only records execution state and notifies terminal success/failure.
- Multi-node scale-out requires API, worker, and notifier roles to be stateless and connected to shared PostgreSQL, Redis, R2, and upstream config.
- `provider_api_key + client_task_id` is the async submission idempotency key.
- Deployment assets live under `deploy/`. `docker-compose.dev.yml` is for source-tree dev builds; `docker-compose.prod.yml` and `docker-compose.worker.yml` are image-based production files that can run from a copied deploy folder.
- Async image tasks now use `executor.type=provider_direct_lease`; workers resolve a short-lived credential lease from new-api and then call OpenAI-compatible upstreams directly.
- Old `new_api_internal` is removed from the async execution path only; synchronous `/v1/images/generations` and `/v1/images/edits` remain unchanged.
- `image-handle` remains pricing-agnostic; this phase only verifies normalized `quality`, `size`, `resolution`, and `n` forwarding plus lease-selected upstream model behavior.
- Output handling is source-based and configuration-free: parsed HTTP(S) URLs pass through, while `b64_json` continues decode/validation/R2 upload.
- URL normalization only replaces a residual literal `\\u0026` with `&`; percent-encoded signature bytes and query ordering are never decoded or rebuilt.

## Phase 12: Simplified new-api Webhook receiver fixture

- [complete] Replace the local third-party receiver's HMAC verification with `Authorization: Bearer` verification.
- [complete] Preserve configurable failure/success responses and event capture for retry E2E.
- [complete] Run the full image-handle test/build and shared-network new-api integration.

## Errors Encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
| TypeScript inferred `buildImageKey` id as UUID template type | `npm test` attempt 1 | Annotated `id` parameter as `string` because object key IDs do not need UUID-only typing |
| TypeScript did not narrow `server.address()` enough in integration test | `npm test` attempt 2 | Added `AddressInfo` import and explicit local `port` extraction after runtime object assertion |
| R2 smoke test returned `SignatureDoesNotMatch` | Local R2 upload attempt | `.env` used the wrong Cloudflare token type as `R2_SECRET_ACCESS_KEY`; replace with the S3 `机密访问密钥` |
| UI skill script path in `.codex/skills` was not a directory | Admin upload UI planning | Used the `.agents/skills/ui-ux-pro-max` script path and applied its React form accessibility guidance |
| Docker Compose build stalled on base-image metadata pull | `docker compose -f docker-compose.dev.yml build` | Stopped after repeated waits with no progress; compose configs validate, but a rebuild can still depend on Docker Hub availability |
| Docker Compose build failed on Docker Hub auth token fetch | `docker compose -f docker-compose.dev.yml build` from `deploy/` | Stopped per blocker policy. Error: `failed to fetch oauth token ... i/o timeout`; npm tests, TypeScript build, and compose config validation passed |
| Docker Compose dev build failed on Docker Hub auth token fetch | `docker compose -f deploy/docker-compose.dev.yml --env-file deploy/.env.example build` | Stopped per blocker policy. Error: `node:22-bookworm-slim: failed to authorize ... auth.docker.io/token ... i/o timeout`; npm tests, full build, and compose config validation passed |
| TypeScript compile required the new persisted fingerprint on the shared task fixture | Phase 11 build attempt 1 | Add the deterministic fixture value and focused fingerprint/provider-options tests before rerunning. |
| Docker diagnostic queried nonexistent `async_tasks` instead of the actual `image_tasks` table | 1 | List PostgreSQL tables and query the real image task table on the next check. |
| Pinned-download reproduction imported `/app/dist/safe-url.js`, but compiled sources live under a different dist path | 1 | Inspect the runtime dist tree and rerun against the actual module path. |
| First pinned-fetch regression returned `ECONNREFUSED ::1` because the fixture server listened only on IPv4 while one pinned DNS address was returned | 1 | Return the complete already-validated DNS result for Undici `all:true` lookups, preserving pinning while enabling IPv4/IPv6 fallback. |
