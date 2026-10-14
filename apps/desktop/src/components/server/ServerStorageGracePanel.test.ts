// @vitest-environment jsdom
/**
 * Server Settings -> Storage (the grace card) and the wiring that connects the
 * banner / card to Server Settings' Storage + Members tabs. The modal and
 * Dashboard are too large to mount here, so their wiring is pinned against
 * the source (same idiom as FirstWeekNudges.wiring.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerStorageStatus } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});
const h = React.createElement;

import { ServerStorageGraceCard } from './ServerStorageGracePanel';

const MB = 1024 * 1024;
const NOW = Date.parse('2026-10-12T12:00:00.000Z');

const grace = (days: number, over: Partial<ServerStorageStatus> = {}): ServerStorageStatus => ({
    server_id: 's', audience: 'owner', state: 'grace', usage_bytes: 48 * MB, limit_bytes: 25 * MB, target_bytes: 25 * MB,
    pro_ends_at: null, grace_started_at: null, grace_deadline: new Date(NOW + days * 86_400_000).toISOString(), days_left: days,
    transfer: { pro_member_count: 2, pro_member_ids: ['a', 'b'] }, prune_summary: null, resolved_reason: null,
    resolved_at: null, pruned_at: null, notice_id: 'grace:x', dismissible: false, ...over,
});

function mount(el: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(el));
    return { host, unmount: () => act(() => { root.unmount(); host.remove(); }) };
}

describe('ServerStorageGraceCard', () => {
    it('owner grace: countdown headline, usage against the 25 MB, and the CTAs with Manage emojis in place of Manage storage', () => {
        const onAction = vi.fn();
        const t = mount(h(ServerStorageGraceCard, { status: grace(12), serverName: 'Gamers', onAction, nowMs: NOW }));
        expect(t.host.textContent).toContain('12 days left');
        expect(t.host.textContent).toContain('48 MB used · 25 MB free limit · 23 MB over');
        const actions = [...t.host.querySelectorAll('[data-action]')].map(e => e.getAttribute('data-action'));
        expect(actions).toEqual(['transfer', 'resubscribe', 'manage_emojis']);
        act(() => { (t.host.querySelector('[data-action="transfer"] button') as HTMLButtonElement).click(); });
        expect(onAction).toHaveBeenLastCalledWith('transfer');
        act(() => { (t.host.querySelector('[data-action="manage_emojis"] button') as HTMLButtonElement).click(); });
        expect(onAction).toHaveBeenLastCalledWith('manage_emojis');
        expect(t.host.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('amber');
        t.unmount();
    });

    it('manager grace: no billing buttons', () => {
        const t = mount(h(ServerStorageGraceCard, { status: grace(2, { audience: 'manager', transfer: null }), serverName: 'Gamers', onAction: vi.fn(), nowMs: NOW }));
        const actions = [...t.host.querySelectorAll('[data-action]')].map(e => e.getAttribute('data-action'));
        expect(actions).toEqual(['learn_more', 'manage_emojis']);
        t.unmount();
    });

    it('renders nothing for ok', () => {
        const t = mount(h(ServerStorageGraceCard, { status: grace(10, { state: 'ok', notice_id: null }), serverName: 'Gamers', onAction: vi.fn() }));
        expect(t.host.innerHTML).toBe('');
        t.unmount();
    });
});

describe('wiring into Server Settings and Dashboard', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const modal = readFileSync(join(here, 'ServerSettingsModal.tsx'), 'utf8');
    const dash = readFileSync(join(here, '..', 'Dashboard.tsx'), 'utf8');

    it('Server Settings has a Storage tab holding the grace panel and the meter', () => {
        expect(modal).toContain("{ id: 'storage',");
        const storage = modal.slice(modal.indexOf("{activeTab === 'storage'"), modal.indexOf("{activeTab === 'members'"));
        expect(storage).toContain('<ServerStorageGracePanel');
        expect(storage).toContain('<ServerStoragePanel');
    });

    it('a members request with proOnly filters the member list to Pro members, from the owner-only transfer ids', () => {
        expect(modal).toContain("(tabRequest?.tab === 'members' && !!tabRequest.proOnly)");
        expect(modal).toContain('storageStatus.transfer?.pro_member_ids');
        expect(modal).toContain('proMemberIds={proMemberIds} proOnly={membersProOnly} onProOnlyChange={setMembersProOnly}');
        expect(modal).toContain("'No members have Pro yet.'");
    });

    it('the transfer dialog no longer says everything already saved is kept', () => {
        expect(modal).not.toContain('anything already saved is kept');
        expect(modal).toContain('{transferStorageNote()}');
    });

    it('Dashboard mounts the banner for the server being shown and routes its CTAs into Server Settings', () => {
        expect(dash.match(/<ServerStorageBanner\b/g)).toHaveLength(1);
        expect(dash).toContain('onOpenSettings={openServerSettingsAt}');
        const opener = dash.slice(dash.indexOf('const openServerSettingsAt'), dash.indexOf('}, []);', dash.indexOf('const openServerSettingsAt')));
        expect(opener).toContain('setServerSettingsTabRequest(');
        expect(opener).toContain('setShowServerSettings(true)');
        expect(opener).toContain("proOnly: target.tab === 'members' ? target.proOnly : undefined");
    });
});
