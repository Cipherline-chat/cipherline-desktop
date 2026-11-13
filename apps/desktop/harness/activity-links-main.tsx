/* eslint-disable -- visual harness, not shipped */
// Every surface that draws a friend's "Listening to / Watching" line, fed VERY long titles, at narrow widths:
//   friends   the Friends page (REAL FriendsPane)
//   sidebar   the sidebar friends list (replica of Dashboard's row markup: <p class="truncate"><StatusLine/></p>)
//   members   the member list (replica of ServerContextPanel / Dashboard's member row: a flex column)
//   card      the DM panel / popout profile card (REAL ProfilePopoutCard): activity row + presence line
//   full      the full profile's activity rows (REAL ProfileActivityRow, variant full)
//   settings  Settings > Connections > Listening status (REAL ConnectionsPane, media read stubbed)
//   logos     every platform logo at 14 / 16 / 20 px (only on a build that has PlatformLogo)
// ?scene=<one of the above> renders just that one; ?w=<px> overrides the scene width.
// The page imports nothing that only exists after the change, so the same harness shoots the "before" too.
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import FriendsPane from '../src/components/FriendsPane';
import { ToastProvider } from '../src/contexts/ToastContext';
import { StatusLine } from '../src/components/StatusLine';
import { ProfilePopoutCard } from '../src/components/profile/ProfilePopoutCard';
import { ProfileActivityRow } from '../src/components/profile/ProfileActivityRow';
import { buildProfileCardData } from '../src/components/profile/buildProfileCardData';
import { ProfilePresence, ProfileAvatarBadge } from '../src/components/profile/ProfilePresence';
import { ConnectionsPane } from '../src/components/integrations/ConnectionsPane';
import { listeningStore, type Listening } from '../src/utils/integrations/listening';
import secureLocalStore from '../src/utils/secureLocalStore';

loadWebFonts();
const q = new URLSearchParams(location.search);
const SCENE = q.get('scene');
const W = q.get('w') ? Number(q.get('w')) : null;

// Optional (absent on the "before" build).
const logoMods = import.meta.glob(['../src/components/integrations/PlatformLogo.tsx', '../src/components/integrations/platformLogoData.tsx'], { eager: true }) as Record<string, any>;
const LogoMod = Object.keys(logoMods).length === 2 ? Object.assign({}, ...Object.values(logoMods)) : null;
const linkMods = import.meta.glob('../src/utils/integrations/activityLinks.ts', { eager: true }) as Record<string, any>;
const activityLink = (Object.values(linkMods)[0] as any)?.activityLink ?? (() => null);

const VIDEO = "I Spent 100 Days Building the World's Largest Underwater Base in Minecraft Hardcore (Full Movie, No Commentary) - Part 3 of 4";
const CHANNEL = 'Some Extremely Long Channel Name Gaming & Entertainment Official';
const SONG = 'Symphony No. 9 in D Minor, Op. 125 "Choral": IV. Presto - Allegro assai - Allegro assai vivace (Alla marcia) - Andante maestoso';
const ARTIST = 'Royal Concertgebouw Orchestra, Berliner Philharmoniker & Wiener Singverein';
const ALBUM = 'Beethoven: The Complete Symphonies (Remastered 2026 Deluxe Anniversary Edition)';

