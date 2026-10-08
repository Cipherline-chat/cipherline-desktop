/* eslint-disable -- bench harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import React, { useState } from 'react';
import axios from 'axios';

/**
 * Query: ?impl=old|new  &rtt=<ms simulated API latency>  &members=<per server>  &servers=<count>
 *
 * `old` loads src/components/server/ServerContextPanel.old.tsx (a copy of the
 * pre-change panel, see below); `new` loads the real panel. Everything else — CSS, EncryptedAvatar, context menu,
 * the member row markup — is the app's own code.
 *
 * Window API (used by the driver script):
 *   __bench.switchTo(i)  -> ms from the switch to the first member row in the DOM,
 *                           and to the frame it was painted in
 *   __bench.requests     -> number of members/roles GETs served
 */
const q = new URLSearchParams(location.search);
const IMPL = q.get('impl') === 'old' ? 'old' : 'new';
const RTT = Number(q.get('rtt') ?? 60);
const PER = Number(q.get('members') ?? 62);
const NSERV = Number(q.get('servers') ?? 6);

const ROLES = (sid: string) => [
    { role_id: `${sid}-r-mod`, name: 'Moderators', color: 0x25E0C8, position: 5, hoisted: true, is_everyone: false },
    { role_id: `${sid}-r-vip`, name: 'VIP', color: 0xE0A825, position: 3, hoisted: true, is_everyone: false },
    { role_id: `${sid}-r-every`, name: '@everyone', color: -1, position: 0, hoisted: false, is_everyone: true },
];
const MEMBERS = (sid: string) => Array.from({ length: sid === 'blank' ? 0 : PER }, (_, i) => ({
    user_id: `${sid}-u${i}`, username: `user_${i}_${sid}`, discriminator: 1000 + i, nickname: i % 7 === 0 ? `Nick_${i}_${sid}` : null,
    avatar_url: null, status: i % 3 === 0 ? 'offline' : 'online', on_mobile: i % 11 === 0,
    joined_at: '2026-01-01T00:00:00Z', muted_until: null,
    role_ids: i % 10 === 0 ? [`${sid}-r-mod`] : i % 4 === 0 ? [`${sid}-r-vip`] : [],
}));

const bench = { requests: 0, switchTo: (_i: number): Promise<{ domMs: number; paintMs: number }> => Promise.resolve({ domMs: 0, paintMs: 0 }), impl: IMPL, ready: false };
(window as any).__bench = bench;

axios.defaults.adapter = async (config: any) => {
    const m = /\/servers\/([^/]+)\/(members|roles)$/.exec(String(config.url));
    if (!m) throw new Error('unexpected ' + config.url);
    bench.requests++;
    await new Promise(r => setTimeout(r, RTT));
    const data = m[2] === 'members' ? MEMBERS(m[1]) : ROLES(m[1]);
    return { data: JSON.parse(JSON.stringify(data)), status: 200, statusText: 'OK', headers: {}, config };
};

const servers = Array.from({ length: NSERV }, (_, i) => ({
    server_id: `s${i}`, name: `Server ${i}`, description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'owner', created_at: '2026-01-01',
}));
// A blank server is mounted first so the first measured switch is a true cold open.
servers.push({ ...servers[0], server_id: 'blank', name: 'Blank' });
const channelOf = (sid: string) => ({
    channel_id: `${sid}-c`, server_id: sid, kind: 'text' as const, name: 'general', topic: null, icon_emoji: null, icon_name: null,
    position: 0, parent_category_id: null, active_call_session_id: null, member_limit: null, max_calls: null,
});

const noop = () => {};
const asyncNoop = async () => {};
const EMPTY = {};
const SET = new Set<string>();
const NONE: never[] = [];   // stable references: Dashboard passes stable props, and the panel's defaults (`= []`, `= {}`) are fresh per render

async function main() {
    // `old` needs a copy of the pre-change panel next to the real one (untracked):
    //   git show <base>:apps/desktop/src/components/server/ServerContextPanel.tsx \
    //     > apps/desktop/src/components/server/ServerContextPanel.old.tsx
    // import.meta.glob keeps the build working when that file is absent.
    const oldPanel = import.meta.glob('../src/components/server/ServerContextPanel.old.tsx');
    const mod: any = IMPL === 'old'
        ? await Object.values(oldPanel)[0]()
        : await import('../src/components/server/ServerContextPanel');
    const Panel = mod.ServerContextPanel as React.FC<any>;

    let setIdx: (i: number) => void = noop;
    function Harness() {
        const [idx, set] = useState(servers.length - 1);
        setIdx = set;
        const srv = servers[idx];
        return (
            <Panel
                server={srv} channel={channelOf(srv.server_id)} token="bench-token" userId="me"
                allChannels={NONE} voiceParticipants={EMPTY} friendStatuses={EMPTY} myStatus="online" myCurrentGame={null}
                globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
                huddleCalls={EMPTY} categories={NONE} searchableMessages={NONE} channelPermissionsMap={EMPTY}
                onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={asyncNoop} onStartCall={noop} onBlock={noop}
            />
        );
    }
    createRoot(document.getElementById('root')!).render(<Harness />);

    // Rows that belong to the TARGET server only (names embed the server id), so the
    // previous server's leftover rows can never count as "painted".
    const rowCount = (sid: string) => {
        let n = 0;
        document.querySelectorAll('.cursor-pointer.group').forEach(el => { if ((el.textContent ?? '').includes(`_${sid}`)) n++; });
        return n;
    };
    bench.switchTo = (i: number) => new Promise(resolve => {
        const t0 = performance.now();
        let domMs = -1;
        const check = () => {
            if (domMs < 0 && rowCount(`s${i}`) >= Math.min(Math.floor(PER * 0.9), 40)) {
                domMs = performance.now() - t0;
                // two rAFs = the frame containing the rows has been produced
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    resolve({ domMs, paintMs: performance.now() - t0 });
                }));
                return true;
            }
            return false;
        };
        const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
        mo.observe(document.getElementById('root')!, { childList: true, subtree: true });
        setIdx(i);
        // The cached path can already be in the DOM by the time the observer is
        // set up (React commits synchronously inside setIdx under act-less flushSync-free rendering
        // only after this tick), so poll once on the next task as well.
        setTimeout(() => { if (check()) mo.disconnect(); }, 0);
    });
    bench.ready = true;
}
void main();
