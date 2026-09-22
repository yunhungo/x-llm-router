/**
 * @created 2026-09-22
 * @description 验证历史费用与人民币预算按固定汇率换算。
 * @author yunhungo
 */
import { describe, expect, it } from 'vitest';
import { fromUsd, money, toUsd } from './currency';

describe('fixed CNY accounting', () => {
  it('converts historical USD amounts at 6.7 without mutating their ledger value', () => {
    expect(fromUsd(1)).toBe(6.7);
    expect(money.format(1)).toBe('¥6.7000');
    expect(money.format(0.00011116)).toBe('¥0.00074477');
  });
  it('round-trips CNY budgets and prices and preserves a free amount', () => {
    expect(toUsd(67)).toBe(10);
    expect(fromUsd(toUsd(0.00139))).toBeCloseTo(0.00139, 12);
    expect(money.format(0)).toBe('¥0.0000');
  });
});
