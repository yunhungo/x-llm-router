interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

interface CopyTextArea {
  value: string;
  style: {
    position: string;
    top: string;
    opacity: string;
    pointerEvents: string;
  };
  setAttribute(name: string, value: string): void;
  focus(): void;
  select(): void;
  setSelectionRange(start: number, end: number): void;
  remove(): void;
}

interface CopyDocument {
  body: { appendChild(node: CopyTextArea): unknown };
  createElement(tagName: 'textarea'): CopyTextArea;
  execCommand(command: 'copy'): boolean;
}

interface CopyEnvironment {
  secureContext?: boolean;
  clipboard?: ClipboardWriter;
  document?: CopyDocument;
}

function browserEnvironment(): CopyEnvironment {
  const environment: CopyEnvironment = {
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
  };
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    environment.clipboard = navigator.clipboard;
  }
  if (typeof document !== 'undefined') {
    environment.document = document as unknown as CopyDocument;
  }
  return environment;
}

export async function copyText(
  value: string,
  environment: CopyEnvironment = browserEnvironment(),
): Promise<boolean> {
  if (environment.secureContext !== false && environment.clipboard) {
    try {
      await environment.clipboard.writeText(value);
      return true;
    } catch {
      // Insecure HTTP origins and browser policies can reject the modern Clipboard API.
    }
  }

  const targetDocument = environment.document;
  if (!targetDocument) return false;

  const textarea = targetDocument.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  targetDocument.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return targetDocument.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
