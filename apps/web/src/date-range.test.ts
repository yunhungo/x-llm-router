import { describe, expect, it } from 'vitest';

import { calendarDateRange, dateRangeError, relativeDateRange } from './date-range';

describe('shared date ranges', () => {
  it('includes the entire final calendar day and handles reverse selection', () => {
    const start = new Date(2026, 7, 31);
    const end = new Date(2026, 8, 2);
    const expected = {
      from: start.toISOString(),
      to: new Date(2026, 8, 3).toISOString(),
    };
    expect(calendarDateRange(start, end)).toEqual(expected);
    expect(calendarDateRange(end, start)).toEqual(expected);
  });

  it('supports a single day using the next local midnight', () => {
    // This date crosses the daylight-saving boundary in America/New_York.
    const day = new Date(2026, 2, 8);
    expect(calendarDateRange(day, day)).toEqual({
      from: day.toISOString(),
      to: new Date(2026, 2, 9).toISOString(),
    });
  });

  it('keeps shortcuts as exact rolling durations', () => {
    const now = new Date('2026-09-04T04:30:00.000Z');
    expect(relativeDateRange(7, now)).toEqual({
      from: '2026-08-28T04:30:00.000Z',
      to: now.toISOString(),
    });
  });

  it('validates missing, invalid and reversed timestamps', () => {
    const range = relativeDateRange(1);
    expect(dateRangeError(range)).toBe('');
    expect(dateRangeError({ ...range, to: '' })).toContain('完整');
    expect(dateRangeError({ ...range, from: 'invalid' })).toContain('无效');
    expect(dateRangeError({ from: range.to, to: range.from })).toContain('早于');
    expect(dateRangeError({ from: range.to, to: range.to })).toContain('早于');
  });
});
