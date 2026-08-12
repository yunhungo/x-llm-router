import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BUILD_SHA: z.string().trim().min(1).max(128).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .url()
      .transform((value) => new URL(value).origin)
      .optional(),
  ),
  WEB_ROOT: z.string().min(1).optional(),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  INITIAL_ADMIN_USERNAME: z.string().min(1).default('admin'),
  INITIAL_ADMIN_PASSWORD: z.string().min(8).default('change-me-now'),
  OPENAI_API_BASE: z.string().url().default('https://api.openai.com/v1'),
  CHATGPT_API_BASE: z.string().url().default('https://chatgpt.com/backend-api/codex'),
  CHATGPT_AUTH_BASE: z.string().url().default('https://auth.openai.com'),
  OPENAI_CODEX_CLIENT_VERSION: z.string().trim().min(1).default('0.147.0'),
});

export type AppConfig = z.infer<typeof configSchema>;

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    const parsed = configSchema.safeParse(process.env);
    if (!parsed.success) {
      const details = parsed.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      );
      throw new Error(`Invalid environment configuration:\n${details.join('\n')}`);
    }
    cachedConfig = parsed.data;
  }
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}
