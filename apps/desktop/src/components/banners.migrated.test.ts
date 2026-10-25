// @vitest-environment jsdom
/**
 * Every banner that moved onto ClBanner still renders under its OLD conditions
 * and still calls its handlers, with its persistence keys unchanged. (The
 * TrialBanner, ServerStorageBanner and DeviceResetBanner have their own
 * suites.) Negative controls: each one renders nothing when it has nothing to
 * say, and dismissal never fires without a click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

const { kv, announcements, keyring } = vi.hoisted(() => ({
    kv: new Map<string, string>(),
    announcements: { list: [] as Array<Record<string, unknown>> },
    keyring: { status: 'present' as string },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ token: 'tok', userId: 'u1' }) }));
vi.mock('../hooks/useAnnouncements', () => ({ useAnnouncements: () => announcements.list }));
vi.mock('../utils/secureLocalStore', () => ({
    default: { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => { kv.set(k, v); } },
    secureLocalStore: { masterKeyStatus: () => keyring.status },
}));

import { AnnouncementBanners } from './AnnouncementBanners';
import { CallRejoinBanner } from './CallRejoinBanner';
import { KeyProtectionNotice } from './KeyProtectionNotice';
import { EncryptionAtRestNotice } from './EncryptionAtRestNotice';
import { OwnDeviceAlert } from './OwnDeviceAlert';
import { RendererHangBanner } from './RendererHangBanner';
import { ClBannerStack } from './ClBanner';

const h = React.createElement;
let host: HTMLDivElement;
let root: Root;
const render = (el: React.ReactElement) => act(() => { root.render(el); });
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T | null;
const qa = (sel: string) => [...host.querySelectorAll(sel)] as HTMLElement[];
const click = (sel: string) => act(() => { q<HTMLButtonElement>(sel)!.click(); });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const setApi = (a: Record<string, unknown> | undefined) => { (window as unknown as { electronAPI?: unknown }).electronAPI = a; };

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    kv.clear();
    announcements.list = [];
    keyring.status = 'present';
});
afterEach(() => { act(() => root.unmount()); host.remove(); setApi(undefined); });

const ann = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: null, body: `body-${id}`, icon: null, color: 'info', dismissible: true, ends_at: null, ...over,
});

describe('AnnouncementBanners', () => {
    it('renders each announcement with its tone, optional title, and an unchanged dismissal key', () => {
        announcements.list = [ann('a1', { color: 'warn', title: 'Maintenance', body: 'Tonight 10pm' })];
        render(h(AnnouncementBanners, { wsConnectCount: 1 }));
        const b = q('.cl-banner')!;
        expect(b.getAttribute('data-banner-tone')).toBe('warning');
        expect(q('.cl-banner__title')?.textContent).toBe('Maintenance');
        expect(q('.cl-banner__desc')?.textContent).toContain('Tonight 10pm');
        click('.cl-banner__x');
        expect(JSON.parse(kv.get('cipherline_announcement_dismissed_u1')!)).toEqual(['a1']);
        expect(q('.cl-banner')).toBeNull();
    });

    it('a title-less announcement shows its body as plain text; danger is assertive', () => {
        announcements.list = [ann('a2', { color: 'danger', body: 'Outage in progress' })];
        render(h(AnnouncementBanners, { wsConnectCount: 1 }));
        expect(q('.cl-banner__title')).toBeNull();
        expect(q('.cl-banner__desc--solo')?.textContent).toContain('Outage in progress');
        expect(q('.cl-banner')?.getAttribute('role')).toBe('alert');
    });

    it('NEGATIVE: a non-dismissible announcement has no close control; a dismissed one is not rendered; none renders nothing', () => {
        announcements.list = [ann('a3', { dismissible: false })];
        render(h(AnnouncementBanners, { wsConnectCount: 1 }));
        expect(q('.cl-banner')).not.toBeNull();
        expect(q('.cl-banner__x')).toBeNull();

        kv.set('cipherline_announcement_dismissed_u1', JSON.stringify(['a3']));
        render(h(AnnouncementBanners, { wsConnectCount: 2 }));
        // Re-mount to re-read the store, as the app does after a dismiss tick.
        act(() => root.unmount());
        root = createRoot(host);
        render(h(AnnouncementBanners, { wsConnectCount: 2 }));
        expect(q('.cl-banner')).toBeNull();

        announcements.list = [];
        render(h(AnnouncementBanners, { wsConnectCount: 3 }));
        expect(host.innerHTML).toBe('');
    });

    it('in the Dashboard stack, danger first, and only the top two of four show', () => {
        announcements.list = [
            ann('n', { color: 'neutral' }), ann('i', { color: 'info' }),
            ann('w', { color: 'warn' }), ann('d', { color: 'danger' }),
        ];
        render(h(ClBannerStack, null, h(AnnouncementBanners, { wsConnectCount: 1 })));
        expect(qa('.cl-banner').map(b => b.getAttribute('data-banner-tone')).sort()).toEqual(['danger', 'warning']);
        expect(q('.cl-banner-more')?.textContent).toContain('+2 more');
    });
});

describe('CallRejoinBanner', () => {
    const offer = { kind: 'dm', conversationId: 'c1', title: 'Mira' } as never;

    it('renders the offer, calls onRejoin and onDismiss', () => {
        const onRejoin = vi.fn();
        const onDismiss = vi.fn();
        render(h(CallRejoinBanner, { offer, busy: false, onRejoin, onDismiss }));
        expect(q('.cl-banner')?.getAttribute('data-banner-tone')).toBe('success');
        expect(q('.cl-banner__title')?.textContent).toContain('Cipherline restarted while you were in');
        expect(q('.cl-banner__desc')?.textContent).toContain('rejoin?');
        click('[data-action="rejoin"] button');
        expect(onRejoin).toHaveBeenCalledTimes(1);
        click('.cl-banner__x');
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('NEGATIVE: no offer renders nothing; while busy, dismiss is disabled and Rejoin does not fire', () => {
        render(h(CallRejoinBanner, { offer: null, busy: false, onRejoin: vi.fn(), onDismiss: vi.fn() }));
        expect(host.innerHTML).toBe('');
        const onRejoin = vi.fn();
        const onDismiss = vi.fn();
        render(h(CallRejoinBanner, { offer, busy: true, onRejoin, onDismiss }));
        act(() => { q<HTMLButtonElement>('.cl-banner__x')!.click(); });
        act(() => { q<HTMLButtonElement>('[data-action="rejoin"] button')!.click(); });
        expect(onDismiss).not.toHaveBeenCalled();
        expect(onRejoin).not.toHaveBeenCalled();
    });
});

describe('KeyProtectionNotice', () => {
    it('shows once the main process says it is due, and acknowledges on dismiss', async () => {
        const ack = vi.fn(async () => {});
        setApi({
            getKeyProtection: async () => ({ showNotice: true, level: 'plaintext', reason: 'no_keystore' }),
            ackKeyProtectionNotice: ack,
        });
        render(h(KeyProtectionNotice));
        await flush();
        expect(q('.cl-banner')).not.toBeNull();
        expect(q('.cl-banner__title')?.textContent).toBeTruthy();
        expect(q('.cl-banner__x')?.getAttribute('aria-label')).toBe('Got it');
        click('.cl-banner__x');
        expect(ack).toHaveBeenCalledTimes(1);
        expect(q('.cl-banner')).toBeNull();
    });

    it('NEGATIVE: not due, or a preload without the bridge, renders nothing', async () => {
        setApi({ getKeyProtection: async () => ({ showNotice: false, level: 'os_keystore', reason: null }) });
        render(h(KeyProtectionNotice));
        await flush();
        expect(host.innerHTML).toBe('');
        setApi({});
        act(() => root.unmount());
        root = createRoot(host);
        render(h(KeyProtectionNotice));
        await flush();
        expect(host.innerHTML).toBe('');
    });
});

describe('EncryptionAtRestNotice', () => {
    it('warns (amber, polite) only when there is no master key, and dismisses for the session', () => {
        keyring.status = 'absent';
        render(h(EncryptionAtRestNotice));
        const b = q('[data-testid="encryption-at-rest-notice"]')!;
        expect(b.getAttribute('data-banner-tone')).toBe('warning');
        expect(b.getAttribute('role')).toBe('status');
        expect(b.textContent).toContain('libsecret');
        click('.cl-banner__x');
        expect(q('[data-testid="encryption-at-rest-notice"]')).toBeNull();
    });

    it('NEGATIVE: with a keyring present it renders nothing', () => {
        keyring.status = 'present';
        render(h(EncryptionAtRestNotice));
        expect(host.innerHTML).toBe('');
    });
});

describe('OwnDeviceAlert', () => {
    const alertRow = { device_id: 'dev-1234', pub: 'PUB', kind: 'new', first_seen: Date.now() - 5 * 60_000, gone: false };
    const base = {
        alerts: [], selfKeyMismatch: false, unreviewedBaseline: [] as string[], names: {},
        onConfirm: vi.fn(), onReject: vi.fn(), onReviewed: vi.fn(), onManage: vi.fn(),
    };
    beforeEach(() => { for (const f of [base.onConfirm, base.onReject, base.onReviewed, base.onManage]) f.mockClear(); });

    it('a flagged device is a danger (assertive) banner with a row whose buttons call the right handlers', () => {
        render(h(OwnDeviceAlert, { ...base, alerts: [alertRow] as never, names: { 'dev-1234': { device_name: 'Studio PC', platform: 'windows' } } }));
        const b = q('[data-testid="own-device-alert"]')!;
        expect(b.getAttribute('role')).toBe('alert');
        expect(b.getAttribute('aria-live')).toBe('assertive');
        const row = q('[data-testid="own-device-alert-row"]')!;
        expect(row.textContent).toContain('Studio PC (windows)');
        const [reject, confirm] = [...row.querySelectorAll('button')];
        act(() => { reject.click(); });
        expect(base.onReject).toHaveBeenCalledWith('dev-1234', 'PUB');
        act(() => { confirm.click(); });
        expect(base.onConfirm).toHaveBeenCalledWith('dev-1234', 'PUB');
    });

    it('"Hide until next launch" hides it for the session', () => {
        render(h(OwnDeviceAlert, { ...base, alerts: [alertRow] as never }));
        click('.cl-banner__x');
        expect(q('[data-testid="own-device-alert"]')).toBeNull();
    });

    it('a self key mismatch alone is also an alarm', () => {
        render(h(OwnDeviceAlert, { ...base, selfKeyMismatch: true }));
        expect(q('[data-testid="own-device-alert"]')?.textContent).toContain('does not hold');
    });

    it('the first-run review is a calm info banner: Manage devices and Looks right', () => {
        render(h(OwnDeviceAlert, { ...base, unreviewedBaseline: ['dev-aaaa'] }));
        const b = q('[data-testid="own-device-review"]')!;
        expect(b.getAttribute('data-banner-tone')).toBe('info');
        expect(b.getAttribute('role')).toBe('status');
        click('[data-action="manage"] button');
        expect(base.onManage).toHaveBeenCalledTimes(1);
        click('[data-action="reviewed"] button');
        expect(base.onReviewed).toHaveBeenCalledTimes(1);
    });

    it('NEGATIVE: nothing to review and nothing flagged renders nothing', () => {
        render(h(OwnDeviceAlert, base));
        expect(host.innerHTML).toBe('');
    });
});

describe('RendererHangBanner', () => {
    it('appears on the unresponsive signal, offers an opt-in reload, and goes away when responsive again', () => {
        let onUn: () => void = () => {};
        let onRe: () => void = () => {};
        setApi({
            onRendererUnresponsive: (cb: () => void) => { onUn = cb; return () => {}; },
            onRendererResponsive: (cb: () => void) => { onRe = cb; return () => {}; },
        });
        render(h(RendererHangBanner));
        expect(host.innerHTML).toBe('');
        act(() => onUn());
        expect(q('.cl-banner')?.getAttribute('data-banner-tone')).toBe('warning');
        expect(q('.cl-banner__title')?.textContent).toContain("isn't responding");
        expect(q('[data-action="force-reload"] button')?.textContent).toBe('Force reload');
        act(() => onRe());
        expect(host.innerHTML).toBe('');
    });
});
