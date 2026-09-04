import { describe, expect, it } from 'vitest';
import type { KeyDailyModelUsage } from '../../../../types';
import { buildUsageCalendar, tokenLevel, usageDayRange } from './heatmap-model';

const row: KeyDailyModelUsage = {
  day: '2024-02-29',
  provider: 'openai',
  model: 'shared-model',
  calls: 2,
  failedCalls: 1,
  totalTokens: 150,
  inputTokens: 100,
  outputTokens: 50,
  cachedInputTokens: 20,
  reasoningTokens: 10,
  costUsd: 0.001,
};

describe('daily token calendar', () => {
  it('includes leap days, pads full weeks, and keeps providers with the same model separate', () => {
    const calendar = buildUsageCalendar(
      2024,
      [row, { ...row, provider: 'custom', totalTokens: 300 }],
      new Date(2024, 3, 1),
    );
    expect(calendar.days).toHaveLength(366);
    expect(calendar.cells.length % 7).toBe(0);
    const day = calendar.days.find((day) => day.day === '2024-02-29')!;
    expect(day.totalTokens).toBe(450);
    expect(day.calls).toBe(4);
    expect(day.failedCalls).toBe(2);
    expect(day.models.map((model) => model.provider)).toEqual(['custom', 'openai']);
    // Cached and reasoning tokens are subsets; they must not inflate totals.
    expect(day.totalTokens).not.toBe(510);
  });

  it('shows empty days and prevents future dates without depending on data presence', () => {
    const { days, cells } = buildUsageCalendar(2026, [], new Date(2026, 0, 2));
    expect(days).toHaveLength(365);
    expect(cells.slice(0, 3)).toEqual([null, null, null]);
    expect(days[0]).toMatchObject({ calls: 0, totalTokens: 0, models: [], future: false });
    expect(days[1]?.future).toBe(false);
    expect(days[2]?.future).toBe(true);
  });

  it('uses local midnight boundaries including daylight saving transitions', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const { days } = buildUsageCalendar(2026, [], new Date(2027, 0, 1));
      const spring = usageDayRange(days.find((day) => day.day === '2026-03-08')!);
      const autumn = usageDayRange(days.find((day) => day.day === '2026-11-01')!);
      expect(spring).toEqual({ from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' });
      expect(Date.parse(autumn.to) - Date.parse(autumn.from)).toBe(25 * 3_600_000);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('distinguishes zero and positive token usage without assigning a color to empty years', () => {
    expect([0, 1, 25, 26, 50, 51, 75, 76, 100].map((tokens) => tokenLevel(tokens, 100))).toEqual([
      0, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
    expect(tokenLevel(0, 0)).toBe(0);
  });
});
