import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(256),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(256),
  newUsername: z.string().trim().min(1).max(80).optional(),
  newPassword: z.string().min(12).max(256),
});

export const langfuseSettingsSchema = z.object({
  enabled: z.boolean(),
  publicKey: z.string().trim().max(255),
  secretKey: z.string().trim().max(512).optional(),
  baseUrl: z.string().url(),
  environment: z.string().trim().min(1).max(40),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  budgetUsd: z.number().nonnegative().nullable().optional(),
  rpmLimit: z.number().int().positive().max(100_000).default(60),
  expiresAt: z.string().datetime().nullable().optional(),
  providerConnectionId: z.string().uuid().nullable().optional(),
  langfuse: langfuseSettingsSchema.optional(),
});

export const createProviderApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
    .default('openai'),
  apiKey: z.string().min(12),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().trim().min(1).max(120).optional(),
  priority: z.number().int().min(0).max(10_000).default(100),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type CreateProviderApiKeyInput = z.infer<typeof createProviderApiKeySchema>;
export type LangfuseSettingsInput = z.infer<typeof langfuseSettingsSchema>;

export interface SessionUser {
  id: string;
  username: string;
}

export interface DashboardSummary {
  calls: number;
  successfulCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  averageLatencyMs: number;
}

export interface UsagePoint {
  bucket: string;
  calls: number;
  tokens: number;
  costUsd: number;
}
