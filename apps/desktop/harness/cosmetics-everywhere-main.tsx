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
import { StatusPicker } from '../src/components/StatusPicker';
import { ToastProvider } from '../src/contexts/ToastContext';
import { readItemOptions } from '../src/utils/profileCosmetics';
import { matchTint, readTheme } from '../src/utils/profileTheme';

/**
 * The rail's bottom-left avatar (StatusPicker) and the Friends page, with users whose halos are recoloured.
 * It imports nothing that only exists after the fix, so the same file renders the "before" checkout too:
 * StatusPicker gets BOTH the old prop (avatarDecoration) and the new one (decorationLook); an old build
 * ignores the second, a new one the first. Friends rows carry the new payload fields; an old build ignores them.
 * ?w=<pane width>
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 760);

const MY_THEME = { primary: '#2a1748', accent: '#f06a8a' };
const me = { avatar_decoration: 'lume-ring', profile_theme: MY_THEME, cosmetic_options: { d: { h: 320, i: 3 } } };
const lookOf = (u: any) => ({
    decoration: u.avatar_decoration ?? null,
    tint: matchTint(readTheme(u.profile_theme)),
    options: readItemOptions(u.cosmetic_options?.d, 'decoration', u.avatar_decoration),
});

const f = (id: string, username: string, disc: number, av: string | null, extra: Record<string, unknown>) => ({
    friend_table_id: 'ft-' + id, user_id: 'u-' + id, username, discriminator: disc, avatar_url: av,
    badges: [], avatar_decoration: null, profile_theme: null, cosmetic_options: null, ...extra,
});
const payload: any = {
    pending_incoming: [], pending_outgoing: [], blocked: [],
    accepted: [
        f('mira', 'mira', 12, 'img-mira', { avatar_decoration: 'lume-ring', cosmetic_options: { d: { h: 300 } } }),
        f('jun', 'jun', 4081, 'img-jun', { avatar_decoration: 'aurora-ring', cosmetic_options: { d: { c: 3 } } }),
        f('sana', 'sana', 7, 'img-sana', { avatar_decoration: 'abyss-halo', profile_theme: { primary: '#2a1748', accent: '#f06a8a' } }),
        f('okoye', 'okoye', 99, 'img-okoye', { avatar_decoration: 'lume-ring', cosmetic_options: { d: { h: 120, i: 3 } } }),
        f('elena', 'elena', 31, 'img-elena', { avatar_decoration: 'neon-ring', cosmetic_options: { d: { c: 1 } } }),
        f('kenji', 'kenji (stock halo)', 3, 'img-kenji', { avatar_decoration: 'lume-ring' }),
    ],
};
const statuses: any = Object.fromEntries(payload.accepted.map((a: any) => [a.user_id, { status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: null }]));
const noop = () => {};

createRoot(document.getElementById('root')!).render(
    <ToastProvider>
        <div style={{ display: 'flex', height: 720, fontFamily: 'Nunito, sans-serif', color: '#F4F7FF' }}>
            <nav data-testid="rail" style={{ width: 72, flex: 'none', background: 'var(--cl-abyss, #070B18)', borderRight: '1px solid var(--cl-border, #1b2547)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 14 }}>
                <div data-testid="status-picker" style={{ width: 72, display: 'flex', justifyContent: 'center' }}>
                    <StatusPicker
                        {...({ avatarDecoration: me.avatar_decoration, decorationLook: lookOf(me) } as any)}
                        myStatus="online" onSetStatus={noop} username="me" avatarAttachmentId="img-me" userId="u-me" token="t"
                    />
                </div>
            </nav>
            <div id="host" data-testid="friends" style={{ width: W, display: 'flex', flexDirection: 'column' }}>
                <FriendsPane onStartChat={noop} friends={payload} friendsStatus={'ready' as any} onRefresh={() => Promise.resolve()} onStartCall={noop} friendStatuses={statuses} />
            </div>
        </div>
    </ToastProvider>
);
