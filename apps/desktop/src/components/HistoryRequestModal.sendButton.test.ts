// @vitest-environment jsdom
/**
 * The approver's "Send history" button — the last button pressed when setting
 * up a new device (owner report 2026-11-13: "looks broke"). Rendered for real
 * with the transfer's collaborators faked, pinning the three states and the
 * no-double-submit guarantee:
 *   idle    — labelled, enabled, not busy, carries the `hr-send` hook;
 *   loading — aria-busy + disabled, kit loading dots, still `hr-send` (the CSS
 *             in styles/history-request.css that keeps its height is keyed off
 *             that class, checked at the bottom);
 *   done    — a green "Sent" button and a status line that no longer spins.
 * The protocol itself (C-2b gate, wrapped key) has its own suites; here it is
 * stubbed so only the button's behaviour is under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const h = vi.hoisted(() => ({
    exportCalls: 0,
    release: null as null | (() => void),
    posts: [] as string[],
}));

vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ token: 't', deviceId: 'dev-1', user: { user_id: 'me' } }),
}));
vi.mock('../utils/historyRequestProof', () => ({
    HISTORY_REFUSED_LEGACY_REQUESTER: 'requester_cannot_receive_wrapped_key',
    verifyHistoryRequestAdvertisement: () => ({ ok: true }),
}));
vi.mock('../utils/historyTransferKey', () => ({
    fetchOwnDeviceKeyBundle: async () => ({ device_id: 'req-1', identity_key_pub_b64: 'AAAA' }),
    wrapHistoryTransferKey: async () => 'd3JhcHBlZA==',
}));
vi.mock('../utils/recentTransfers', () => ({ shouldShowQrAuthorisedLine: () => false }));
vi.mock('../utils/crypto', () => ({
    exportLocalHistory: async () => {
        h.exportCalls += 1;
        await new Promise<void>(res => { h.release = res; });
        const json = JSON.stringify({ transferMeta: { included_message_count: 3 } });
        return {
            arrayBuffer: async () => new TextEncoder().encode(json).buffer,
            text: async () => json,
        };
    },
}));
vi.mock('axios', () => ({
    default: {
        post: async (url: string) => {
            h.posts.push(String(url).replace(/^.*\/v1/, ''));
            return { data: { backup_id: 'b-1' } };
        },
    },
}));

const { HistoryRequestModal } = await import('./HistoryRequestModal');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    h.exportCalls = 0; h.release = null; h.posts = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); }); };

async function mount() {
    const onClose = vi.fn();
    await act(async () => {
        root.render(React.createElement(HistoryRequestModal, {
            request: {
                device_id: 'req-1', device_name: 'New laptop', platform: 'windows',
                requested_at: '2026-11-13T00:00:00Z', capability_sig_b64: 'x', capability_ts: 1,
            },
            onClose,
        }));
    });
    await flush();
    return { onClose };
}

/** The action row's right-hand (primary) button. */
const sendBtn = () => {
    const caps = [...document.querySelectorAll<HTMLButtonElement>('button.cap')];
    return caps[caps.length - 1];
};
const wrapperOf = (b: HTMLElement) => b.closest('.clb') as HTMLElement;

describe('HistoryRequestModal — Send history button', () => {
    it('idle: labelled "Send history", enabled, not busy, hooked to the height fix', async () => {
        await mount();
        const b = sendBtn();
        expect(b.textContent?.trim()).toBe('Send history');
        expect(b.disabled).toBe(false);
        expect(b.getAttribute('aria-busy')).toBeNull();
        expect(wrapperOf(b).classList.contains('hr-send')).toBe(true);
        expect(wrapperOf(b).classList.contains('load')).toBe(false);
    });

    it('loading: aria-busy, disabled, kit dots, still hooked to the height fix; Decline disabled too', async () => {
        await mount();
        await act(async () => { sendBtn().click(); });
        await flush();
        const b = sendBtn();
        expect(b.getAttribute('aria-busy')).toBe('true');
        expect(b.disabled).toBe(true);
        expect(b.querySelector('.ldots')).not.toBeNull();
        expect(wrapperOf(b).classList.contains('load')).toBe(true);
        expect(wrapperOf(b).classList.contains('hr-send')).toBe(true);
        const decline = [...document.querySelectorAll<HTMLButtonElement>('button.cap')].find(x => x.textContent?.trim() === 'Decline');
        expect(decline?.disabled).toBe(true);
        expect(document.querySelector('[role="status"]')?.textContent).toMatch(/Packaging history/);
        // Close (X) is hidden rather than removed, so the header does not re-wrap.
        // (ClButton does not forward aria-label, so find it as the header's icon button.)
        const close = document.querySelector<HTMLElement>('.clb.clb--icon');
        expect(close).not.toBeNull();
        expect(close!.style.visibility).toBe('hidden');
    });

    it('two clicks in the same frame start exactly one transfer', async () => {
        await mount();
        const b = sendBtn();
        // Both clicks land before React re-renders the button as disabled.
        await act(async () => { b.click(); b.click(); });
        await flush();
        expect(h.exportCalls).toBe(1);
        // And clicking the (now disabled) busy button does nothing either.
        await act(async () => { sendBtn().click(); });
        await flush();
        expect(h.exportCalls).toBe(1);
    });

    it('done: green "Sent" button, status stops spinning, one delivery, then closes', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const { onClose } = await mount();
            await act(async () => { sendBtn().click(); });
            await flush();
            await act(async () => { h.release?.(); });
            await flush(20);
            const b = sendBtn();
            expect(b.textContent?.trim()).toBe('Sent');
            expect(b.getAttribute('aria-busy')).toBeNull();
            expect(wrapperOf(b).classList.contains('clb--ok')).toBe(true);
            const status = document.querySelector('[role="status"]')!;
            expect(status.textContent).toMatch(/Done/);
            expect(status.querySelector('.animate-spin')).toBeNull();
            expect(h.posts.filter(p => p.endsWith('/deliver-history'))).toHaveLength(1);
            // Auto-close after the success beat (1.2s) + the modal's exit (260ms).
            await act(async () => { vi.advanceTimersByTime(1200 + 300); });
            expect(onClose).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('styles/history-request.css — loading cap keeps the label height', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'history-request.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    it('gives the loading dots a 1em, centred line box on the hr-send button only', () => {
        const rule = css.match(/\.cl-kit\.clb\.hr-send \.ldots\s*\{([^}]*)\}/);
        expect(rule).not.toBeNull();
        expect(rule![1]).toMatch(/height\s*:\s*1em/);
        expect(rule![1]).toMatch(/align-items\s*:\s*center/);
        // Scoped: no bare `.ldots` rule that would restyle every loading button.
        expect(css).not.toMatch(/(^|\})\s*\.ldots\s*\{/);
    });
    it('the modal imports it', () => {
        const src = readFileSync(join(__dirname, 'HistoryRequestModal.tsx'), 'utf8');
        expect(src).toMatch(/import\s+'\.\.\/styles\/history-request\.css'/);
    });
});
