# Mapped Gemini Models And Async Failure Log Design

## Problem

Gemini image tasks currently reuse the mapped upstream model for three different
purposes:

- public capability validation;
- credential lease protocol selection;
- upstream endpoint construction.

This rejects a supported public model when a Gemini channel maps it to a
different upstream model name. Separately, a terminally failed asynchronous
image task refunds correctly but leaves its original precharge log with the
normal consume type.

## Model Responsibilities

The implementation keeps the three identities separate:

- `OriginModelName` and image-handle `task.model` are the public model. They
  control public capability validation, request validation, and billing.
- The selected channel type controls the credential lease request format.
- `ImageCredentialLease.Model` is the mapped upstream model. It is used only
  for the provider endpoint, request model, rate limiting, and audit metadata.

For Gemini channels, new-api validates the public model against the supported
Gemini image models, resolves the Gemini API version from that public model,
and inserts the opaque mapped lease model into the `generateContent` endpoint.
image-handle validates the public task model and executes the mapped lease
model.

## Failure Log Semantics

The existing terminal consume-log snapshot gains a log type. A missing or zero
type remains backward-compatible and means `LogTypeConsume`. A terminal image
failure stores `LogTypeError`; successful settlement stores or defaults to
`LogTypeConsume`.

Finalization updates the original precharge row in one guarded write. It may
only target consume or error, and it accepts an existing consume row so the
transition is exactly `consume -> consume/error`. It does not create a refund
row, preserving the current single-row audit, callback idempotency, and
fast-callback reconciliation behavior.

## Compatibility

No environment variable, database column, public task response, callback
payload, or webhook event changes. OpenAI/XAI requests still execute the model
from the lease. Unsupported public Gemini models remain rejected even if a
channel maps them to a supported-looking upstream name.

## Verification

- mapped Gemini sync and async requests keep the public task model;
- Gemini leases use the mapped upstream endpoint and model;
- unsupported public Gemini models are rejected before provider execution;
- image-handle accepts an arbitrary mapped lease model for a supported public
  Gemini task and rejects an unsupported public task model;
- terminal callback, dispatch failure, and polling failure change the original
  log to error without adding a second log;
- successful and legacy terminal snapshots remain consume logs;
- GPT/OpenAI image tests remain unchanged and pass.
