import type { UsageLog } from '../../types';
import './usage-log-token-summary.css';

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function UsageLogTokenSummary({
  totalTokens,
  inputTokens,
  outputTokens,
  cachedInputTokens,
  reasoningTokens,
}: Pick<
  UsageLog,
  'totalTokens' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens'
>) {
  return (
    <div className="usage-token-summary">
      <div className="usage-token-primary">
        <strong>{integer.format(totalTokens)}</strong>
        <span>
          (in {integer.format(inputTokens)},out {integer.format(outputTokens)})
        </span>
      </div>
      <small>
        {reasoningTokens === null ? '' : `reasoning ${integer.format(reasoningTokens)}, `}
        in cache {integer.format(cachedInputTokens)}
      </small>
    </div>
  );
}
