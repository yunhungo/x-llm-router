/**
 * @created 2026-10-26
 * @description 定时同步账号模型目录，限制批次并在应用关闭时取消任务。
 * @author yunhungo
 */
import type { FastifyInstance } from 'fastify';

import { getConfig } from '../config';
import { getPool } from '../db/client';
import { refreshProviderModels } from './providers';

const SCAN_INTERVAL_MS = 30_000;
const MAX_BATCH_SIZE = 20;

interface SyncSummary {
  refreshed: number;
  failed: number;
}

let pending: Promise<SyncSummary> | undefined;
let batchController: AbortController | undefined;

export function syncProviderModelCatalogs(
  options: {
    maxAgeSeconds?: number;
    signal?: AbortSignal;
  } = {},
): Promise<SyncSummary> {
  if (pending) return pending;
  const controller = new AbortController();
  batchController = controller;
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const task = async (): Promise<SyncSummary> => {
    const maxAge = options.maxAgeSeconds ?? getConfig().MODEL_SYNC_INTERVAL_SECONDS;
    const result = await getPool().query<{ id: string }>(
      `SELECT id FROM provider_connections
        WHERE status = 'active'
          AND (auth_type = 'oauth' OR provider IN ('openai', 'custom'))
          AND (models_checked_at IS NULL OR models_checked_at <= now() - $1 * interval '1 second')
        ORDER BY models_checked_at ASC NULLS FIRST, created_at ASC
        LIMIT $2`,
      [maxAge, MAX_BATCH_SIZE],
    );
    const summary = { refreshed: 0, failed: 0 };
    for (const { id } of result.rows) {
      if (signal.aborted) break;
      try {
        await refreshProviderModels(id, signal);
        if (signal.aborted) break;
        summary.refreshed += 1;
      } catch {
        if (signal.aborted) break;
        // Per-connection errors are persisted by refreshProviderModels; keep processing others.
        summary.failed += 1;
      }
    }
    return summary;
  };
  pending = task().finally(() => {
    pending = undefined;
    batchController = undefined;
  });
  return pending;
}

export function createProviderModelSyncWorker(warn: () => void): {
  start: () => void;
  stop: () => Promise<void>;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  const run = (): void => {
    running = (async () => {
      try {
        await syncProviderModelCatalogs({ signal: controller.signal });
      } catch {
        // Do not log upstream payloads, credentials, or database query parameters.
        if (!controller.signal.aborted) warn();
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(run, SCAN_INTERVAL_MS);
          timer.unref();
        }
      }
    })();
  };

  return {
    start: () => {
      if (!running && !controller.signal.aborted) run();
    },
    stop: async () => {
      controller.abort();
      batchController?.abort();
      if (timer) clearTimeout(timer);
      await pending?.catch(() => undefined);
      await running;
    },
  };
}

export function registerProviderModelSync(app: FastifyInstance): void {
  const worker = createProviderModelSyncWorker(() =>
    app.log.warn('模型目录自动同步暂时失败，稍后重试。'),
  );
  app.addHook('onListen', async () => {
    worker.start();
  });
  app.addHook('onClose', () => worker.stop());
}
