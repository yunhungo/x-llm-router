/**
 * @created 2026-08-26
 * @description 负责上游模型价格规则的维护与计费。
 * @author yunhungo
 */
import { z } from 'zod';

// Existing USD ledger values retain their original meaning; all UI amounts use this fixed rate.
export const CNY_PER_USD = 6.7;

export const modelPriceKeySchema = z.object({
  provider: z.string().trim().min(1).max(40).default('*'),
  modelPattern: z.string().trim().min(1).max(120),
});

export const modelPriceInputSchema = modelPriceKeySchema.extend({
  currency: z.literal('CNY').default('CNY'),
  inputPerMillion: z.number().nonnegative(),
  cachedInputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
});

export type ModelPriceKeyInput = z.infer<typeof modelPriceKeySchema>;
export type ModelPriceInput = z.infer<typeof modelPriceInputSchema>;

export interface ModelPriceRule extends ModelPriceInput {
  updatedAt: string;
}

export interface ModelPriceListResponse {
  prices: ModelPriceRule[];
}
