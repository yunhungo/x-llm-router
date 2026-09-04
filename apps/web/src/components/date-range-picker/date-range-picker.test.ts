import { describe, expect, it } from 'vitest';

import { calendarMonthDays } from '.';

describe('calendarMonthDays', () => {
  it('builds a six-week Monday-first calendar grid', () => {
    const days = calendarMonthDays(new Date(2026, 7, 1));

    expect(days).toHaveLength(42);
    expect(days[0]?.getDay()).toBe(1);
    expect(days[0]?.getFullYear()).toBe(2026);
    expect(days[0]?.getMonth()).toBe(6);
    expect(days[0]?.getDate()).toBe(27);
    expect(days.at(-1)?.getMonth()).toBe(8);
    expect(days.at(-1)?.getDate()).toBe(6);
  });
});
