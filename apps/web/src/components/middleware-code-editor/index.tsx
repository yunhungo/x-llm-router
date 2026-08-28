import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo, useRef } from 'react';

import { useTheme } from '../theme-provider';
import { middlewareCompletionOptions } from './completions';
import './middleware-code-editor.css';

function ctxCompletion(context: CompletionContext): CompletionResult | null {
  const token = context.matchBefore(/[\w.()]+/);
  if (!token || (token.from === token.to && !context.explicit)) return null;
  if (!token.text.startsWith('ctx') && !context.explicit) return null;
  return { from: token.from, options: middlewareCompletionOptions, validFor: /^[\w.()]*$/ };
}

export default function MiddlewareCodeEditor({
  value,
  onChange,
  onSave,
  canSave,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void | Promise<void>;
  canSave: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const onSaveRef = useRef(onSave);
  const canSaveRef = useRef(canSave);
  onSaveRef.current = onSave;
  canSaveRef.current = canSave;
  const extensions = useMemo(
    () => [
      javascript(),
      javascriptLanguage.data.of({ autocomplete: ctxCompletion }),
      autocompletion({ activateOnTyping: true }),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            if (canSaveRef.current) void onSaveRef.current();
            return true;
          },
        },
      ]),
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
        height="100%"
        theme={resolvedTheme}
        extensions={extensions}
        basicSetup={{
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: true,
          foldGutter: true,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          highlightSelectionMatches: true,
          lineNumbers: true,
        }}
        onChange={onChange}
        aria-label="API Key 中间件代码"
      />
    </div>
  );
}
