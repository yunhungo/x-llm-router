/**
 * @created 2026-09-22
 * @description 以固定 6.7 汇率展示人民币，保留既有美元账本精度。
 * @author yunhungo
 */
import { CNY_PER_USD } from '@x-router/contracts';
export const currency = 'CNY';
export const fromUsd = (amount: number): number => amount * CNY_PER_USD;
export const toUsd = (amount: number): number => amount / CNY_PER_USD;
const formatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency,
  minimumFractionDigits: 4,
  maximumFractionDigits: 8,
});
export const money = { format: (amount: number): string => formatter.format(fromUsd(amount)) };
