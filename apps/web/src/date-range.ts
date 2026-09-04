/** ISO timestamps for a half-open interval: from is inclusive, to is exclusive. */
export interface DateRange {
  from: string;
  to: string;
}

export function dateRangeError(range: DateRange): string {
  if (!range.from || !range.to) return '请选择完整的开始和结束时间。';
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '时间格式无效。';
  if (from >= to) return '开始时间必须早于结束时间。';
  return '';
}

export function relativeDateRange(days: number, now = new Date()): DateRange {
  return {
    from: new Date(now.getTime() - days * 86_400_000).toISOString(),
    to: now.toISOString(),
  };
}

/** Both calendar dates are included, using local midnights across DST changes. */
export function calendarDateRange(start: Date, end: Date): DateRange {
  const [first, last] = start <= end ? [start, end] : [end, start];
  return {
    from: new Date(first.getFullYear(), first.getMonth(), first.getDate()).toISOString(),
    to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).toISOString(),
  };
}
