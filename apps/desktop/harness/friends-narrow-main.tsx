/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import FriendsPane from '../src/components/FriendsPane';
import { ToastProvider } from '../src/contexts/ToastContext';

// ?w=<pane width px>&long=1 (very long names)
loadWebFonts();
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 760);
const LONG = q.get('long') === '1';
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const inc = (id: string, username: string, d: number, disc: number, av?: string) => ({ friend_table_id: 'i' + id, requester_id: 'ur' + id, username, discriminator: disc, avatar_url: av ?? null, requested_at: ago(d) });
const out = (id: string, username: string, d: number, disc: number, av?: string) => ({ friend_table_id: 'o' + id, recipient_id: 'us' + id, username, discriminator: disc, avatar_url: av ?? null, requested_at: ago(d) });
const payload: any = {
    accepted: [], blocked: [],
    pending_incoming: [
        inc('1', LONG ? 'Alexandrina_the_Magnificent_of_Westmarch' : 'mira', 27, 12, 'img-mira'),
        inc('2', 'jun', 2, 4081, 'img-jun'),
        inc('3', 'sana', 0, 7),
        inc('4', LONG ? 'a_really_quite_long_display_name_indeed' : 'Okoye-Adeyemi', 29.5, 99, 'img-okoye'),
    ],
    pending_outgoing: [
        out('1', 'kenji', 26, 3, 'img-kenji'),
        out('2', LONG ? 'Alexandrina_the_Magnificent_of_Westmarch' : 'zara', 1, 4455, 'img-zara'),
        out('3', 'marco', 5, 21, 'img-marco'),
    ],
};
const noop = () => {};
createRoot(document.getElementById('root')!).render(
    <ToastProvider>
        <div id="host" style={{ width: W, height: 760, display: 'flex', flexDirection: 'column', fontFamily: 'Nunito, sans-serif', color: '#F4F7FF', outline: '1px dashed #243056' }}>
            <FriendsPane onStartChat={noop} friends={payload} friendsStatus={'ready' as any} onRefresh={() => Promise.resolve()} onStartCall={noop} friendStatuses={{}} />
        </div>
    </ToastProvider>
);
