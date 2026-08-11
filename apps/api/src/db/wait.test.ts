import { describe, expect, it, vi } from 'vitest';

import { waitForDatabase } from './wait';

describe('waitForDatabase', () => {
  it('waits until the database accepts a connection', async () => {
    const check = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('starting'))
      .mockRejectedValueOnce(new Error('starting'))
      .mockResolvedValue();
    const delay = vi.fn(async () => undefined);

    await waitForDatabase({ attempts: 3, intervalMs: 25, check, delay });

    expect(check).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 25);
  });

  it('reports the last connection error after the retry budget is exhausted', async () => {
    const connectionError = new Error('connection refused');
    const check = vi.fn<() => Promise<void>>().mockRejectedValue(connectionError);

    await expect(
      waitForDatabase({ attempts: 2, intervalMs: 0, check, delay: async () => undefined }),
    ).rejects.toMatchObject({
      message: 'Database did not become ready after 2 attempts.',
      cause: connectionError,
    });
  });
});
