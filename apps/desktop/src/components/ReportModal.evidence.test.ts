// @vitest-environment jsdom
/**
 * Report dialog + device-side evidence (a friend's end-to-end encrypted
 * cover): shown, removable, and appended to the excerpt that is posted -
 * never over the API's 4000-character cap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: ClSelect scrolls the highlighted option into view.
Element.prototype.scrollIntoView = function scrollIntoView() {};
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const post = vi.fn(async () => ({ data: { id: 'r1' } }));
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...(a as [])) } }));

const { ReportModal } = await import('./ReportModal');

const evidence = {
    label: 'The cover you saw (decrypted on this device)',
    text: "[Reported: this friend's Spotify listening cover.]\nTrack: T\nCover SHA-256 (image/jpeg, 9 bytes): abc",
    imageSrc: 'blob:evidence',
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); post.mockClear(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.useRealTimers(); });

async function mount(withEvidence = true) {
    await act(async () => {
        root.render(React.createElement(ReportModal, {
            targetUserId: 'u-1', targetUsername: 'Mira', token: 't', onClose: () => {},
            ...(withEvidence ? { evidence } : {}),
        }));
    });
    await act(async () => { vi.advanceTimersByTime(80); });
}
async function pickReason() {
    await act(async () => { (document.querySelector('button.selt') as HTMLButtonElement).click(); });
    const opt = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent?.includes('Harassment')) as HTMLButtonElement;
    await act(async () => { opt.click(); });
    // ClSelect commits the choice when its menu finishes closing.
    await act(async () => { vi.advanceTimersByTime(400); });
}
async function submit() {
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await Promise.resolve(); });
}
const bodyOf = () => (post.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];

describe('ReportModal with device-side evidence', () => {
    it('shows the attachment with its preview, and posts it appended to the excerpt', async () => {
        await mount();
        const box = document.querySelector('[data-testid="report-evidence"]')!;
        expect(box.getAttribute('data-attached')).toBe('true');
        expect(box.textContent).toContain('decrypted on this device');
        expect(box.querySelector('img')?.getAttribute('src')).toBe('blob:evidence');
        const ta = document.querySelector('#report-snippet') as HTMLTextAreaElement;
        expect(Number(ta.getAttribute('maxlength'))).toBe(4000 - evidence.text.length - 2);
        await pickReason();
        await submit();
        expect(post).toHaveBeenCalledTimes(1);
        expect(bodyOf()).toMatchObject({ reported_user_id: 'u-1', report_type: 'harassment', content_snippet: evidence.text });
    });

    it('Remove leaves it out of what is sent', async () => {
        await mount();
        const remove = [...document.querySelectorAll('[data-testid="report-evidence"] button')].find(b => b.textContent === 'Remove') as HTMLButtonElement;
        await act(async () => { remove.click(); });
        expect(document.querySelector('[data-testid="report-evidence"]')!.getAttribute('data-attached')).toBe('false');
        expect(document.querySelector('[data-testid="report-evidence"] img')).toBeNull();
        await pickReason();
        await submit();
        expect(bodyOf().content_snippet).toBeUndefined();
    });

    it('without evidence the dialog is exactly as before', async () => {
        await mount(false);
        expect(document.querySelector('[data-testid="report-evidence"]')).toBeNull();
        expect((document.querySelector('#report-snippet') as HTMLTextAreaElement).getAttribute('maxlength')).toBe('4000');
    });
});
