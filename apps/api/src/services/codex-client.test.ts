/**
 * @created 2026-10-26
 * @description 验证稳定客户端版本自动更新、缓存、故障回退与固定配置。
 * @author yunhungo
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Codex stable client metadata', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgresql://example');
    vi.stubEnv('OPENAI_CODEX_CLIENT_VERSION', 'auto');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('shares a version check and refreshes metadata after one hour', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.170.0' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.171.0' })));
    vi.stubGlobal('fetch', fetchMock);
    const client = await import('./codex-client');
    const versions = await Promise.all([
      client.resolveCodexClientVersion(),
      client.resolveCodexClientVersion(),
    ]);
    expect(versions.map((v) => v.version)).toEqual(['0.170.0', '0.170.0']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ accept: 'application/json' });
    expect(client.codexClientHeaders().version).toBe('0.170.0');
    await client.resolveCodexClientVersion();
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await expect(client.resolveCodexClientVersion()).resolves.toEqual({
      version: '0.171.0',
      warning: null,
    });
  });

  it('keeps the last version after an outage and retries after five minutes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.170.0' })))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.171.0' })));
    vi.stubGlobal('fetch', fetchMock);
    const client = await import('./codex-client');
    await client.resolveCodexClientVersion();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await expect(client.resolveCodexClientVersion()).resolves.toMatchObject({
      version: '0.170.0',
      warning: expect.any(String),
    });
    await client.resolveCodexClientVersion();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(client.resolveCodexClientVersion()).resolves.toEqual({
      version: '0.171.0',
      warning: null,
    });
  });

  it('honors an explicit version without accessing the registry', async () => {
    vi.stubEnv('OPENAI_CODEX_CLIENT_VERSION', '0.164.0');
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = await import('./codex-client');
    await expect(client.resolveCodexClientVersion()).resolves.toEqual({
      version: '0.164.0',
      warning: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a prerelease as the stable client version', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ version: '0.999.0-beta.1' }))),
    );
    const client = await import('./codex-client');
    await expect(client.resolveCodexClientVersion()).resolves.toMatchObject({
      version: '0.164.0',
      warning: expect.any(String),
    });
  });

  it('uses the connection’s persisted version when the first check after restart fails', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));
    const client = await import('./codex-client');
    await expect(client.resolveCodexClientVersion('0.180.0')).resolves.toMatchObject({
      version: '0.180.0',
      warning: expect.any(String),
    });
  });
});
