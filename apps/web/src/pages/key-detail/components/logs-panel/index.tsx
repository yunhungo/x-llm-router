import { Fragment } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';

import { UsageLogDetailPanel } from '../../../../components/usage-log-detail-panel';
import { isUsageLogActive, UsageLogStatusBadge } from '../../../../components/usage-log-status';
import type { KeyAnalyticsRange, KeyUsageLog } from '../../../../types';
import {
  decimal,
  endpointLabel,
  formatDate,
  integer,
  money,
  type LogDrilldown,
  type LogStatusFilter,
} from '../../key-detail-model';
import { RangeSwitch } from '../range-switch';
import './logs-panel.css';

interface LogsPanelProps {
  logs: KeyUsageLog[];
  modelNames: string[];
  endpoints: string[];
  range: KeyAnalyticsRange;
  onRangeChange: (range: KeyAnalyticsRange) => void;
  drilldown: LogDrilldown | undefined;
  onClearDrilldown: () => void;
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  status: LogStatusFilter;
  onStatusChange: (value: LogStatusFilter) => void;
  model: string;
  onModelChange: (value: string) => void;
  endpoint: string;
  onEndpointChange: (value: string) => void;
  onResetFilters: () => void;
  expandedLogId: string | undefined;
  onToggleExpandedLog: (id: string) => void;
}

