import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openExternalLink } from './openExternalLink';

describe('openExternalLink', () => {
    const originalElectronAPI = window.electronAPI;
    const originalOpen = window.open;

    beforeEach(() => {
        window.open = vi.fn();
    });

    afterEach(() => {
        window.electronAPI = originalElectronAPI;
        window.open = originalOpen;
        vi.restoreAllMocks();
    });

    it('accepts https:// and routes to electronAPI.openExternal', () => {
        const openExternal = vi.fn().mockResolvedValue(undefined);
        window.electronAPI = { ...(window.electronAPI ?? {}), openExternal } as typeof window.electronAPI;

        const result = openExternalLink('https://example.com/path');

        expect(result).toEqual({ ok: true });
        expect(openExternal).toHaveBeenCalledWith('https://example.com/path');
        expect(window.open).not.toHaveBeenCalled();
    });

    it('accepts mailto:', () => {
        const openExternal = vi.fn().mockResolvedValue(undefined);
        window.electronAPI = { ...(window.electronAPI ?? {}), openExternal } as typeof window.electronAPI;

        expect(openExternalLink('mailto:someone@example.com')).toEqual({ ok: true });
        expect(openExternal).toHaveBeenCalledWith('mailto:someone@example.com');
    });

    it('rejects http:// — the electron/main.ts handler deliberately blocks it (MITM downgrade), and this must not silently disagree', () => {
        const openExternal = vi.fn();
        window.electronAPI = { ...(window.electronAPI ?? {}), openExternal } as typeof window.electronAPI;

        const result = openExternalLink('http://example.com');

        expect(result).toEqual({ ok: false, reason: 'disallowed-scheme' });
        expect(openExternal).not.toHaveBeenCalled();
        expect(window.open).not.toHaveBeenCalled();
    });

    it.each([
        'javascript:alert(1)',
        'file:///etc/passwd',
        'data:text/html,<script>alert(1)</script>',
        'ms-msdt:/id PCWDiagnostic',
    ])('rejects dangerous scheme %s without ever reaching openExternal or window.open', (url) => {
        const openExternal = vi.fn();
        window.electronAPI = { ...(window.electronAPI ?? {}), openExternal } as typeof window.electronAPI;

        const result = openExternalLink(url);

        expect(result.ok).toBe(false);
        expect(openExternal).not.toHaveBeenCalled();
        expect(window.open).not.toHaveBeenCalled();
    });

    it('rejects an unparseable string', () => {
        const result = openExternalLink('not a url at all');
        expect(result).toEqual({ ok: false, reason: 'unparseable' });
    });

    it('applies the SAME validation to the window.open fallback when electronAPI is absent', () => {
        window.electronAPI = undefined as unknown as typeof window.electronAPI;

        expect(openExternalLink('https://example.com')).toEqual({ ok: true });
        expect(window.open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');

        vi.mocked(window.open).mockClear();

        // The gap this whole fix closes: the old fallback had zero validation.
        expect(openExternalLink('javascript:alert(1)')).toEqual({ ok: false, reason: 'disallowed-scheme' });
        expect(window.open).not.toHaveBeenCalled();
    });
});
