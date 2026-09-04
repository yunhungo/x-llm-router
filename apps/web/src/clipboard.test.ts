import { describe, expect, it, vi } from 'vitest';

import { copyText } from './clipboard';

function fallbackEnvironment(copied = true) {
  const textarea = {
    value: '',
    style: { position: '', top: '', opacity: '', pointerEvents: '' },
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const document = {
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => copied),
  };
  return { document, textarea };
}

describe('copyText', () => {
  it('uses the modern Clipboard API when it is available', async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(
      copyText('xr_secret', { secureContext: true, clipboard: { writeText } }),
    ).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('xr_secret');
  });

  it('falls back to a temporary textarea when Clipboard API access is rejected', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('Clipboard access denied', 'NotAllowedError');
    });
    const { document, textarea } = fallbackEnvironment();

    await expect(copyText('xr_secret', { clipboard: { writeText }, document })).resolves.toBe(true);
    expect(textarea.value).toBe('xr_secret');
    expect(textarea.select).toHaveBeenCalled();
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, 9);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.remove).toHaveBeenCalled();
  });

  it('uses the synchronous fallback directly on an insecure origin', async () => {
    const writeText = vi.fn(async () => undefined);
    const { document } = fallbackEnvironment();

    await expect(
      copyText('xr_secret', { secureContext: false, clipboard: { writeText }, document }),
    ).resolves.toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports failure and still removes the temporary textarea', async () => {
    const { document, textarea } = fallbackEnvironment(false);

    await expect(copyText('xr_secret', { document })).resolves.toBe(false);
    expect(textarea.remove).toHaveBeenCalled();
  });

  it('keeps fallback copying inside the fullscreen dialog and restores focus', async () => {
    const { document, textarea } = fallbackEnvironment();
    const dialog = { appendChild: vi.fn() };
    const button = { focus: vi.fn() };
    const querySelector = vi.fn(() => dialog);

    await expect(
      copyText('fullscreen JSON', {
        secureContext: false,
        document: { ...document, querySelector, activeElement: button },
      }),
    ).resolves.toBe(true);
    expect(querySelector).toHaveBeenCalledWith('dialog:modal');
    expect(dialog.appendChild).toHaveBeenCalledWith(textarea);
    expect(document.body.appendChild).not.toHaveBeenCalled();
    expect(button.focus).toHaveBeenCalled();
  });
});
