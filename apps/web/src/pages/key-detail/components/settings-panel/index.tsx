import type { FormEvent } from 'react';
import { Check, Save } from 'lucide-react';

import { LangfuseFields, type LangfuseDraft } from '../../../../components/langfuse-fields';
import { Button, Field, Input } from '../../../../components/ui';
import { ModelPricingSettings } from '../../../../features/model-pricing/model-pricing-settings';
import type { Provider, VirtualKey } from '../../../../types';
import type { GeneralDraft } from '../../key-detail-model';
import './settings-panel.css';

interface SettingsPanelProps {
  apiKey: VirtualKey;
  providers: Provider[];
  generalSettings: GeneralDraft;
  onGeneralSettingsChange: (settings: GeneralDraft) => void;
  generalChanged: boolean;
  savingGeneral: boolean;
  onSaveGeneral: (event: FormEvent<HTMLFormElement>) => void;
  langfuseSettings: LangfuseDraft;
  onLangfuseSettingsChange: (settings: LangfuseDraft) => void;
  langfuseChanged: boolean;
  savingLangfuse: boolean;
  onSaveLangfuse: (event: FormEvent<HTMLFormElement>) => void;
  savedSettings: 'general' | 'langfuse' | undefined;
}

export function SettingsPanel({
  apiKey,
  providers,
  generalSettings,
  onGeneralSettingsChange,
  generalChanged,
  savingGeneral,
  onSaveGeneral,
  langfuseSettings,
  onLangfuseSettingsChange,
  langfuseChanged,
  savingLangfuse,
  onSaveLangfuse,
  savedSettings,
}: SettingsPanelProps) {
  const pricingProviders = apiKey.providerConnectionId
    ? providers.filter((provider) => provider.id === apiKey.providerConnectionId)
    : providers;

  return (
    <div
      id="key-panel-settings"
      className="key-tab-panel"
      role="tabpanel"
      aria-labelledby="key-tab-settings"
    >
      <div className="key-settings-grid">
        <section className="panel settings-section">
          <div className="panel-heading compact-panel-heading settings-section-heading">
            <h2>基本设置</h2>
            <Button
              type="submit"
              form="key-general-settings-form"
              loading={savingGeneral}
              disabled={!generalChanged}
              aria-label="保存基本设置"
            >
              {savedSettings === 'general' && !generalChanged ? (
                <Check size={13} />
              ) : (
                <Save size={13} />
              )}
              {savedSettings === 'general' && !generalChanged ? '已保存' : '保存'}
            </Button>
          </div>
          <form
            id="key-general-settings-form"
            className="settings-section-body"
            onSubmit={onSaveGeneral}
          >
            <div className="general-settings-grid">
              <div className="general-setting-wide">
                <Field label="名称">
                  <Input
                    value={generalSettings.name}
                    onChange={(event) =>
                      onGeneralSettingsChange({
                        ...generalSettings,
                        name: event.target.value,
                      })
                    }
                    required
                  />
                </Field>
              </div>
              <Field label="RPM" helpText="0 表示不限制">
                <Input
                  type="number"
                  min={0}
                  max={100_000}
                  value={generalSettings.rpmLimit}
                  onChange={(event) =>
                    onGeneralSettingsChange({
                      ...generalSettings,
                      rpmLimit: event.target.value,
                    })
                  }
                  required
                />
              </Field>
              <Field label="预算 USD">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={generalSettings.budgetUsd}
                  onChange={(event) =>
                    onGeneralSettingsChange({
                      ...generalSettings,
                      budgetUsd: event.target.value,
                    })
                  }
                  placeholder="无限制"
                />
              </Field>
              <div className="general-setting-wide">
                <Field label="上游连接">
                  <select
                    className="input"
                    value={generalSettings.providerConnectionId}
                    onChange={(event) =>
                      onGeneralSettingsChange({
                        ...generalSettings,
                        providerConnectionId: event.target.value,
                      })
                    }
                  >
                    <option value="">自动路由</option>
                    {providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="general-setting-wide">
                <Field label="到期时间" helpText="留空表示永不过期">
                  <Input
                    type="datetime-local"
                    value={generalSettings.expiresAt}
                    onChange={(event) =>
                      onGeneralSettingsChange({
                        ...generalSettings,
                        expiresAt: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
            </div>
          </form>
        </section>

        <section className="panel settings-section langfuse-settings-section">
          <div className="panel-heading compact-panel-heading settings-section-heading">
            <div className="langfuse-section-title">
              <h2>Langfuse</h2>
              <label className="switch-row langfuse-header-switch">
                <input
                  type="checkbox"
                  checked={langfuseSettings.enabled}
                  onChange={(event) =>
                    onLangfuseSettingsChange({
                      ...langfuseSettings,
                      enabled: event.target.checked,
                    })
                  }
                  aria-label="启用 Langfuse"
                />
                <i />
              </label>
            </div>
            <Button
              type="submit"
              form="key-langfuse-settings-form"
              loading={savingLangfuse}
              disabled={!langfuseChanged}
              aria-label="保存 Langfuse 设置"
            >
              {savedSettings === 'langfuse' && !langfuseChanged ? (
                <Check size={13} />
              ) : (
                <Save size={13} />
              )}
              {savedSettings === 'langfuse' && !langfuseChanged ? '已保存' : '保存'}
            </Button>
          </div>
          <form
            id="key-langfuse-settings-form"
            className="settings-section-body"
            onSubmit={onSaveLangfuse}
          >
            <LangfuseFields
              value={langfuseSettings}
              onChange={onLangfuseSettingsChange}
              hasSecretKey={apiKey.langfuse.hasSecretKey}
              showEnabledSwitch={false}
            />
          </form>
        </section>

        <ModelPricingSettings keyId={apiKey.id} providers={pricingProviders} />
      </div>
    </div>
  );
}
