/**
 * @created 2026-10-22
 * @description 管理观测配置草稿、目标切换与凭据复用条件。
 * @author yunhungo
 */
import type { LangfuseConfig } from '@/types';

export interface LangfuseDraft {
  target: 'langfuse' | 'x-otel';
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment: string;
  traceName: string;
  version: string;
  tags: string;
  metadata: Array<{ key: string; value: string }>;
  userIdHeader: string;
  sessionIdHeader: string;
  captureInput: boolean;
  captureOutput: boolean;
}

export const emptyLangfuse = (): LangfuseDraft => ({
  target: 'langfuse',
  enabled: false,
  publicKey: '',
  secretKey: '',
  baseUrl: 'https://cloud.langfuse.com',
  environment: 'production',
  traceName: '',
  version: '',
  tags: 'gateway',
  metadata: [],
  userIdHeader: 'x-user-id',
  sessionIdHeader: 'x-session-id',
  captureInput: true,
  captureOutput: true,
});

export function langfuseDraft(config: LangfuseConfig): LangfuseDraft {
  return {
    target: config.target ?? 'langfuse',
    enabled: Boolean(config.enabled),
    publicKey: config.publicKey ?? '',
    secretKey: '',
    baseUrl: config.baseUrl ?? 'https://cloud.langfuse.com',
    environment: config.environment ?? 'production',
    traceName: config.traceName ?? '',
    version: config.version ?? '',
    tags: config.tags?.join(', ') ?? 'gateway',
    metadata: Object.entries(config.metadata ?? {}).map(([key, value]) => ({ key, value })),
    userIdHeader: config.userIdHeader ?? 'x-user-id',
    sessionIdHeader: config.sessionIdHeader ?? 'x-session-id',
    captureInput: config.captureInput ?? true,
    captureOutput: config.captureOutput ?? true,
  };
}

export function langfusePayload(value: LangfuseDraft) {
  return {
    ...value,
    tags: [
      ...new Set(
        value.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ],
    metadata: Object.fromEntries(
      value.metadata
        .map((entry) => [entry.key.trim(), entry.value] as const)
        .filter(([key]) => Boolean(key)),
    ),
  };
}

export function telemetryTargetName(target: LangfuseDraft['target']): string {
  return target === 'x-otel' ? 'X-Otel' : 'Langfuse';
}

export function changeTelemetryTarget(
  value: LangfuseDraft,
  target: LangfuseDraft['target'],
): LangfuseDraft {
  if (value.target === target) return value;
  return {
    ...value,
    target,
    baseUrl: target === 'langfuse' ? 'https://cloud.langfuse.com' : '',
    publicKey: '',
    secretKey: '',
  };
}

export function canReuseTelemetrySecret(value: LangfuseDraft, saved: LangfuseConfig): boolean {
  try {
    const normalize = (url: string): string => new URL(url.trim()).toString().replace(/\/+$/, '');
    return (
      saved.hasSecretKey &&
      value.target === (saved.target ?? 'langfuse') &&
      value.publicKey.trim() === saved.publicKey &&
      normalize(value.baseUrl) === normalize(saved.baseUrl)
    );
  } catch {
    return false;
  }
}
