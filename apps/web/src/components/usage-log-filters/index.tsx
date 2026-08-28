import { Search, X } from 'lucide-react';

import type {
  UsageLogFiltersState,
  UsageLogStatusFilter,
} from '../../features/usage/usage-log-pagination';
import { UsageLogRangePicker } from '../usage-log-range-picker';
import './usage-log-filters.css';

function endpointLabel(endpoint: string) {
  return endpoint === 'responses' ? '/responses' : '/chat/completions';
}

export function UsageLogFilters({
  filters,
  models,
  endpoints,
  loadedCount,
  timeError,
  onChange,
  onReset,
}: {
  filters: UsageLogFiltersState;
  models: readonly string[];
  endpoints: readonly string[];
  loadedCount: number;
  timeError: string;
  onChange: (filters: UsageLogFiltersState) => void;
  onReset: () => void;
}) {
  const modelOptions = [...new Set(filters.model === 'all' ? models : [filters.model, ...models])];
  const endpointOptions = [
    ...new Set(filters.endpoint === 'all' ? endpoints : [filters.endpoint, ...endpoints]),
  ];

  return (
    <div className="usage-filter-wrap">
      <div className="usage-filter-toolbar">
        <label className="usage-filter-search">
          <Search size={14} />
          <input
            value={filters.search}
            onChange={(event) => onChange({ ...filters, search: event.target.value })}
            placeholder="请求 ID、模型、错误码、Key"
            aria-label="搜索调用记录"
          />
        </label>
        <select
          className="input usage-filter-select"
          value={filters.status}
          onChange={(event) =>
            onChange({ ...filters, status: event.target.value as UsageLogStatusFilter })
          }
          aria-label="按状态筛选"
        >
          <option value="all">All statuses</option>
          <option value="active">In progress</option>
          <option value="success">Succeeded</option>
          <option value="failed">Failed</option>
        </select>
        <select
          className="input usage-filter-select usage-filter-model"
          value={filters.model}
          onChange={(event) => onChange({ ...filters, model: event.target.value })}
          aria-label="按模型筛选"
        >
          <option value="all">全部模型</option>
          {modelOptions.map((model) => (
            <option value={model} key={model}>
              {model}
            </option>
          ))}
        </select>
        <select
          className="input usage-filter-select"
          value={filters.endpoint}
          onChange={(event) => onChange({ ...filters, endpoint: event.target.value })}
          aria-label="按端点筛选"
        >
          <option value="all">全部端点</option>
          {endpointOptions.map((endpoint) => (
            <option value={endpoint} key={endpoint}>
              {endpointLabel(endpoint)}
            </option>
          ))}
        </select>
        <UsageLogRangePicker
          value={{ from: filters.from, to: filters.to }}
          onApply={(range) => onChange({ ...filters, ...range })}
        />
        <button type="button" className="usage-filter-reset" onClick={onReset}>
          <X size={13} /> 重置
        </button>
        <span className="usage-filter-count">已加载 {loadedCount} 条</span>
      </div>
      {timeError ? (
        <div className="usage-filter-error" role="alert">
          {timeError}
        </div>
      ) : null}
    </div>
  );
}
