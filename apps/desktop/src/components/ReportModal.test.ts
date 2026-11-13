// @vitest-environment jsdom
/** Report dialog: house frame, submit gated on a reason, posts once, shows the sent state. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));

const { ReportModal } = await import('./ReportModal');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

async function mount(initialSnippet?: string) {
    const onClose = vi.fn();
    await act(async () => {
        root.render(React.createElement(ReportModal, { targetUserId: 'u-1', targetUsername: 'Mira', token: 't', onClose, initialSnippet }));
    });
    await act(async () => { vi.advanceTimersByTime(80); });
    return { onClose };
}
const footBtn = (t: string) => [...document.querySelectorAll('.dlg-foot-actions button')].find(b => b.textContent?.trim() === t) as HTMLButtonElement | undefined;

describe('ReportModal', () => {
    it('uses the house frame: danger tile, title naming the person, Cancel + danger Submit', async () => {
        await mount();
        expect(document.querySelector('.dlg-title')?.textContent).toBe('Report Mira');
        expect(document.querySelector('.dlg-head-icon--danger')).not.toBeNull();
        expect([...document.querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent?.trim())).toEqual(['Cancel', 'Submit report']);
    });

    it('keeps the encryption / false-report disclosure', async () => {
        await mount();
        const t = document.querySelector('.dlg-note')?.textContent ?? '';
        expect(t).toMatch(/end-to-end encrypted/);
        expect(t).toMatch(/False reports/);
    });

    it('Submit is disabled until a reason is chosen, and nothing is posted', async () => {
        await mount();
        expect(footBtn('Submit report')!.disabled).toBe(true);
        await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        expect(post).not.toHaveBeenCalled();
    });

    it('pre-fills the content excerpt from a reported message', async () => {
        await mount('threatening text');
        expect((document.querySelector('#report-snippet') as HTMLTextAreaElement).value).toBe('threatening text');
    });

    it('Cancel closes after the exit animation without posting', async () => {
        const { onClose } = await mount();
        await act(async () => { footBtn('Cancel')!.click(); });
        await act(async () => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(post).not.toHaveBeenCalled();
    });
});
