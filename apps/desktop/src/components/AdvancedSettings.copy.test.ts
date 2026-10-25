import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVersionText } from '../utils/buildInfo';
import { writeToClipboard } from '../utils/clipboard';

/**
 * "Click to copy version" did nothing: the copy buttons in Settings -> Advanced
 * called navigator.clipboard.writeText directly, which Electron's renderer
 * rejects (unfocused document / permission handler), and the rejection was
 * swallowed. They now go through writeToClipboard -> the preload's main-process
 * clipboard bridge, and always show feedback.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'AdvancedSettings.tsx'), 'utf8');

describe('buildVersionText', () => {
    it('names the product, version and commit', () => {
        expect(buildVersionText('1.0.22', '88a0183')).toBe('Cipherline v1.0.22 (88a0183)');
    });
    it('drops the commit when the build does not know it', () => {
        expect(buildVersionText('1.0.22', 'unknown')).toBe('Cipherline v1.0.22');
        expect(buildVersionText('1.0.22', '')).toBe('Cipherline v1.0.22');
    });
});

describe('Settings -> Advanced copy buttons', () => {
    it('no copy button calls the renderer clipboard directly', () => {
        expect(src).not.toMatch(/await navigator\.clipboard/);
        expect(src.match(/await writeToClipboard\(/g)?.length).toBe(3);
    });

    it('the version AND the commit are click-to-copy buttons with a title and visible feedback', () => {
        expect(src).toMatch(/const BuildVersion: React\.FC = \(\) => \(\s*(?:<VersionTapEgg>\s*)?<CopyChip text=\{buildVersionText\(APP_VERSION, BUILD_COMMIT\)\}/);
        expect(src).toMatch(/const BuildCommit: React\.FC = \(\) => \(\s*<CopyChip text=\{BUILD_COMMIT\}/);
        expect(src).toMatch(/<BuildVersion \/>/);
        expect(src).toMatch(/<button\s+type="button"\s+onClick=\{copy\}/);
        expect(src).toMatch(/'Copied'/);
        expect(src).toMatch(/'Copy failed'/); // a failure is shown, not swallowed
        expect(src).toMatch(/role="status" aria-live="polite"/);
    });
});

describe('writeToClipboard prefers the preload bridge', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('writes via window.electronAPI.writeClipboard even when navigator.clipboard would reject', async () => {
        const bridge = vi.fn(async (_t: string) => undefined);
        const web = vi.fn(async (_t: string) => { throw new DOMException('Document is not focused', 'NotAllowedError'); });
        vi.stubGlobal('window', { electronAPI: { writeClipboard: bridge } });
        vi.stubGlobal('navigator', { clipboard: { writeText: web } });
        await writeToClipboard('Cipherline v1.0.22 (88a0183)');
        expect(bridge).toHaveBeenCalledWith('Cipherline v1.0.22 (88a0183)');
        expect(web).not.toHaveBeenCalled();
    });
});
