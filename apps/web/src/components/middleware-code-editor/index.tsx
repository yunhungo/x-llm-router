import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

import { useTheme } from '../theme-provider';
import './middleware-code-editor.css';

const ctxCompletions = [
  { label: 'ctx.request.body', type: 'property', detail: '客户端请求 JSON' },
  { label: 'ctx.request.headers', type: 'property', detail: '客户端请求头' },
  {
    label: 'ctx.request.upstreamHeaders',
    type: 'property',
    detail: '追加到上游的安全请求头',
  },
  { label: 'ctx.response.status', type: 'property', detail: '响应状态码' },
  { label: 'ctx.response.headers', type: 'property', detail: '响应头' },
  { label: 'ctx.response.body', type: 'property', detail: '响应 JSON 或 SSE 文本' },
  { label: 'ctx.response.stream', type: 'property', detail: '是否为流式响应' },
  { label: 'ctx.response.phase', type: 'property', detail: 'headers / chunk / complete' },
  { label: 'ctx.key', type: 'property', detail: '当前 API Key 元信息' },
  { label: 'ctx.endpoint', type: 'property', detail: 'responses / chat.completions' },
  { label: 'ctx.requestId', type: 'property', detail: '当前请求 ID' },
  { label: 'ctx.state', type: 'property', detail: '同一请求内两个钩子共享的状态' },
  { label: 'ctx.crypto.randomUUID()', type: 'function', detail: '生成 UUID' },
  { label: 'ctx.crypto.sha256(value)', type: 'function', detail: 'SHA-256 hex' },
  { label: 'ctx.crypto.hmacSha256(secret, value)', type: 'function', detail: 'HMAC-SHA256 hex' },
  { label: 'ctx.base64.encode(value)', type: 'function', detail: 'Base64 编码' },
  { label: 'ctx.base64.decode(value)', type: 'function', detail: 'Base64 解码' },
  { label: 'ctx.base64.urlEncode(value)', type: 'function', detail: 'Base64 URL 编码' },
  { label: 'ctx.url.parse(value)', type: 'function', detail: '解析 URL' },
  { label: 'ctx.url.resolve(value, base)', type: 'function', detail: '解析相对 URL' },
  { label: 'ctx.log.info(value)', type: 'function', detail: '写入网关日志' },
  { label: 'ctx.log.warn(value)', type: 'function', detail: '写入警告日志' },
];

function ctxCompletion(context: CompletionContext): CompletionResult | null {
  const token = context.matchBefore(/[\w.()]+/);
  if (!token || (token.from === token.to && !context.explicit)) return null;
  if (!token.text.startsWith('ctx') && !context.explicit) return null;
  return { from: token.from, options: ctxCompletions, validFor: /^[\w.()]*$/ };
}

export default function MiddlewareCodeEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const extensions = useMemo(
    () => [
      javascript(),
      javascriptLanguage.data.of({ autocomplete: ctxCompletion }),
      autocompletion({ activateOnTyping: true }),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { fontSize: '13px' },
        '.cm-content': {
          padding: '14px 0 28px',
          fontFamily: "'Geist Mono Variable', ui-monospace, SFMono-Regular, monospace",
          lineHeight: '1.65',
        },
        '.cm-gutters': { fontFamily: "'Geist Mono Variable', ui-monospace, monospace" },
        '.cm-scroller': { overflow: 'auto' },
        '&.cm-focused': { outline: 'none' },
      }),
    ],
    [],
  );

  return (
    <div className="middleware-code-editor">
      <CodeMirror
        value={value}
        height="560px"
        theme={resolvedTheme}
        extensions={extensions}
        basicSetup={{
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          highlightSelectionMatches: true,
          lineNumbers: true,
        }}
        onChange={onChange}
        aria-label="API Key 中间件代码"
      />
    </div>
  );
}