export function LogsPanel({
  logs,
  modelNames,
  endpoints,
  range,
  onRangeChange,
  drilldown,
  onClearDrilldown,
  loading,
  search,
  onSearchChange,
  status,
  onStatusChange,
  model,
  onModelChange,
  endpoint,
  onEndpointChange,
  onResetFilters,
  expandedLogId,
  onToggleExpandedLog,
}: LogsPanelProps) {
  const normalizedSearch = search.trim().toLowerCase();
  const filteredLogs = logs.filter((log) => {
    const active = isUsageLogActive(log.callStatus);
    if (status === 'active' && !active) return false;
    if (status === 'success' && log.success !== true) return false;
    if (status === 'failed' && log.success !== false) return false;
    if (model !== 'all' && log.model !== model) return false;
    if (endpoint !== 'all' && log.endpoint !== endpoint) return false;
    if (!normalizedSearch) return true;
    return [
      log.requestId,
      log.model,
      log.requestedModel,
      log.providerName,
      log.errorCode,
      log.callStatus,
      endpointLabel(log.endpoint),
      log.statusCode === null ? '' : String(log.statusCode),
    ].some((value) => value?.toLowerCase().includes(normalizedSearch));
  });
  const hasFilters = Boolean(search) || status !== 'all' || model !== 'all' || endpoint !== 'all';

  return (
    <div
      id="key-panel-logs"
      className="key-tab-panel"
      role="tabpanel"
      aria-labelledby="key-tab-logs"
    >
      <section className="panel flush-panel logs-panel" id="key-usage-logs">
        <div className="logs-toolbar">
          <label className="log-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="请求 ID、模型、错误码"
              aria-label="搜索调用记录"
            />
          </label>
          <select
            className="input log-filter-select"
            value={status}
            onChange={(event) => onStatusChange(event.target.value as LogStatusFilter)}
            aria-label="按状态筛选"
          >
            <option value="all">All statuses</option>
            <option value="active">In progress</option>
            <option value="success">Succeeded</option>
            <option value="failed">Failed</option>
          </select>
          <select
            className="input log-filter-select model-filter"
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            aria-label="按模型筛选"
          >
            <option value="all">全部模型</option>
            {[...new Set(modelNames)].map((modelName) => (
              <option value={modelName} key={modelName}>
                {modelName}
              </option>
            ))}
          </select>
          <select
            className="input log-filter-select"
            value={endpoint}
            onChange={(event) => onEndpointChange(event.target.value)}
            aria-label="按端点筛选"
          >
            <option value="all">全部端点</option>
            {endpoints.map((endpointName) => (
              <option value={endpointName} key={endpointName}>
                {endpointLabel(endpointName)}
              </option>
            ))}
          </select>
          {hasFilters ? (
            <button type="button" className="clear-filter-button" onClick={onResetFilters}>
              <X size={13} /> 重置
            </button>
          ) : null}
          <div className="logs-range-control">
            <span>{filteredLogs.length} 条</span>
            <RangeSwitch value={range} onChange={onRangeChange} />
          </div>
        </div>
        {drilldown ? (
          <div className="drilldown-bar">
            <span>{drilldown.label}</span>
            <button type="button" onClick={onClearDrilldown}>
              <X size={13} /> 清除
            </button>
          </div>
        ) : null}
        {loading ? <div className="log-query-progress">查询中…</div> : null}
        <div className="table-wrap usage-table key-detail-table">
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>请求</th>
                <th>模型</th>
                <th>Token</th>
                <th>TPS / TTFT</th>
                <th>延迟</th>
                <th>成本</th>
                <th>时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length ? (
                filteredLogs.map((log) => {
                  const active = isUsageLogActive(log.callStatus);
                  return (
                    <Fragment key={log.id}>
                      <tr
                        className={`usage-log-row${active ? ' usage-log-row-active' : ''}`}
                        aria-expanded={active ? undefined : expandedLogId === log.id}
                        onClick={() => {
                          if (!active) onToggleExpandedLog(log.id);
                        }}
                      >
                        <td>
                          <UsageLogStatusBadge
                            callStatus={log.callStatus}
                            statusCode={log.statusCode}
                          />
                        </td>
                        <td>
                          <code>{endpointLabel(log.endpoint)}</code>
                          <small>{log.providerName ?? '—'}</small>
                        </td>
                        <td>
                          <code>{log.model}</code>
                          {log.requestedModel !== log.model ? (
                            <small>请求 {log.requestedModel}</small>
                          ) : log.errorCode ? (
                            <small>{log.errorCode}</small>
                          ) : null}
                        </td>
                        <td>
                          {active ? (
                            <>
                              —<small>Usage pending</small>
                            </>
                          ) : (
                            <>
                              {integer.format(log.totalTokens)}
                              <small>
                                {integer.format(log.inputTokens)} in ·{' '}
                                {integer.format(log.cachedInputTokens)} cached ·{' '}
                                {integer.format(log.outputTokens)} out
                                {log.reasoningTokens === null
                                  ? ''
                                  : ` · ${integer.format(log.reasoningTokens)} reasoning`}
                              </small>
                            </>
                          )}
                        </td>
                        <td>
                          {active ? (
                            '—'
                          ) : (
                            <>
                              TPS {log.tps === null ? '—' : decimal.format(log.tps)} ·{' '}
                              {log.timeToFirstTokenMs === null
                                ? 'TTFT —'
                                : `TTFT ${integer.format(log.timeToFirstTokenMs)} ms`}
                            </>
                          )}
                        </td>
                        <td>
                          {active
                            ? `${integer.format(
                                Math.max(Date.now() - new Date(log.createdAt).getTime(), 0),
                              )} ms`
                            : `${integer.format(log.latencyMs)} ms`}
                        </td>
                        <td>{active ? '—' : money.format(log.costUsd)}</td>
                        <td>{formatDate(log.createdAt)}</td>
                        <td>
                          {active ? null : (
                            <button
                              className="usage-expand-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                onToggleExpandedLog(log.id);
                              }}
                              aria-label={
                                expandedLogId === log.id ? '收起调用明细' : '展开调用明细'
                              }
                            >
                              <ChevronDown size={15} />
                            </button>
                          )}
                        </td>
                      </tr>
                      {expandedLogId === log.id ? (
                        <tr className="usage-detail-row">
                          <td colSpan={9}>
                            <UsageLogDetailPanel usageLogId={log.id} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9} className="table-empty">
                    暂无匹配记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
