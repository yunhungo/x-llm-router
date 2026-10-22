/**
 * @created 2026-10-22
 * @description 验证观测目标切换时清理凭据并正确判断已保存密钥的复用范围。
 * @author yunhungo
 */
import { describe, expect, it } from 'vitest';

import {
  canReuseTelemetrySecret,
  changeTelemetryTarget,
  emptyLangfuse,
  langfuseDraft,
} from './model';
import type { LangfuseConfig } from '@/types';

const saved: LangfuseConfig = {
  target: 'langfuse',
  enabled: true,
  publicKey: 'pk-project',
  hasSecretKey: true,
  baseUrl: 'https://example.test/',
  environment: 'production',
  traceName: '',
  version: '',
  tags: [],
  metadata: {},
  userIdHeader: 'x-user-id',
  sessionIdHeader: 'x-session-id',
  captureInput: true,
  captureOutput: true,
  restartRequiredAfterSave: false,
};

describe('observation destination drafts', () => {
  it('clears credentials and requires an instance address when switching to X-Otel', () => {
    const value = { ...langfuseDraft(saved), secretKey: 'unsaved-secret' };
    const next = changeTelemetryTarget(value, 'x-otel');
    expect(next).toMatchObject({ target: 'x-otel', publicKey: '', secretKey: '', baseUrl: '' });
    expect(next.environment).toBe(value.environment);
    expect(next.captureInput).toBe(value.captureInput);
    expect(canReuseTelemetrySecret(next, saved)).toBe(false);
  });

  it('keeps drafts unchanged when selecting the same target', () => {
    const value = emptyLangfuse();
    expect(changeTelemetryTarget(value, 'langfuse')).toBe(value);
  });

  it('matches normalized URLs but invalidates a saved secret after destination changes', () => {
    const value = langfuseDraft(saved);
    expect(canReuseTelemetrySecret({ ...value, baseUrl: 'https://EXAMPLE.test' }, saved)).toBe(
      true,
    );
    expect(canReuseTelemetrySecret({ ...value, target: 'x-otel' }, saved)).toBe(false);
    expect(canReuseTelemetrySecret({ ...value, baseUrl: 'https://different.test' }, saved)).toBe(
      false,
    );
    expect(canReuseTelemetrySecret({ ...value, publicKey: 'pk-other' }, saved)).toBe(false);
    expect(canReuseTelemetrySecret({ ...value, baseUrl: '' }, saved)).toBe(false);
  });
});
