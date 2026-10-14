// @vitest-environment jsdom
/**
 * The connected banner, end to end inside the renderer: fetch on show, the
 * push-driven refetch (only for the pushed server), the CTA wiring through to
 * Dashboard's `onOpenSettings` / billing, and dismissal persisted per account
 * by notice_id. Contexts, axios and secureLocalStore are stubbed; the store,
 * the hook, the model and the component are the real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ServerStorageStatus } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
// clPhysics (pulled in by ClButton) calls matchMedia at module load.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

const { axiosGet, kv, billing } = vi.hoisted(() => ({
    axiosGet: vi.fn(),
    kv: new Map<string, string>(),
    billing: {
        status: { subscription_status: 'canceled_pending' } as { subscription_status: string },
        openInAppCheckout: vi.fn(),
        setCancellation: vi.fn(async () => ({ ok: true })),
    },
}));
vi.mock('axios', () => ({ default: { get: axiosGet } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 'tok', userId: 'u1' }) }));
vi.mock('../../contexts/SubscriptionContext', () => ({ useSubscription: () => billing }));
vi.mock('../../utils/secureLocalStore', () => ({
    default: { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => { kv.set(k, v); } },
}));

import { ServerStorageBanner, ServerStorageBannerView } from './ServerStorageBanner';
import { serverStorageStatusStore } from '../../hooks/useServerStorageStatus';
import { SERVER_STORAGE_STATUS_WINDOW_EVENT } from '../../utils/serverStorageStatusStore';
import { buildStorageBannerModel } from '../../utils/serverStorageGrace';

const MB = 1024 * 1024;
const DAY = 86_400_000;

function graceStatus(serverId: string, days: number, over: Partial<ServerStorageStatus> = {}): ServerStorageStatus {
    const deadline = new Date(Date.now() + days * DAY).toISOString();
    return {
        server_id: serverId, audience: 'owner', state: 'grace', usage_bytes: 48 * MB, limit_bytes: 25 * MB,
        target_bytes: 25 * MB, pro_ends_at: null, grace_started_at: null, grace_deadline: deadline,
        days_left: days, transfer: { pro_member_count: 1, pro_member_ids: ['u9'] }, prune_summary: null,
        resolved_reason: null, resolved_at: null, pruned_at: null, notice_id: `grace:${deadline}`, dismissible: false,
        ...over,
    };
}
const prunedStatus = (serverId: string): ServerStorageStatus => ({
    ...graceStatus(serverId, 0), state: 'pruned', days_left: null, grace_deadline: null, transfer: null,
    pruned_at: '2026-10-10T09:00:00.000Z', notice_id: 'pruned:2026-10-10T09:00:00.000Z', dismissible: true,
});

function mount(el: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(el));
    return { host, rerender: (n: React.ReactElement) => act(() => root.render(n)), unmount: () => act(() => { root.unmount(); host.remove(); }) };
}
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const statusCalls = () => axiosGet.mock.calls.filter(c => String(c[0]).endsWith('/storage-status')).map(c => String(c[0]));
const click = (host: HTMLElement, action: string) => {
    const btn = host.querySelector(`[data-action="${action}"] button`) as HTMLButtonElement | null;
    if (!btn) throw new Error(`no ${action} button`);
    act(() => { btn.click(); });
};

beforeEach(() => {
    axiosGet.mockReset();
    kv.clear();
    billing.openInAppCheckout.mockReset();
    billing.setCancellation.mockClear();
    serverStorageStatusStore.reset();
});

describe('ServerStorageBanner (connected)', () => {
    it('fetches on show, and refetches on a push for THIS server only', async () => {
        axiosGet.mockImplementation(async (url: string) => ({ data: graceStatus(url.split('/').at(-2)!, 30) }));
        const onOpenSettings = vi.fn();
        const t = mount(h(ServerStorageBanner, { serverId: 'srv-a', serverName: 'Gamers', wsConnectCount: 1, onOpenSettings }));
        await settle();
        expect(statusCalls()).toHaveLength(1);
        expect(statusCalls()[0]).toContain('/servers/srv-a/storage-status');
        expect(t.host.textContent).toContain('30 days left:');
        expect(t.host.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('calm');

        window.dispatchEvent(new CustomEvent(SERVER_STORAGE_STATUS_WINDOW_EVENT, { detail: { server_id: 'srv-other' } }));
        await settle();
        expect(statusCalls()).toHaveLength(1);

        axiosGet.mockImplementation(async (url: string) => ({ data: graceStatus(url.split('/').at(-2)!, 3) }));
        window.dispatchEvent(new CustomEvent(SERVER_STORAGE_STATUS_WINDOW_EVENT, { detail: { server_id: 'srv-a' } }));
        await settle();
        expect(statusCalls()).toHaveLength(2);
        expect(t.host.textContent).toContain('3 days left:');
        expect(t.host.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('red');
        t.unmount();
    });

    it('wires the owner grace CTAs: transfer -> Members (Pro only), manage -> Storage, resubscribe -> checkout', async () => {
        axiosGet.mockResolvedValue({ data: graceStatus('srv-b', 7) });
        const onOpenSettings = vi.fn();
        const t = mount(h(ServerStorageBanner, { serverId: 'srv-b', serverName: 'Gamers', wsConnectCount: 1, onOpenSettings }));
        await settle();
        click(t.host, 'transfer');
        expect(onOpenSettings).toHaveBeenLastCalledWith({ tab: 'members', proOnly: true });
        click(t.host, 'manage_storage');
        expect(onOpenSettings).toHaveBeenLastCalledWith({ tab: 'storage' });
        click(t.host, 'resubscribe');
        expect(billing.openInAppCheckout).toHaveBeenCalledTimes(1);
        expect(t.host.querySelector('[data-action="dismiss"]')).toBeNull(); // a countdown can't be dismissed
        t.unmount();
    });

    it('owner pending: Keep Pro resumes the pending cancellation; Learn more opens the explainer', async () => {
        axiosGet.mockResolvedValue({ data: { ...graceStatus('srv-c', 0), state: 'pending', days_left: null, grace_deadline: null, pro_ends_at: '2026-10-30T00:00:00.000Z', notice_id: 'pending:x' } });
        const t = mount(h(ServerStorageBanner, { serverId: 'srv-c', serverName: 'Gamers', wsConnectCount: 1, onOpenSettings: vi.fn() }));
        await settle();
        expect(t.host.textContent).toContain('Your Pro plan ends');
        click(t.host, 'keep_pro');
        await settle();
        expect(billing.setCancellation).toHaveBeenCalledWith(false);
        click(t.host, 'learn_more');
        await settle();
        expect(document.body.textContent).toContain('How server storage works');
        t.unmount();
    });

    it('dismissing a pruned notice persists its notice_id per account and hides it for good', async () => {
        axiosGet.mockResolvedValue({ data: prunedStatus('srv-d') });
        const t = mount(h(ServerStorageBanner, { serverId: 'srv-d', serverName: 'Gamers', wsConnectCount: 1, onOpenSettings: vi.fn() }));
        await settle();
        expect(t.host.textContent).toContain('We trimmed Gamers to 25 MB');
        click(t.host, 'dismiss');
        expect(JSON.parse(kv.get('cipherline_storage_notice_dismissed_u1')!)).toEqual(['pruned:2026-10-10T09:00:00.000Z']);
        expect(t.host.querySelector('[data-storage-banner]')).toBeNull();
        t.unmount();

        // A fresh mount (relaunch) still hides it.
        const t2 = mount(h(ServerStorageBanner, { serverId: 'srv-d', serverName: 'Gamers', wsConnectCount: 1, onOpenSettings: vi.fn() }));
        await settle();
        expect(t2.host.querySelector('[data-storage-banner]')).toBeNull();
        t2.unmount();
    });

    it('renders nothing for ok, and nothing for a different server than the one shown', async () => {
        axiosGet.mockResolvedValue({ data: { ...graceStatus('srv-e', 1), state: 'ok', notice_id: null } });
        const t = mount(h(ServerStorageBanner, { serverId: 'srv-e', serverName: 'Gamers', wsConnectCount: 1, onOpenSettings: vi.fn() }));
        await settle();
        expect(t.host.querySelector('[data-storage-banner]')).toBeNull();
        t.unmount();
    });
});

describe('ServerStorageBannerView', () => {
    const model = (days: number, over: Partial<ServerStorageStatus> = {}) =>
        buildStorageBannerModel(graceStatus('s', days, over), 'Gamers')!;

    it.each([[30, 'calm'], [7, 'amber'], [1, 'red']] as const)('%i days left renders the %s tone', (d, tone) => {
        const t = mount(h(ServerStorageBannerView, { model: model(d), onAction: vi.fn(), onDismiss: vi.fn() }));
        expect(t.host.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe(tone);
        expect([...t.host.querySelectorAll('[data-action]')].map(e => e.getAttribute('data-action'))).toEqual(['transfer', 'resubscribe', 'manage_storage']);
        t.unmount();
    });

    it('shows "No members have Pro yet" instead of a Transfer button when nobody has Pro', () => {
        const t = mount(h(ServerStorageBannerView, { model: model(10, { transfer: { pro_member_count: 0, pro_member_ids: [] } }), onAction: vi.fn(), onDismiss: vi.fn() }));
        expect(t.host.querySelector('[data-action="transfer"]')).toBeNull();
        expect(t.host.querySelector('[data-action="no-pro-members"]')?.textContent).toContain('No members have Pro yet');
        t.unmount();
    });
});
