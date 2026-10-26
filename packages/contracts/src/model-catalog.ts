/**
 * @created 2026-10-26
 * @description 定义上游模型目录来源及同步结果的公共合同。
 * @author yunhungo
 */
export type ModelCatalogSource = 'openai' | 'codex' | 'upstream' | 'builtin';

export interface ModelCatalog {
  models: string[];
  source: ModelCatalogSource;
  clientVersion: string | null;
  warning: string | null;
}

export interface ModelCatalogRefresh extends ModelCatalog {
  refreshedAt: string;
}
