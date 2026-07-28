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

## Phase 13: Node-aware worker scheduling and observability

- [complete] Add stable worker node identity and advertised IP validation to configuration and Redis heartbeats.
- [complete] Add PostgreSQL task assignment/version fields, scheduler state, assignment-safe mutations, and indexes.
- [complete] Replace the shared worker queue with per-node queues and an API-owned advisory-lock scheduler.
- [complete] Add offline-node reassignment, stale-processing recovery, and node-local queued-task recovery.
- [complete] Aggregate node queues and worker instances in the admin API; show node ID, advertised IP, runtime details, and assigned task node in the UI.
- [complete] Update deployment examples and operator documentation for the two required per-node variables.
- [complete] Add scheduling, concurrency, stale-assignment, recovery, migration, and UI coverage.
- [complete] Run the full test/build suite, diff checks, Docker Compose validation, and desktop/mobile browser QA.

### Phase 13 decisions

**Status:** complete

- Each physical node uses one stable `WORKER_NODE_ID`; multiple worker processes on that node share `image-tasks-<WORKER_NODE_ID>`.
- The API writes tasks as `submitted`, then assigns them under a PostgreSQL advisory transaction lock using live Redis node heartbeats.
- Node load is `(queued + processing) / sum(min(worker concurrency, image-processing concurrency))`.
- Equal-load nodes are ordered by persistent `last_assignment_seq`, then node ID for deterministic rotation.
- `assigned_node_id` is admin-only metadata; external task responses and callback payloads remain unchanged.
- Queued assignments can move immediately when a node is offline; processing assignments move only after the existing stale timeout.
- Rollout assumes the legacy shared queue is drained during a short submission pause; no dual-queue compatibility path is added.

## Phase 14: Admin operations console redesign

- [complete] Replace the two-tab page shell with adaptive operations navigation and a compact top bar.
- [complete] Separate overview, synchronous interface, asynchronous tasks, image records, and system tools into focused views.
- [complete] Rework worker nodes into compact operational rows with collapsed instance diagnostics.
- [complete] Limit each node preview to three current tasks and show the remaining active count.
- [complete] Refine tables, metrics, spacing, contrast, focus states, and responsive behavior.
- [complete] Run the full test/build suite and populated desktop/mobile browser QA.

### Phase 14 decisions

**Status:** complete

- Preserve synchronous and asynchronous operation as separate primary destinations.
- Keep the admin API and all public protocols unchanged; this phase is a frontend information-architecture refactor.
- Show no more than three current tasks per node while retaining the exact aggregate active task count.
- Move drain mode and manual R2 upload into a dedicated system-tools view.
- Use a desktop navigation rail and a compact top navigation grid on narrow screens.

## Phase 15: Gemini Images provider adapter and unified public contract

- [complete] Add `gemini_generate_content` credential leases without changing existing OpenAI/XAI lease execution.
- [complete] Add strict Gemini request/parameter validation, generation/edit payloads, image extraction, usage normalization, and raw-response redaction.
- [complete] Extend new-api synchronous/async image contracts, Gemini channel lease resolution, and usage-based terminal settlement.
- [complete] Update the provider-neutral Resource Center/OpenAPI documentation and add the structured `gemini-new` documentation set.
- [complete] Run full image-handle, new-api, and supertokendoc builds/tests plus real Gemini acceptance and GPT-Image regression.

### Phase 15 decisions

**Status:** complete

- Supported upstream models are `gemini-3.1-flash-image` and `gemini-3-pro-image-count`.
- Public task, asset, callback, Webhook, idempotency, scheduling, and billing lifecycles remain provider-neutral.
- Gemini differences are isolated to lease resolution, request building, parameter validation, response extraction, error mapping, and usage normalization.
- Gemini produces exactly one PNG image per task, supports generation and image editing, and rejects masks.
- Existing Gemini native/Chat and GPT-Image paths remain compatible; no new database fields or environment variables are introduced.
- Rollout order is image-handle first, new-api second, and documentation last.

## Phase 16: Mapped Gemini models and async failure log severity

