/* eslint-disable -- bench harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import React, { useState } from 'react';
import axios from 'axios';
import { hoverPrefetchChannelViewers } from '../src/utils/channelViewerCache';

/**
 * CHANNEL switching inside one server, with the member sidebar filtered to
 * the channel's viewers (see utils/channelViewerCache). Sibling of
 * roster-main.tsx (which measures SERVER switching).
 *
 * Query: ?impl=old|new  &rtt=<ms simulated API latency>  &members=<roster size>
 *
 * Channels: 0 public, 1 restricted (2 viewers), 2 restricted (30 viewers),
 * 3 public. `old` = the pre-change panel (ServerContextPanel.old.tsx, a copy
 * of origin/staging's, untracked), which always lists everyone.
 *
 * Window API (driver: harness/channel-switch-bench.mjs):
 *   __bench.switchTo(i) -> { paintMs, maxRows, finalRows } — ms from the switch
 *     until the list shows the channel's expected rows (spinner gone) and the
 *     frame is produced; maxRows = most member rows seen in the DOM at any
 *     mutation during the switch (a flash shows up as maxRows > expected).
 *   __bench.requests    -> GETs served (members/roles/viewers)
 */
const q = new URLSearchParams(location.search);
const IMPL = q.get('impl') === 'old' ? 'old' : 'new';
const RTT = Number(q.get('rtt') ?? 60);
const PER = Number(q.get('members') ?? 100);
const SID = 's0';

const ROLES = [
    { role_id: 'r-mod', name: 'Moderators', color: 0x25E0C8, position: 5, hoisted: true, is_everyone: false },
    { role_id: 'r-every', name: '@everyone', color: -1, position: 0, hoisted: false, is_everyone: true },
];
const MEMBERS = Array.from({ length: PER }, (_, i) => ({
    user_id: `u${i}`, username: `user_${i}_${SID}`, discriminator: 1000 + i, nickname: null,
    avatar_url: null, status: i % 3 === 0 ? 'offline' : 'online', on_mobile: false,
    joined_at: '2026-01-01T00:00:00Z', muted_until: null, role_ids: i % 10 === 0 ? ['r-mod'] : [],
}));
const VIEWERS: Record<string, string[]> = {
    c1: ['u1', 'u2'],
    c2: Array.from({ length: 30 }, (_, i) => `u${i * 3}`),
    c4: ['u4', 'u5', 'u6', 'u7', 'u8'],
};
const channels = [0, 1, 2, 3, 4].map(i => ({
    channel_id: `c${i}`, server_id: SID, kind: 'text' as const, name: `chan-${i}`, topic: null, icon_emoji: null, icon_name: null,
    position: i, parent_category_id: null, active_call_session_id: null, member_limit: null, max_calls: null,
    view_scope: (i === 1 || i === 2 || i === 4 ? 'restricted' : 'all') as 'all' | 'restricted',
}));
const expectedRows = (i: number) => {
    if (IMPL === 'old') return PER;
    const v = VIEWERS[`c${i}`];
    return v ? v.length : PER;
};

const bench = {
    requests: 0, ready: false,
    switchTo: (_i: number) => Promise.resolve({ paintMs: 0, maxRows: 0, finalRows: 0 }),
    /** Rest the pointer on channel i's row for `dwellMs` (the channel list's
     *  hover prefetch — `new` only), then click it. */
    hoverThenSwitch: async (i: number, dwellMs: number) => {
        if (IMPL === 'new') hoverPrefetchChannelViewers(channels[i], 'bench-token');
        await new Promise(r => setTimeout(r, dwellMs));
        return bench.switchTo(i);
    },
};
(window as any).__bench = bench;

axios.defaults.adapter = async (config: any) => {
    const url = String(config.url);
    bench.requests++;
    await new Promise(r => setTimeout(r, RTT));
    let data: unknown;
    if (/\/members$/.test(url)) data = MEMBERS;
    else if (/\/roles$/.test(url)) data = ROLES;
    else {
        const m = /\/channels\/([^/]+)\/viewers$/.exec(url);
        if (!m) throw new Error('unexpected ' + url);
        data = VIEWERS[m[1]] ? { all: false, user_ids: VIEWERS[m[1]] } : { all: true };
    }
    return { data: JSON.parse(JSON.stringify(data)), status: 200, statusText: 'OK', headers: {}, config };
};

const server = {
    server_id: SID, name: 'Server', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'owner', created_at: '2026-01-01',
};
const noop = () => {};
const asyncNoop = async () => {};
const EMPTY = {};
const SET = new Set<string>();
const NONE: never[] = [];

async function main() {
    const oldPanel = import.meta.glob('../src/components/server/ServerContextPanel.old.tsx');
    const mod: any = IMPL === 'old'
        ? await Object.values(oldPanel)[0]()
        : await import('../src/components/server/ServerContextPanel');
    const Panel = mod.ServerContextPanel as React.FC<any>;

    let setIdx: (i: number) => void = noop;
    function Harness() {
        const [idx, set] = useState(0);
        setIdx = set;
        return (
            <Panel
                server={server} channel={channels[idx]} token="bench-token" userId="me"
                allChannels={channels} voiceParticipants={EMPTY} friendStatuses={EMPTY} myStatus="online" myCurrentGame={null}
                globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
                huddleCalls={EMPTY} categories={NONE} searchableMessages={NONE} channelPermissionsMap={EMPTY}
                onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={asyncNoop} onStartCall={noop} onBlock={noop}
            />
        );
    }
    createRoot(document.getElementById('root')!).render(<Harness />);

    const rowCount = () => {
        let n = 0;
        document.querySelectorAll('.cursor-pointer.group').forEach(el => { if ((el.textContent ?? '').includes(`_${SID}`)) n++; });
        return n;
    };
    const spinning = () => !!document.querySelector('.animate-spin');
    // Wait for the roster to land before any measurement.
    await new Promise<void>(res => { const t = setInterval(() => { if (rowCount() > 0) { clearInterval(t); res(); } }, 10); });

    bench.switchTo = (i: number) => new Promise(resolve => {
        const want = Math.min(expectedRows(i), 48);   // ROW_BATCH: rows mounted up front
        const t0 = performance.now();
        let maxRows = 0;
        let done = false;
        const check = () => {
            const n = rowCount();
            if (n > maxRows) maxRows = n;
            if (!done && n === want && !spinning()) {
                done = true;
                const domMs = performance.now() - t0;
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    resolve({ paintMs: performance.now() - t0, domMs, maxRows, finalRows: rowCount() } as any);
                }));
                return true;
            }
            return false;
        };
        const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
        mo.observe(document.getElementById('root')!, { childList: true, subtree: true });
        setIdx(i);
        setTimeout(() => { if (check()) mo.disconnect(); }, 0);
    });
    bench.ready = true;
}
void main();
