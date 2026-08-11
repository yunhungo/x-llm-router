import { describe, expect, it } from 'vitest';

import { parseThemePreference, resolveTheme } from './theme';

describe('theme preference', () => {
  it('accepts supported preferences and falls back to the system', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('sepia')).toBe('system');
    expect(parseThemePreference(null)).toBe('system');
  });

  it('resolves the system preference without overriding manual choices', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
