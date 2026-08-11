import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';

import type { ThemePreference } from '../theme';
import { useTheme } from './theme-provider';

const themeOptions: Array<{
  value: ThemePreference;
  label: string;
  icon: LucideIcon;
}> = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
];

export function ThemeSelector({ className = '' }: { className?: string }) {
  const { preference, setPreference } = useTheme();

  return (
    <div className={`theme-selector ${className}`.trim()} role="group" aria-label="主题">
      {themeOptions.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          className={preference === value ? 'active' : ''}
          onClick={() => setPreference(value)}
          aria-label={label}
          aria-pressed={preference === value}
          title={label}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
