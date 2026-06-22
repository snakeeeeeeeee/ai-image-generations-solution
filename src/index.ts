import { AsyncTaskStore } from './async/store.js';
import { createQueueClients, closeQueueClients } from './async/queue.js';
import { startNotifier, type NotifierRuntime } from './async/notifier.js';
import { startAsyncWorker, type AsyncWorkerRuntime } from './async/worker.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const shouldRunApi = config.role === 'api' || config.role === 'all';
const shouldRunWorker = config.role === 'worker' || config.role === 'all';
const shouldRunNotifier = config.role === 'notifier' || config.role === 'all';
const needsAsyncInfra = shouldRunWorker || shouldRunNotifier || Boolean(config.asyncTasks.postgresUrl || config.asyncTasks.redisUrl);

if ((shouldRunWorker || shouldRunNotifier || config.role === 'all') && (!config.asyncTasks.postgresUrl || !config.asyncTasks.redisUrl)) {
  throw new Error('POSTGRES_URL and REDIS_URL are required for async task roles');
}

const asyncStore = needsAsyncInfra ? new AsyncTaskStore(config.asyncTasks.postgresUrl) : undefined;
const queueClients = needsAsyncInfra ? createQueueClients(config) : undefined;
if (asyncStore) {
  await asyncStore.migrate();
}

const app = shouldRunApi ? buildServer(config, {
  asyncTaskStore: asyncStore,
  queueClients
}) : undefined;
let workerRuntime: AsyncWorkerRuntime | undefined;
let notifierRuntime: NotifierRuntime | undefined;

try {
  if (app) {
    await app.listen({
      host: config.host,
      port: config.port
    });
  }

  if (shouldRunWorker && asyncStore && queueClients) {
    workerRuntime = startAsyncWorker({
      config,
      store: asyncStore,
      taskQueue: queueClients.taskQueue
    });
  }

  if (shouldRunNotifier && asyncStore) {
    notifierRuntime = startNotifier({
      config,
      store: asyncStore
    });
  }
} catch (error) {
  app?.log.error(error);
  console.error(error);
  process.exit(1);
}

async function shutdown(): Promise<void> {
  await notifierRuntime?.close();
  await workerRuntime?.close();
  await app?.close();
  if (queueClients && !app) {
    await closeQueueClients(queueClients);
  }
  if (asyncStore && !app) {
    await asyncStore.close();
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
