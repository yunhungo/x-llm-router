import { calendarDateRange } from '../../../../date-range';
import type { KeyDailyModelUsage } from '../../../../types';

export interface UsageDay {
  day: string;
  date: Date;
  models: KeyDailyModelUsage[];
  totalTokens: number;
  calls: number;
  failedCalls: number;
  costUsd: number;
  future: boolean;
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function buildUsageCalendar(year: number, rows: KeyDailyModelUsage[], now = new Date()) {
  const byDay = new Map<string, KeyDailyModelUsage[]>();
  for (const row of rows) {
    const models = byDay.get(row.day) ?? [];
    models.push(row);
    byDay.set(row.day, models);
  }
  const today = localDateKey(now);
  const days: UsageDay[] = [];
  for (
    let date = new Date(year, 0, 1);
    date.getFullYear() === year;
    date = new Date(year, date.getMonth(), date.getDate() + 1)
  ) {
    const day = localDateKey(date);
    const models = [...(byDay.get(day) ?? [])].sort((a, b) => b.totalTokens - a.totalTokens);
    days.push({
      day,
      date,
      models,
      totalTokens: models.reduce((sum, model) => sum + model.totalTokens, 0),
      calls: models.reduce((sum, model) => sum + model.calls, 0),
      failedCalls: models.reduce((sum, model) => sum + model.failedCalls, 0),
      costUsd: models.reduce((sum, model) => sum + model.costUsd, 0),
      future: day > today,
    });
  }
  const offset = (days[0]!.date.getDay() + 6) % 7;
  const cells: (UsageDay | null)[] = Array.from({ length: offset }, () => null);
  cells.push(...days);
  while (cells.length % 7) cells.push(null);
  return { days, cells, weeks: cells.length / 7 };
}

export function tokenLevel(tokens: number, maxTokens: number): number {
  if (tokens <= 0 || maxTokens <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((tokens / maxTokens) * 4)));
}

export function usageDayRange(day: UsageDay) {
  return calendarDateRange(day.date, day.date);
}
