import { z } from 'zod';

export const modelPriceKeySchema = z.object({
  provider: z.string().trim().min(1).max(40).default('*'),
  modelPattern: z.string().trim().min(1).max(120),
});

export const modelPriceInputSchema = modelPriceKeySchema.extend({
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
