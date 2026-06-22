import { createHmac } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import type { AppConfig } from '../config.js';
import type { AsyncTaskStore } from './store.js';
import type { CallbackEventRecord } from './types.js';

interface CallbackResultItem {
  event_id?: string;
  task_id?: string;
  client_task_id?: string;
  provider_task_id?: string;
  status?: string;
}

export interface NotifierRuntime {
  close: () => Promise<void>;
}

export function startNotifier({
  config,
  store
}: {
  config: AppConfig;
  store: AsyncTaskStore;
}): NotifierRuntime {
  let closed = false;
  let running = false;

  const interval = setInterval(() => {
    if (running || closed) {
      return;
    }
    running = true;
    void flushCallbacks({ config, store })
      .catch((error) => {
        console.error('callback notifier flush failed', error);
      })
      .finally(() => {
        running = false;
      });
  }, config.asyncTasks.callbackFlushMs);
  interval.unref();

  return {
    close: async () => {
      closed = true;
      clearInterval(interval);
    }
  };
}

export async function flushCallbacks({
  config,
  store
}: {
  config: AppConfig;
  store: AsyncTaskStore;
}): Promise<void> {
  const events = await store.claimCallbackEvents(config.asyncTasks.callbackBatchSize);
  if (events.length === 0) {
    return;
  }

  const groups = groupEvents(events);
  for (const group of groups) {
    await sendGroup({ config, store, events: group });
  }
}

function groupEvents(events: CallbackEventRecord[]): CallbackEventRecord[][] {
  const groups = new Map<string, CallbackEventRecord[]>();
  for (const event of events) {
    const target = event.batch_callback_url || event.callback_url;
    const key = `${target}\n${event.secret_id || ''}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function sendGroup({
  config,
  store,
  events
}: {
  config: AppConfig;
  store: AsyncTaskStore;
  events: CallbackEventRecord[];
}): Promise<void> {
  const first = events[0];
  if (!first) {
    return;
  }
  const target = first.batch_callback_url || first.callback_url;
  const payload = first.batch_callback_url ? {
    events: events.map((event) => ({
      event_id: event.event_id,
      ...event.payload
    }))
  } : {
    event_id: first.event_id,
    ...first.payload
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = getCallbackSecret(config, first.secret_id);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  try {
    const response = await undiciFetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-callback-timestamp': timestamp,
        'x-callback-signature': signature,
        'x-callback-event-id': first.event_id,
        'x-callback-secret-id': first.secret_id || ''
      },
      body: rawBody
    });

    if (!response.ok) {
      await store.rescheduleCallbackEvents(
        events.map((event) => event.event_id),
        retryDelayMs(events),
        config.asyncTasks.callbackMaxRetryAgeHours
      );
      return;
    }

    const acceptedIds = await parseAcceptedEventIds(response, events);
    const accepted = new Set(acceptedIds);
    await store.markCallbackDelivered([...accepted]);
    const retryIds = events.map((event) => event.event_id).filter((id) => !accepted.has(id));
    await store.rescheduleCallbackEvents(retryIds, retryDelayMs(events), config.asyncTasks.callbackMaxRetryAgeHours);
  } catch {
    await store.rescheduleCallbackEvents(
      events.map((event) => event.event_id),
      retryDelayMs(events),
      config.asyncTasks.callbackMaxRetryAgeHours
    );
  }
}

async function parseAcceptedEventIds(response: Response, events: CallbackEventRecord[]): Promise<string[]> {
  const text = await response.text();
  if (!text) {
    return events.map((event) => event.event_id);
  }

  try {
    const body = JSON.parse(text) as { results?: CallbackResultItem[]; code?: string };
    if (!Array.isArray(body.results)) {
      return events.map((event) => event.event_id);
    }
    const byTask = new Map(events.map((event) => [event.client_task_id, event.event_id]));
    const byProvider = new Map(events.map((event) => [event.provider_task_id, event.event_id]));
    const byEvent = new Set(events.map((event) => event.event_id));
    const accepted = new Set<string>();
    for (const item of body.results) {
      if (item.status !== 'accepted' && item.status !== 'ignored_terminal') {
        continue;
      }
      if (item.event_id && byEvent.has(item.event_id)) {
        accepted.add(item.event_id);
        continue;
      }
      const providerId = item.provider_task_id && byProvider.get(item.provider_task_id);
      if (providerId) {
        accepted.add(providerId);
        continue;
      }
      const clientId = (item.client_task_id || item.task_id) && byTask.get(String(item.client_task_id || item.task_id));
      if (clientId) {
        accepted.add(clientId);
      }
    }
    return [...accepted];
  } catch {
    return events.map((event) => event.event_id);
  }
}

function getCallbackSecret(config: AppConfig, secretId: string | undefined): string {
  if (secretId && config.asyncTasks.callbackSecrets[secretId]) {
    return config.asyncTasks.callbackSecrets[secretId];
  }
  return config.asyncTasks.callbackDefaultSecret || 'local-callback-secret';
}

function retryDelayMs(events: CallbackEventRecord[]): number {
  const maxAttempts = Math.max(1, ...events.map((event) => event.attempts));
  return Math.min(24 * 60 * 60 * 1000, 10_000 * 2 ** Math.min(maxAttempts - 1, 10));
}
