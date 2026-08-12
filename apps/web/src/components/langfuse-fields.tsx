import { Plus, Trash2 } from 'lucide-react';

import type { LangfuseConfig } from '../types';
import { Field, Input } from './ui';

export interface LangfuseDraft {
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

export function LangfuseFields({
  value,
  onChange,
  hasSecretKey = false,
  switchLabel = 'Langfuse',
  switchHint = '此 Key 的独立项目',
}: {
  value: LangfuseDraft;
  onChange: (value: LangfuseDraft) => void;
  hasSecretKey?: boolean;
  switchLabel?: string;
  switchHint?: string;
}) {
  return (
    <div className="langfuse-fields">
      <label className="switch-row compact">
        <div>
          <strong>{switchLabel}</strong>
          <span>{switchHint}</span>
        </div>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        <i />
      </label>
      {value.enabled ? (
        <>
          <div className="form-grid">
            <Field label="Public Key">
              <Input
                value={value.publicKey}
                onChange={(event) => onChange({ ...value, publicKey: event.target.value })}
                placeholder="pk-lf-…"
                required
              />
            </Field>
            <Field label="Secret Key" {...(hasSecretKey ? { hint: '留空保持不变' } : {})}>
              <Input
                type="password"
                value={value.secretKey}
                onChange={(event) => onChange({ ...value, secretKey: event.target.value })}
                placeholder={hasSecretKey ? '••••••••' : 'sk-lf-…'}
                required={!hasSecretKey}
              />
            </Field>
          </div>
          <Field
            label="Base URL"
            hint="必须与项目区域一致：EU cloud.langfuse.com，US us.cloud.langfuse.com"
          >
            <Input
              type="url"
              value={value.baseUrl}
              onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
              required
            />
          </Field>
          <Field label="Environment">
            <Input
              value={value.environment}
              onChange={(event) => onChange({ ...value, environment: event.target.value })}
              placeholder="production"
              required
            />
          </Field>
          <div className="form-grid">
            <Field label="Trace Name" hint="留空时按 API 端点命名">
              <Input
                value={value.traceName}
                onChange={(event) => onChange({ ...value, traceName: event.target.value })}
                placeholder="llm-gateway"
              />
            </Field>
            <Field label="Version" hint="用于比较版本变更">
              <Input
                value={value.version}
                onChange={(event) => onChange({ ...value, version: event.target.value })}
                placeholder="2026.08.11"
              />
            </Field>
          </div>
          <Field label="Tags" hint="用逗号分隔，适合低基数业务维度">
            <Input
              value={value.tags}
              onChange={(event) => onChange({ ...value, tags: event.target.value })}
              placeholder="gateway, production"
            />
          </Field>
          <div className="form-grid">
            <Field label="User ID Header" hint="缺失时使用当前 API Key 的稳定身份，不会逐请求随机">
              <Input
                value={value.userIdHeader}
                onChange={(event) => onChange({ ...value, userIdHeader: event.target.value })}
                placeholder="x-user-id"
              />
            </Field>
            <Field label="Session ID Header" hint="缺失时不创建伪 Session；应由客户端传会话 ID">
              <Input
                value={value.sessionIdHeader}
                onChange={(event) => onChange({ ...value, sessionIdHeader: event.target.value })}
                placeholder="x-session-id"
              />
            </Field>
          </div>
          <div className="langfuse-capture-options">
            <label>
              <input
                type="checkbox"
                checked={value.captureInput}
                onChange={(event) => onChange({ ...value, captureInput: event.target.checked })}
              />
              <span>记录请求 Input</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={value.captureOutput}
                onChange={(event) => onChange({ ...value, captureOutput: event.target.checked })}
              />
              <span>记录响应 Output</span>
            </label>
          </div>
          <div className="langfuse-metadata-editor">
            <div className="langfuse-section-heading">
              <div>
                <strong>自定义 Metadata</strong>
                <span>按 Langfuse metadata 字符串键值传入</span>
              </div>
              <button
                type="button"
                className="button button-secondary langfuse-add-field"
                onClick={() =>
                  onChange({ ...value, metadata: [...value.metadata, { key: '', value: '' }] })
                }
              >
                <Plus size={13} /> 添加字段
              </button>
            </div>
            {value.metadata.map((entry, index) => (
              <div className="langfuse-metadata-row" key={index}>
                <Input
                  value={entry.key}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      metadata: value.metadata.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, key: event.target.value } : item,
                      ),
                    })
                  }
                  placeholder="字段名，例如 tenant"
                  aria-label={`Metadata 字段 ${index + 1} 名称`}
                  required
                />
                <Input
                  value={entry.value}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      metadata: value.metadata.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, value: event.target.value } : item,
                      ),
                    })
                  }
                  placeholder="字段值"
                  aria-label={`Metadata 字段 ${index + 1} 值`}
                />
                <button
                  type="button"
                  className="icon-button danger-icon"
                  onClick={() =>
                    onChange({
                      ...value,
                      metadata: value.metadata.filter((_, itemIndex) => itemIndex !== index),
                    })
                  }
                  aria-label={`删除 Metadata 字段 ${index + 1}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
