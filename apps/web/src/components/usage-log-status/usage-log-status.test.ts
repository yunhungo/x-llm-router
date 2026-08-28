import { describe, expect, it } from 'vitest';

import { isUsageLogActive } from '.';

describe('usage log status', () => {
  it('only treats lifecycle phases as active', () => {
    expect(isUsageLogActive('processing')).toBe(true);
    expect(isUsageLogActive('thinking')).toBe(true);
    expect(isUsageLogActive('responding')).toBe(true);
    expect(isUsageLogActive('completed')).toBe(false);
    expect(isUsageLogActive('failed')).toBe(false);
  });
});
