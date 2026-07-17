import Fastify from "fastify";

const host = process.env.WEBHOOK_RECEIVER_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.WEBHOOK_RECEIVER_PORT || "4090", 10);

interface ReceiverConfig {
  key: string;
  failFirst: number;
  successStatus: number;
}

interface ReceivedEvent {
  sequence: number;
  webhook_id: string;
  authorization_valid: boolean;
  type: string;
  body: unknown;
}

const receiverConfig: ReceiverConfig = {
  key: "",
  failFirst: Number.parseInt(
    process.env.WEBHOOK_RECEIVER_FAIL_FIRST || "0",
    10,
  ),
  successStatus: Number.parseInt(
    process.env.WEBHOOK_RECEIVER_SUCCESS_STATUS || "204",
    10,
  ),
};
const events: ReceivedEvent[] = [];
let attempts = 0;

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({ ok: true }));

app.get("/events", async () => ({
  attempts,
  received: events.length,
  data: events,
}));

app.delete("/events", async () => {
  attempts = 0;
  events.length = 0;
  return { ok: true };
});

app.post("/config", async (request, reply) => {
  const body = (request.body ?? {}) as {
    key?: unknown;
    fail_first?: unknown;
    success_status?: unknown;
    reset?: unknown;
  };
  if (typeof body.key === "string") {
    receiverConfig.key = body.key;
  }
  if (body.fail_first !== undefined) {
    const failFirst = Number(body.fail_first);
    if (!Number.isInteger(failFirst) || failFirst < 0 || failFirst > 100) {
      return reply
        .status(400)
        .send({ error: "fail_first must be an integer between 0 and 100" });
    }
    receiverConfig.failFirst = failFirst;
  }
  if (body.success_status !== undefined) {
    const successStatus = Number(body.success_status);
    if (
      !Number.isInteger(successStatus) ||
      successStatus < 200 ||
      successStatus > 599
    ) {
      return reply
        .status(400)
        .send({
          error: "success_status must be an HTTP status from 200 to 599",
        });
    }
    receiverConfig.successStatus = successStatus;
  }
  if (body.reset === true) {
    attempts = 0;
    events.length = 0;
  }
  return {
    ok: true,
    key_configured: receiverConfig.key !== "",
    fail_first: receiverConfig.failFirst,
    success_status: receiverConfig.successStatus,
  };
});

app.post("/webhook", async (request, reply) => {
  attempts += 1;
  const authorization = String(request.headers.authorization ?? "");
  const body = request.body as { id?: unknown; type?: unknown } | undefined;
  const authorizationValid =
    receiverConfig.key !== "" &&
    authorization === `Bearer ${receiverConfig.key}`;
  events.push({
    sequence: attempts,
    webhook_id: typeof body?.id === "string" ? body.id : "",
    authorization_valid: authorizationValid,
    type: typeof body?.type === "string" ? body.type : "",
    body: request.body,
  });
  if (events.length > 1000) {
    events.splice(0, events.length - 1000);
  }
  if (!authorizationValid) {
    return reply.status(401).send({ accepted: false });
  }
  if (attempts <= receiverConfig.failFirst) {
    return reply.status(500).send({ accepted: false, retry: true });
  }
  return reply.status(receiverConfig.successStatus).send();
});

await app.listen({ host, port });
