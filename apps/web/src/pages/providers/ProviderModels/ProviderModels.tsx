/**
 * @created 2026-10-26
 * @description 展示模型目录来源、同步时间、兼容提示与失败恢复操作。
 * @author yunhungo
 */
import { RefreshCcw } from 'lucide-react';

import { Button } from '@/components/ui';
import type { Provider } from '@/types';
import { ProviderModelList } from '../ProviderModelList/ProviderModelList';
import './ProviderModels.scss';

const sourceLabels = {
  openai: '账号实时目录',
  codex: 'Codex 兼容目录',
  upstream: '上游实时目录',
  builtin: '内置模型目录',
};

export function ProviderModels({
  provider,
  revision,
  refreshing,
  onRefresh,
}: {
  provider: Provider;
  revision: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const autoSync =
    provider.authType === 'oauth' || ['openai', 'custom'].includes(provider.provider);
  return (
    <section className="provider-models" aria-label={`${provider.name} 可用模型`}>
      <div className="provider-models-heading">
        <div>
          <strong>可用模型 · {provider.models.length}</strong>
          <span>
            {provider.modelsRefreshedAt
              ? `上次成功同步 ${new Date(provider.modelsRefreshedAt).toLocaleString('zh-CN')}`
              : '尚未成功同步'}
          </span>
          <span>
            {provider.modelsSource ? sourceLabels[provider.modelsSource] : '等待查询上游目录'}
            {provider.modelsClientVersion ? ` · 客户端 ${provider.modelsClientVersion}` : ''}
            {autoSync && provider.status === 'active' ? ' · 后台自动同步' : ''}
          </span>
        </div>
        <Button
          variant="ghost"
          loading={refreshing}
          disabled={provider.status !== 'active'}
          onClick={onRefresh}
        >
          <RefreshCcw size={13} /> 刷新
        </Button>
      </div>
      {provider.modelsRefreshError ? (
        <p className="provider-models-error" role="status">
          同步失败：{provider.modelsRefreshError}
          {provider.modelsCheckedAt
            ? ` 最近尝试 ${new Date(provider.modelsCheckedAt).toLocaleString('zh-CN')}。`
            : ''}
        </p>
      ) : provider.modelsRefreshWarning ? (
        <p className="provider-models-warning" role="status">
          {provider.modelsRefreshWarning}
        </p>
      ) : null}
      {provider.models.length ? (
        <ProviderModelList provider={provider} revision={revision} />
      ) : (
        <p>
          {provider.modelsRefreshedAt && !provider.modelsRefreshError
            ? '上游当前没有可展示的模型。'
            : '等待自动同步，或点击刷新立即查询。'}
        </p>
      )}
    </section>
  );
}