- [complete] Separate public model validation, channel protocol selection, and mapped upstream model execution in new-api.
- [complete] Make image-handle validate the public task model while executing the mapped lease model.
- [complete] Mark terminally failed asynchronous image task logs as error logs after refund settlement.
- [complete] Add mapped-model, unsupported-public-model, synchronous/asynchronous, billing-log, and GPT/OpenAI regression coverage.
- [complete] Run complete image-handle and new-api test/build verification.
- [complete] Rebuild both local Docker images and verify mapped Gemini success, terminal failure/refund, error-log severity, usage, and runtime cleanup end to end.

### Phase 16 decisions

**Status:** complete

- The public model name owns capability validation and billing semantics.
- The selected channel type owns the credential lease request format.
- The mapped upstream model name is opaque and is used only for the upstream endpoint/model.
- A terminal asynchronous image failure must update its persisted new-api consume log to error severity after refund; accepted or still-running tasks remain normal.
- Failure severity is carried in the existing terminal consume-log snapshot and applied atomically to the original precharge row, preserving the single-row audit and fast-callback reconciliation design.
- No new environment variables, manual mapped-model allowlists, or database fields are introduced.

## Phase 17: First-class Gemini resolution and aspect ratio

- [complete] Validate the provider-neutral field names and the capability boundary shared by Google Gemini and We-AI Adobe Gemini.
- [complete] Add first-class synchronous, asynchronous JSON, and multipart resolution/aspect-ratio fields while preserving existing `size` and `provider_options`.
- [complete] Expand Gemini resolution support and retain channel-safe ratio validation.
- [complete] Update request fingerprints, OpenAPI, Resource Center, and supertokendoc examples.
- [complete] Run image-handle, new-api, documentation, Docker, real Gemini, negative-validation, and GPT-Image regression verification.

### Phase 17 decisions

**Status:** complete

