import { BarChart3, Code2, Info, List, Settings2 } from 'lucide-react';

import type { DetailTab } from '../../key-detail-model';
import './key-detail-tabs.css';

const detailTabs: Array<{
  value: DetailTab;
  label: string;
  icon: typeof Info;
}> = [
  { value: 'overview', label: '基本信息', icon: Info },
  { value: 'charts', label: '图表', icon: BarChart3 },
  { value: 'logs', label: '调用记录', icon: List },
  { value: 'settings', label: '设置', icon: Settings2 },
  { value: 'middleware', label: '中间件', icon: Code2 },
];

export function KeyDetailTabs({
  value,
  onChange,
}: {
  value: DetailTab;
  onChange: (tab: DetailTab) => void;
}) {
  return (
    <nav className="key-detail-tabs" aria-label="API Key 详情">
      {detailTabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            type="button"
            key={tab.value}
            id={`key-tab-${tab.value}`}
            className={value === tab.value ? 'active' : ''}
            aria-selected={value === tab.value}
            aria-controls={`key-panel-${tab.value}`}
            onClick={() => {
              if (value !== tab.value) onChange(tab.value);
            }}
          >
            <Icon size={15} />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
