// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';

// jsdom has no matchMedia; the modal kit reads it at import time.
vi.hoisted(() => {
    const w = globalThis as unknown as { matchMedia?: unknown };
    w.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
import { confirmExecutableDownload } from './executableDownloadGuard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const buttonNamed = (label: string) =>
    [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

afterEach(() => { document.body.innerHTML = ''; });

describe('confirmExecutableDownload', () => {
    it('does not ask for an ordinary file', async () => {
        await expect(confirmExecutableDownload('photo.jpg')).resolves.toBe(true);
        expect(document.querySelector('button')).toBeNull();
    });

    it('asks before an executable, and saves only on "Save anyway"', async () => {
        let p!: Promise<boolean>;
        await act(async () => { p = confirmExecutableDownload('invoice\u202Etxt.exe'); await wait(0); });
        expect(document.body.textContent).toContain('invoicetxt.exe'); // shown stripped
        expect(document.body.textContent).toContain('.exe');
        const save = buttonNamed('Save anyway');
        expect(save).toBeDefined();
        await act(async () => { save!.click(); await wait(300); });
        await expect(p).resolves.toBe(true);
    });

    it('cancel means no save', async () => {
        let p!: Promise<boolean>;
        await act(async () => { p = confirmExecutableDownload('setup.msi'); await wait(0); });
        const cancel = buttonNamed('Cancel');
        expect(cancel).toBeDefined();
        await act(async () => { cancel!.click(); await wait(300); });
        await expect(p).resolves.toBe(false);
    });
});