- Promote resolution tier and aspect ratio to provider-neutral public output controls; reserve `provider_options` for provider-specific advanced options.
- Keep `size` as a backward-compatible convenience mapping, but document that Gemini output pixels are not exact.
- Treat the shared Google/We-AI capability intersection as the reliable public contract unless the user explicitly chooses a broader best-effort contract.
- Preserve `provider_options.google.generationConfig.imageConfig` for compatibility with existing clients and the We-AI Adobe Gemini dialect.
- Preserve the existing unified `1:1/1K` default to avoid an implicit cost increase.
- Accept `0.5K` as a public alias and normalize it to the We-AI wire value `512`.

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
| Initial mapped-Gemini Docker harness read `.task_id`, used host port 3000, and polled with a model token | Phase 16 Docker acceptance | Use the public response `.id`, the compose-published host port 3001, and the existing Resource Center key for task reads; keep the model token only for submission. |
| Pinned-download reproduction imported `/app/dist/safe-url.js`, but compiled sources live under a different dist path | 1 | Inspect the runtime dist tree and rerun against the actual module path. |
| First pinned-fetch regression returned `ECONNREFUSED ::1` because the fixture server listened only on IPv4 while one pinned DNS address was returned | 1 | Return the complete already-validated DNS result for Undici `all:true` lookups, preserving pinning while enabling IPv4/IPv6 fallback. |
| Phase 13 first TypeScript check found node aggregate fields on the per-instance heartbeat interface and old test route fixtures | 1 | Move aggregate-only fields to `WorkerNodeHeartbeat`, then update task fixtures and route scheduler stubs before rerunning. |
| Phase 14 findings update targeted a heading not present in the flat findings file | 1 | Located the existing Phase 14 bullets and inserted the design-system decisions beside them. |
| Browser binding did not expose `browser.documentation.get(...)` | 1 | Read the packaged CDP capability guide directly and continue with `tab.capabilities.get("cdp")`. |
| Browser safety layer rejected an untyped `Fetch.enable` pattern | 1 | Narrow the local mock interception to explicit `Fetch` and `XHR` resource types so document navigation is never intercepted. |
| Browser mock retry referenced a cursor that the rejected setup never initialized | 1 | Declare the event cursor, navigation promise, and handled count inside the narrowed retry call. |
| Browser mock loop timed out waiting for eight requests | 1 | The target differed only by hash and did not reload the app. Reconnect after the automatic kernel reset and navigate with a unique query string to force a full load. |
| Reconnected CDP interception received an invalid stale interception id | 1 | Stop the unstable interception approach after three distinct failures. Serve the built admin UI and fixture endpoints from a disposable local read-only preview server instead. |
| Browser `getByLabel("自动刷新")` did not resolve the visible select | 1 | Take a fresh DOM snapshot and use the stable unique `.refresh-select select` selector from the rendered markup. |
| Planning completion script reported zero completed phases | 1 | The long-lived plan used checklist statuses instead of the script's marker. Added explicit completion markers to the two level-three phase-decision sections it detects. |
| Focused new-api tests retained legacy expectations that Gemini channels and multipart `provider_options` were unsupported | 1 | Updated those expectations and added target-model/Imagen routing plus JSON/multipart provider-options coverage. |
| Real Gemini Pro async acceptance precharged the same 50000 quota as the cheaper Flash fixed-price model | 1 | `applyAsyncImageUsagePrecharge` overwrote the per-model `ModelPrice` result with the global per-image estimate. Preserve fixed-price and image-pricing results; apply the usage estimate only to token-priced models. |
| New token-pricing precharge unit test resolved `n=1` instead of `n=2` | 1 | The direct fixture bypassed adaptor normalization, while production reads normalized `metadata.n`. Populate `metadata.n` in the fixture and retain `N` as the public input. |
| `bun run build` at the new-api repository root reported `Script not found "build"` | 1 | The frontend is a separate `web/` workspace. Read its package scripts and run the build from that directory. |
| Package-script inspection tried to require a nonexistent root `package.json` | 1 | new-api's Go root has no Node manifest; inspect and build only `web/package.json`. |
| `bun run openapi:check` reported `docs/openapi/resource-center.json is out of date` | 1 | Gemini additions were applied to the generated JSON but not its generator source. Move the schema/example changes into the source consumed by `generate-resource-center-openapi.mjs`, regenerate, and rerun the check. |
| zsh rejected `status` in the Docker health polling loop as a read-only variable | 1 | Rename the local shell variable to `health_state`; this did not affect the recreated container. |
| Asset acceptance query compared varchar `assets.task_id` with bigint `tasks.id` | 1 | Query Assets by the public string task ID directly; the mismatch was limited to diagnostic SQL. |
| Real fixed-price Gemini task kept correct quota but its consume-log token columns remained zero | 1 | The fixed-price success branch returned before merging normalized usage into the original consume log. Add a provider-neutral fixed-price image usage audit merge without recalculating quota. |
| GPT synchronous `response_format=b64_json` returned one result without `b64_json` | 1 | URL mode and usage succeeded, but the regression script stopped before edit. Inspect new-api/image-handle response-format normalization and result conversion before deciding whether this is a request-shape issue or a behavioral regression. |
| Queried `image_tasks` in the new-api PostgreSQL container | 1 | The table belongs to `image-handle-dev-image-handle-postgres-1`; switched subsequent diagnostics to the correct container. |
| Queried nonexistent `result_data_format` task column | 1 | The persisted format lives in task metadata/parameters; queried `parameters_json.response_format` and result shape instead. |
| Queried JSON paths on the text `logs.other` column | 1 | This diagnostic was unnecessary after the channel override directly identified the runtime format mutation; do not repeat it. |
| Base64 regression shell was rejected before execution because cleanup used `rm -f` | 1 | Switched temporary-file cleanup to single-file `unlink`; the guarded request then completed and restored channel configuration. |
| GPT async diagnostic selected nonexistent `tasks.model` and `tasks.group_name` columns | 2 | Asset, consume-log, public task, and Webhook checks already supplied the required acceptance evidence; inspect the schema before any further task-table query. |
| Mapped sync payload test reused the GPT seed-cleanup fixture and unexpectedly retained `provider_options.seed` | 1 | Restored the original GPT fixture and added a separate mapped-model payload test so the two behaviors are isolated. |
| Broad test expectation patch changed the wrong identical `payload["model"]` assertion | 2 | Inspected both exact line contexts and updated the unmapped and mapped expectations independently. |
| Real Gemini validation returned internal HTTP 400 but the public relay response was wrapped as generic HTTP 500 | 1 | Mark locally constructed Gemini validation errors as explicitly client-safe; controller tests prove their code/param pass through while unmarked upstream errors with the same code remain masked. |
| Docker validation script cleanup used forbidden generic `rm -f` | 1 | No request was sent; reran with `unlink` for the two exact temporary files. |
