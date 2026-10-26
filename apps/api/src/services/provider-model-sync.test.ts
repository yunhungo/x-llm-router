/**
 * @created 2026-10-26
 * @description 验证模型后台同步的批次、失败隔离、重入保护及启停。
 * @author yunhungo
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, refreshProviderModels } = vi.hoisted(() => ({
  query: vi.fn(),
  refreshProviderModels: vi.fn(),
}));
vi.mock('../db/client', () => ({ getPool: () => ({ query }) }));
vi.mock('./providers', () => ({ refreshProviderModels }));

import { resetConfigForTests } from '../config';
import { createProviderModelSyncWorker, syncProviderModelCatalogs } from './provider-model-sync';

describe('automatic model synchronization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('DATABASE_URL', 'postgresql://example');
    vi.stubEnv('MODEL_SYNC_INTERVAL_SECONDS', '300');
    resetConfigForTests();
    query.mockReset();
    refreshProviderModels.mockReset();
    query.mockResolvedValue({ rows: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetConfigForTests();
  });

  it('selects only active, due connections in a bounded batch and isolates failures', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'first' }, { id: 'second' }] });
    refreshProviderModels.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    await expect(syncProviderModelCatalogs()).resolves.toEqual({ refreshed: 1, failed: 1 });
    expect(query.mock.calls[0]?.[0]).toContain("status = 'active'");
    expect(query.mock.calls[0]?.[0]).toContain('models_checked_at <=');
    expect(query.mock.calls[0]?.[1]).toEqual([300, 20]);
    expect(refreshProviderModels.mock.calls.map(([id]) => id)).toEqual(['first', 'second']);
  });

  it('coalesces simultaneous page and scheduled sync passes', async () => {
    const results = await Promise.all([
      syncProviderModelCatalogs({ maxAgeSeconds: 60 }),
      syncProviderModelCatalogs(),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([60, 20]);
  });

  it('scans on startup and every thirty seconds, then stops cleanly', async () => {
    const worker = createProviderModelSyncWorker(vi.fn());
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(query).toHaveBeenCalledTimes(2);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('retries a failed scan rather than stopping the worker', async () => {
    query.mockRejectedValueOnce(new Error('database unavailable'));
    const warn = vi.fn();
    const worker = createProviderModelSyncWorker(warn);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(query).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('cancels an in-flight pass at shutdown without starting the next connection', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'slow' }, { id: 'next' }] });
    refreshProviderModels.mockImplementationOnce(
      (_id: string, signal: AbortSignal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({}), { once: true }),
        ),
    );
    const worker = createProviderModelSyncWorker(vi.fn());
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await worker.stop();
    expect(refreshProviderModels).toHaveBeenCalledOnce();
  });
});
