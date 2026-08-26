import { z } from 'zod';

export * from './model-pricing';

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
  environment: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(
      /^(?!langfuse)[a-z0-9][a-z0-9_-]*$/,
      'Environment 只能包含小写字母、数字、连字符或下划线，且不能以 langfuse 开头。',
    ),
  traceName: z.string().trim().max(200).default(''),
  version: z.string().trim().max(120).default(''),
  tags: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  metadata: z
    .record(z.string().trim().min(1).max(120), z.string().max(200))
    .refine((value) => Object.keys(value).length <= 20, 'Metadata 最多支持 20 个字段。')
    .default({}),
  userIdHeader: z
    .string()
    .trim()
    .toLowerCase()
    .max(120)
    .regex(/^[!#$%&'*+.^_`|~0-9a-z-]*$/, 'User ID Header 不是有效的 HTTP Header 名称。')
    .default('x-user-id'),
  sessionIdHeader: z
    .string()
    .trim()
    .toLowerCase()
    .max(120)
    .regex(/^[!#$%&'*+.^_`|~0-9a-z-]*$/, 'Session ID Header 不是有效的 HTTP Header 名称。')
    .default('x-session-id'),
  captureInput: z.boolean().default(true),
  captureOutput: z.boolean().default(true),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  budgetUsd: z.number().nonnegative().nullable().optional(),
  rpmLimit: z.number().int().nonnegative().max(100_000).default(60),
  expiresAt: z.string().datetime().nullable().optional(),
  providerConnectionId: z.string().uuid().nullable().optional(),
  langfuse: langfuseSettingsSchema.optional(),
});

export const createProviderApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  apiMode: z.enum(['responses', 'chat.completions']),
  apiKey: z.string().min(12),
  baseUrl: z.string().url(),
  defaultModel: z.string().trim().min(1).max(120).optional(),
  priority: z.number().int().min(0).max(10_000).default(100),
});

export const updateProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    apiMode: z.enum(['responses', 'chat.completions']).optional(),
    apiKey: z.string().min(12).optional(),
    baseUrl: z.string().url().optional(),
    defaultModel: z.string().trim().max(120).nullable().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少提供一个可更新字段。',
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type CreateProviderApiKeyInput = z.infer<typeof createProviderApiKeySchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;
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
