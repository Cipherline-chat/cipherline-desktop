// @vitest-environment jsdom
/**
 * The billing cancel confirmation's server-storage line:
 *   - the line itself (CancelServerStorageNotice),
 *   - the lookup behind it (useOwnedServersOverFreeStorage): nothing until the
 *     confirmation opens, then ONE GET /servers and the storage status of
 *     OWNED servers only,
 *   - and that BillingTab actually wires the two to the confirmation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const { axiosGet } = vi.hoisted(() => ({ axiosGet: vi.fn() }));
vi.mock('axios', () => ({ default: { get: axiosGet } }));

import { CancelServerStorageNotice } from './CancelServerStorageNotice';
import { useOwnedServersOverFreeStorage, serverStorageStatusStore } from '../../hooks/useServerStorageStatus';

const MB = 1024 * 1024;

function mount(el: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(el));
    return { host, rerender: (n: React.ReactElement) => act(() => root.render(n)), unmount: () => act(() => { root.unmount(); host.remove(); }) };
}
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

const SERVERS = [
    { server_id: 'own-big', owner_user_id: 'me' },
    { server_id: 'own-small', owner_user_id: 'me' },
    { server_id: 'theirs-big', owner_user_id: 'someone-else' },
    { server_id: 'own-big-2', owner_user_id: 'me' },
];
const USAGE: Record<string, number> = { 'own-big': 40 * MB, 'own-small': 2 * MB, 'theirs-big': 90 * MB, 'own-big-2': 26 * MB };

function Probe({ open }: { open: boolean }) {
    const { overCount } = useOwnedServersOverFreeStorage(open, 'tok', 'me');
    return h('div', null, h(CancelServerStorageNotice, { overCount }));
}

beforeEach(() => {
    axiosGet.mockReset();
    serverStorageStatusStore.reset();
    axiosGet.mockImplementation(async (url: string) => {
        if (url.endsWith('/servers')) return { data: SERVERS };
        const id = url.split('/').at(-2)!;
        return { data: { server_id: id, audience: 'owner', state: 'ok', usage_bytes: USAGE[id], limit_bytes: 100 * MB, target_bytes: 25 * MB } };
    });
});

describe('CancelServerStorageNotice', () => {
    it('renders nothing at 0 and the exact line otherwise', () => {
        const t0 = mount(h(CancelServerStorageNotice, { overCount: 0 }));
        expect(t0.host.innerHTML).toBe('');
        t0.unmount();
        const t2 = mount(h(CancelServerStorageNotice, { overCount: 2 }));
        expect(t2.host.textContent).toBe("2 of your servers use more than 25 MB. After Pro ends you'll have 60 days to transfer them to a Pro member before they're trimmed.");
        t2.unmount();
    });
});

describe('useOwnedServersOverFreeStorage', () => {
    it('does nothing until the confirmation opens', async () => {
        const t = mount(h(Probe, { open: false }));
        await settle();
        expect(axiosGet).not.toHaveBeenCalled();
        expect(t.host.textContent).toBe('');
        t.unmount();
    });

    it('on open: one server list, then status for OWNED servers only; counts those over 25 MB', async () => {
        const t = mount(h(Probe, { open: false }));
        t.rerender(h(Probe, { open: true }));
        await settle();
        const urls = axiosGet.mock.calls.map(c => String(c[0]));
        expect(urls.filter(u => u.endsWith('/servers'))).toHaveLength(1);
        const statusUrls = urls.filter(u => u.endsWith('/storage-status'));
        expect(statusUrls.map(u => u.split('/').at(-2))).toEqual(['own-big', 'own-small', 'own-big-2']);
        expect(t.host.textContent).toContain('2 of your servers use more than 25 MB');
        t.unmount();
    });

    it('closing hides the line; reopening within a minute reuses the cached statuses', async () => {
        const t = mount(h(Probe, { open: true }));
        await settle();
        t.rerender(h(Probe, { open: false }));
        await settle();
        expect(t.host.textContent).toBe('');
        const before = axiosGet.mock.calls.filter(c => String(c[0]).endsWith('/storage-status')).length;
        t.rerender(h(Probe, { open: true }));
        await settle();
        expect(axiosGet.mock.calls.filter(c => String(c[0]).endsWith('/storage-status')).length).toBe(before);
        expect(t.host.textContent).toContain('2 of your servers');
        t.unmount();
    });
});

describe('BillingTab wiring', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'BillingTab.tsx'), 'utf8');
    it('runs the lookup only while the cancel confirmation is open', () => {
        expect(src).toContain('useOwnedServersOverFreeStorage(confirmCancel, token, userId)');
    });
    it('renders the line inside the confirmation block', () => {
        const block = src.slice(src.indexOf('{confirmCancel && ('), src.indexOf('Yes, cancel at period end'));
        expect(block).toContain('<CancelServerStorageNotice overCount={serversOverFree} />');
    });
    it('no longer promises that everything already saved is kept', () => {
        expect(src).not.toMatch(/anything already saved is kept/);
    });
});
