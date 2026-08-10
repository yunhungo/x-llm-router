import { describe, expect, it } from 'vitest';

import { tokensPerSecond } from './key-analytics';

describe('key analytics metrics', () => {
  it('calculates generation TPS after TTFT', () => {
    expect(tokensPerSecond(120, 2_500, 500)).toBe(60);
  });

  it('returns null when generation duration is unavailable', () => {
    expect(tokensPerSecond(0, 1_000, 200)).toBeNull();
    expect(tokensPerSecond(20, 200, 200)).toBeNull();
  });
});