const IDS = { a: '11111111-1111-4111-8111-1111111111aa', b: '11111111-1111-4111-8111-1111111111bb', c: '11111111-1111-4111-8111-1111111111cc', d: '11111111-1111-4111-8111-1111111111dd' };
const now = Date.now();
const rec = (o: Partial<Listening>): Listening => ({ kind: 'watching', source: 'youtube', track: VIDEO, artist: CHANNEL, album: null, startedAt: now - 60_000, durationMs: null, endsAt: now + 3600_000, ...o });
listeningStore.set(IDS.a, rec({}));
listeningStore.set(IDS.b, rec({ kind: 'listening', source: 'spotify', track: SONG, artist: ARTIST, album: ALBUM, durationMs: 1_400_000 }));
listeningStore.set(IDS.c, rec({ source: 'browser' }));
listeningStore.set(IDS.d, rec({ kind: 'listening', source: 'tidal', track: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine' }));

const status = (id: string, custom: string | null = null) => ({ status: 'online', custom_status_text: custom, custom_status_emoji: custom ? '🎧' : null, custom_status_expires_at: null, current_game: null, on_mobile: false });
const friendStatuses: any = { [IDS.a]: status(IDS.a), [IDS.b]: status(IDS.b), [IDS.c]: status(IDS.c), [IDS.d]: status(IDS.d, 'brb, dinner') };
const names: Record<string, string> = { [IDS.a]: 'nightowl', [IDS.b]: 'beethoven_fan_99', [IDS.c]: 'browser_buddy', [IDS.d]: 'mira' };

const Box: React.FC<{ id: string; title: string; w: number; children: React.ReactNode }> = ({ id, title, w, children }) => (
    <section data-scene={id} style={{ width: W ?? w, flex: 'none' }}>
        <div style={{ font: '700 11px/1.4 Nunito, sans-serif', color: '#A7B3D4', margin: '0 0 6px' }}>{title} · {W ?? w}px</div>
        <div style={{ outline: '1px dashed #2A3558' }}>{children}</div>
    </section>
);

const Friends = () => (
    <Box id="friends" title="Friends page (FriendsPane)" w={360}>
        <ToastProvider>
            <div style={{ height: 700, display: 'flex', flexDirection: 'column', fontFamily: 'Nunito, sans-serif', color: '#F4F7FF' }}>
                <FriendsPane onStartChat={() => {}} friendsStatus={'ready' as any} onRefresh={() => Promise.resolve()} onStartCall={() => {}} friendStatuses={friendStatuses}
                    friends={{ pending_incoming: [], pending_outgoing: [], blocked: [], accepted: Object.values(IDS).map((id, i) => ({ user_id: id, username: names[id], discriminator: 10 + i, avatar_url: null })) } as any} />
            </div>
        </ToastProvider>
    </Box>
);

/** Dashboard.tsx ~13250: the sidebar's friends rows. */
const Sidebar = () => (
    <Box id="sidebar" title="Sidebar friends (Dashboard row markup)" w={240}>
        <div style={{ background: 'var(--cl-deep, #131A30)', padding: 8 }}>
            {Object.values(IDS).map((id) => (
                <div key={id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg group">
                    <div className="w-8 h-8 rounded-full shrink-0" style={{ background: '#243056' }} />
                    <div className="flex-1 min-w-0 pr-2 cursor-pointer">
                        <p className="font-semibold text-[13px] text-white truncate leading-tight">{names[id]}</p>
                        <p className="text-[11px] truncate leading-tight" style={{ color: 'var(--cl-faint)' }}>
                            <StatusLine entry={friendStatuses[id]} userId={id} renderGame={(g) => g} fallback="Online" />
                        </p>
                    </div>
                </div>
            ))}
        </div>
    </Box>
);

/** ServerContextPanel.tsx ~1640 / Dashboard.tsx ~13740: a member row. */
const Members = () => (
    <Box id="members" title="Member list (ServerContextPanel row markup)" w={220}>
        <div style={{ background: 'var(--cl-deep, #131A30)', padding: 8 }}>
            {Object.values(IDS).map((id) => (
                <div key={id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-md">
                    <div className="w-8 h-8 rounded-full shrink-0" style={{ background: '#243056' }} />
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1 text-sm font-medium text-white"><span className="truncate">{names[id]}</span></div>
                        <StatusLine entry={friendStatuses[id]} userId={id} renderGame={(g) => g} className="text-[12px] text-white/45 leading-tight mt-0.5" />
                    </div>
                </div>
            ))}
        </div>
    </Box>
);

const profile = (id: string, custom: string | null) => ({
    user_id: id, username: names[id], discriminator: 7, avatar_url: null, banner_url: null, last_seen_at: null, status: 'online',
    custom_status_text: custom, custom_status_emoji: custom ? '🎧' : null, bio: null, level: 3, badges: [], showcase: { blocks: [] }, links: [],
} as any);
const linkFor = (l: Listening) => activityLink({ ...l });
const activityFor = (id: string) => {
    const l = listeningStore.get(id)!;
    const link = linkFor(l);
    return {
        kind: l.kind, title: l.track,
        detail: l.kind === 'watching' ? `${l.artist} · YouTube` : `by ${l.artist} on Spotify`,
        source: l.source, progress: l.durationMs ? { startedAt: l.startedAt, durationMs: l.durationMs } : null,
        url: link?.url ?? null, linkLabel: link?.label ?? null,
    };
};
const Card: React.FC<{ id: string; custom: string | null }> = ({ id, custom }) => {
    const p = profile(id, custom);
    const data = buildProfileCardData(p, { isOwn: false, anniversary: 0, myInterests: [], mostPlayed: [], verified: false });
    const entry = { ...friendStatuses[id], custom_status_text: custom, custom_status_emoji: custom ? '🎧' : null } as any;
    return (
        <div className="app-pane4" style={{ background: 'var(--cl-surface, #121A33)', borderRadius: 16, padding: '8px 8px 14px' }}>
            <ProfilePopoutCard userId={id} token="" isSelf={false} className="ppo--panel" testId={`card-${id}`} label="profile" enter={false} data={data}
                avatarId={null} bannerId={null} avatarSrc={null} bannerSrc={null}
                presence={<ProfilePresence entry={entry} userId={id} onMobile={false} lastSeen={null} />}
                activities={[activityFor(id)]}
                avatarBadge={<ProfileAvatarBadge entry={entry} onMobile={false} />}
                mutuals={null} onOpenFull={() => { const w = window as unknown as { __openedFull?: number }; w.__openedFull = (w.__openedFull ?? 0) + 1; }} brief />
        </div>
    );
};
const Cards = () => (
    <Box id="card" title="DM panel / popout profile card (ProfilePopoutCard)" w={280}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Card id={IDS.a} custom={null} />
            <Card id={IDS.b} custom="studying, headphones on" />
        </div>
    </Box>
);

const Full = () => (
    <Box id="full" title="Full profile activity (ProfileActivityRow full)" w={300}>
        <div style={{ background: 'var(--cl-deep, #131A30)', padding: 12 }}>
            <ProfileActivityRow variant="full" activities={[activityFor(IDS.a), activityFor(IDS.b), { kind: 'watching', title: VIDEO, detail: 'VLC', source: 'other' } as any]} />
        </div>
    </Box>
);

// Settings > Connections: the OS media read, stubbed with a very long song.
(window as any).electronAPI = {
    getNowPlaying: async () => ({ supported: true, issue: null, playing: { kind: 'listening', source: 'spotify', title: SONG, artist: ARTIST, album: ALBUM, durationMs: 1_400_000, positionMs: 60_000, art: null, player: 'Spotify' } }),
    mediaStop: () => {},
};
const Settings = () => (
    <Box id="settings" title="Settings > Connections (ConnectionsPane)" w={380}>
        <div style={{ background: 'var(--cl-deep, #131A30)', padding: 12, color: '#F4F7FF' }}><ConnectionsPane /></div>
    </Box>
);

const Logos = () => {
    if (!LogoMod) return null;
    const { PLATFORM_LOGOS, ActivitySourceIcon } = LogoMod;
    const rows: Array<[string, 'listening' | 'watching']> = [
        ['spotify', 'listening'], ['apple_music', 'listening'], ['youtube_music', 'listening'], ['tidal', 'listening'], ['deezer', 'listening'],
        ['soundcloud', 'listening'], ['amazon_music', 'listening'], ['youtube', 'watching'], ['netflix', 'watching'], ['plex', 'watching'],
        ['twitch', 'watching'], ['prime_video', 'watching'], ['disney_plus', 'watching'], ['hulu', 'watching'], ['crunchyroll', 'watching'],
        ['jellyfin', 'watching'], ['browser', 'watching'], ['other', 'listening'],
    ];
    return (
        <Box id="logos" title="Logos 14 / 16 / 20 px (fallback = note / TV)" w={300}>
            <div style={{ background: 'var(--cl-deep, #131A30)', padding: 12, display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '6px 14px', alignItems: 'center', font: '600 12px Nunito, sans-serif', color: '#DCE3F5' }}>
                {rows.map(([s, k]) => (
                    <React.Fragment key={s}>
                        <span>{s}{PLATFORM_LOGOS[s] ? '' : ' (fallback)'}</span>
                        {[14, 16, 20].map((z) => <span key={z} className="text-cl-ok" style={{ display: 'inline-flex' }}><ActivitySourceIcon kind={k} source={s} size={z} /></span>)}
                    </React.Fragment>
                ))}
            </div>
        </Box>
    );
};

const ALL: Record<string, React.FC> = { friends: Friends, sidebar: Sidebar, members: Members, card: Cards, full: Full, settings: Settings, logos: Logos };
const shown = SCENE ? [SCENE] : Object.keys(ALL);
// main.tsx hydrates the encrypted store before the first paint; ConnectionsPane reads its prefs from it.
await secureLocalStore.hydrate().catch(() => {});
createRoot(document.getElementById('root')!).render(
    <div id="stage" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: 20, alignItems: 'flex-start', width: SCENE ? 'max-content' : 1400 }}>
        {shown.map((s) => { const C = ALL[s]; return C ? <C key={s} /> : null; })}
    </div>,
);
