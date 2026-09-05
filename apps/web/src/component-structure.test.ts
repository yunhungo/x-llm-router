/**
 * @created 2026-08-26
 * @description 验证组件目录及就近样式的组织约定。
 * @author yunhungo
 */
/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('component structure', () => {
  const files = componentFiles(sourceRoot).filter(
    (file) => basename(file) !== 'main.tsx' && !file.endsWith('.test.tsx'),
  );

  it('keeps every React component in its own folder', () => {
    for (const file of files) {
      expect(['index.tsx', `${basename(dirname(file))}.tsx`], file).toContain(basename(file));
    }
  });

  it('keeps component-specific styles beside the component', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('className=')) continue;

      const cssImport = source.match(/import ['"](\.\/[^'"]+\.(?:css|scss))['"];?/);
      expect(
        cssImport?.[1],
        `${file} uses CSS classes but has no local style import`,
      ).toBeDefined();
      expect(existsSync(join(dirname(file), cssImport?.[1] ?? '')), file).toBe(true);
    }
  });
});
