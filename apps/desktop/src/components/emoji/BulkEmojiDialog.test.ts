// @vitest-environment jsdom
/**
 * The review list for bulk emoji upload: rows from files, per-row problems, the
 * slot cap, the upload button gating, progress, partial failure and retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
import { BulkEmojiDialog, type BulkEmojiDialogProps } from './BulkEmojiDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (name: string, size = 2048, type = 'image/png') => {
    const f = new File(['x'], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const base = (over: Partial<BulkEmojiDialogProps> = {}): BulkEmojiDialogProps => ({
    title: 'Add emojis', subtitle: 'sub', initialFiles: [], existingNames: [], slots: 50, slotNoun: 'on this server',
    fileProblem: f => (f.size > 5000 ? 'File is too big.' : null),
    upload: async () => {}, concurrency: 1, minGapMs: () => 0,
    errorMessage: e => (e instanceof Error ? e.message : 'failed'), activeLabel: 'Uploading', onClose: () => {},
    ...over,
});
const mount = async (props: BulkEmojiDialogProps) => {
    await act(async () => { root.render(React.createElement(BulkEmojiDialog, props)); });
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
};
const q = <T extends Element>(sel: string) => document.body.querySelector<T>(sel);
const buttons = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'));
const byText = (t: RegExp) => buttons().find(b => t.test(b.textContent ?? ''));
const names = () => Array.from(document.body.querySelectorAll<HTMLInputElement>('li input')).map(i => i.value);
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 30)); }); };

describe('BulkEmojiDialog', () => {
    it('lists a row per file with a unique name and enables the upload', async () => {
        await mount(base({ initialFiles: [file('Cat.png'), file('cat.gif'), file('dog.png')], existingNames: ['dog'] }));
        expect(names()).toEqual(['cat', 'cat_2', 'dog_2']);
        const up = byText(/Upload 3 emojis/);
        expect(up).toBeTruthy();
        expect(up!.disabled).toBe(false);
    });

    it('shows a per-row error, disables upload, and "Remove N with problems" fixes it', async () => {
        await mount(base({ initialFiles: [file('ok.png'), file('huge.png', 9999)] }));
        expect(document.body.textContent).toContain('File is too big.');
        expect(byText(/Fix 1 to upload/)!.disabled).toBe(true);
        await act(async () => { byText(/Remove 1 with problems/)!.click(); });
        expect(names()).toEqual(['ok']);
        expect(byText(/Upload 1 emoji$/)!.disabled).toBe(false);
    });

    it('caps at the slots left, says so, and "Keep the first N" drops the rest', async () => {
        const files = Array.from({ length: 5 }, (_, i) => file(`e${i}x.png`));
        await mount(base({ initialFiles: files, slots: 3 }));
        expect(document.body.textContent).toContain('Only 3 more fit on this server');
        expect(document.body.textContent).toContain('2 files are over');
        expect(byText(/^(Upload|Fix)/)!.disabled).toBe(true);
        await act(async () => { byText(/Keep the first 3/)!.click(); });
        expect(names()).toHaveLength(3);
        expect(byText(/Upload 3 emojis/)!.disabled).toBe(false);
    });

    it('removing one row by hand frees a slot for the next', async () => {
        await mount(base({ initialFiles: [file('aa.png'), file('bb.png'), file('cc.png')], slots: 2 }));
        expect(byText(/^(Upload|Fix)/)!.disabled).toBe(true);
        await act(async () => { q<HTMLButtonElement>('button[aria-label="Remove aa.png from the list"]')!.click(); });
        expect(byText(/Upload 2 emojis/)!.disabled).toBe(false);
    });

    it('a bad edited name blocks the upload until fixed', async () => {
        await mount(base({ initialFiles: [file('aa.png'), file('bb.png')] }));
        const input = document.body.querySelectorAll<HTMLInputElement>('li input')[1];
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(input, 'aa');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(document.body.textContent).toContain('already taken');
        expect(byText(/^(Upload|Fix)/)!.disabled).toBe(true);
    });

    it('uploads all, reports a partial failure, and retry sends only the failed row', async () => {
        const calls: string[] = [];
        let failBb = true;
        const upload = vi.fn(async (row: { name: string }) => { calls.push(row.name); if (row.name === 'bb' && failBb) throw new Error('Server said no.'); });
        const onClose = vi.fn();
        await mount(base({ initialFiles: [file('aa.png'), file('bb.png'), file('cc.png')], upload, onClose }));
        await act(async () => { byText(/Upload 3 emojis/)!.click(); });
        await flush(); await flush();
        expect(calls).toEqual(['aa', 'bb', 'cc']);
        expect(document.body.textContent).toContain('2 added, 1 failed');
        expect(document.body.textContent).toContain('Server said no.');
        failBb = false;
        await act(async () => { byText(/Retry 1 failed/)!.click(); });
        await flush(); await flush();
        expect(calls).toEqual(['aa', 'bb', 'cc', 'bb']);
        expect(document.body.textContent).toContain('All 3 added');
        await act(async () => { byText(/^Done$/)!.click(); });
        expect(onClose).toHaveBeenCalledWith({ added: 3 });
    });

    it('Stop cancels pending rows', async () => {
        let release: () => void = () => {};
        const upload = vi.fn((_r: unknown, signal: AbortSignal) => new Promise<void>((res, rej) => {
            release = res; signal.addEventListener('abort', () => rej(new Error('aborted')));
        }));
        await mount(base({ initialFiles: [file('aa.png'), file('bb.png'), file('cc.png')], upload }));
        await act(async () => { byText(/Upload 3 emojis/)!.click(); });
        await flush();
        expect(upload).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain('0 of 3 finished');
        await act(async () => { byText(/^Stop$/)!.click(); });
        await flush();
        expect(upload).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain('3 not sent');
        release();
        expect(byText(/Upload 3 remaining/)).toBeTruthy();
    });

    it('handles long names without growing past the field and shows the empty state', async () => {
        await mount(base({ initialFiles: [file('x'.repeat(120) + '.png')] }));
        expect(names()[0].length).toBeLessThanOrEqual(32);
        await act(async () => { q<HTMLButtonElement>('button[aria-label^="Remove"]')!.click(); });
        expect(document.body.textContent).toContain('Nothing left in the list');
    });
});
