import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../../../api';
import { Button, Skeleton } from '../../../../components/ui';
import type { KeyDailyUsageResponse } from '../../../../types';
import {
  modelIdentity,
  parseModelIdentity,
  type AnalyticsModelOption,
  type LogDrilldown,
} from '../../key-detail-model';
import { TokenHeatmapCalendar } from './calendar';
import './token-heatmap.css';

interface TokenHeatmapProps {
  keyId: string;
  selectedModel: string;
  refreshKey: number;
  onDrilldown: (drilldown: LogDrilldown) => void;
  onModelsLoaded: (options: AnalyticsModelOption[]) => void;
}

export function TokenHeatmap({
  keyId,
  selectedModel,
  refreshKey,
  onDrilldown,
  onModelsLoaded,
}: TokenHeatmapProps) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ query: string; data: KeyDailyUsageResponse }>();
  const [error, setError] = useState('');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const model = parseModelIdentity(selectedModel);
  const params = new URLSearchParams({ year: String(year), timeZone });
  const path = `/api/admin/keys/${keyId}/analytics/daily?${params}`;
  const query = `${path}:${refreshKey}:${retry}`;

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<KeyDailyUsageResponse>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setResult({ query, data });
          const options = new Map<string, AnalyticsModelOption>();
          for (const row of data.days) {
            const identity = modelIdentity(row.provider, row.model);
            options.set(identity, {
              identity,
              model: row.model,
              provider: row.provider,
              label: `${row.model} · ${row.provider}`,
            });
          }
          onModelsLoaded([...options.values()]);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : '每日用量加载失败。');
        }
      });
    return () => controller.abort();
  }, [path, query, onModelsLoaded]);

  const data = useMemo(() => {
    if (result?.query !== query) return undefined;
    const selected = parseModelIdentity(selectedModel);
    return selected
      ? {
          ...result.data,
          days: result.data.days.filter(
            (row) => row.model === selected.model && row.provider === selected.provider,
          ),
        }
      : result.data;
  }, [result, query, selectedModel]);
  return (
    <section className="panel flush-panel token-heatmap" aria-label="每日 Token 热力图">
      <div className="panel-heading token-heatmap-heading">
        <div>
          <h2>Token 活跃度</h2>
          <p>全年每日用量 · {model ? `${model.model} · ${model.provider}` : '全部模型'}</p>
        </div>
        <div className="token-heatmap-year">
          <Button
            variant="secondary"
            aria-label="上一年"
            disabled={year <= 2000}
            onClick={() => setYear(year - 1)}
          >
            <ChevronLeft size={14} />
          </Button>
          <strong aria-live="polite">{year}</strong>
          <Button
            variant="secondary"
            aria-label="下一年"
            disabled={year >= currentYear}
            onClick={() => setYear(year + 1)}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
      {error ? (
        <div className="token-heatmap-message" role="alert">
          <span>每日用量加载失败：{error}</span>
          <Button variant="secondary" onClick={() => setRetry(retry + 1)}>
            重试
          </Button>
        </div>
      ) : !data ? (
        <div className="token-heatmap-loading" role="status" aria-label="正在加载每日用量">
          <Skeleton height={174} />
        </div>
      ) : (
        <TokenHeatmapCalendar
          key={`${query}:${selectedModel}`}
          data={data}
          onDrilldown={onDrilldown}
        />
      )}
    </section>
  );
}
