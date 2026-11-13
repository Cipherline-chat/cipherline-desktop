/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/styles/night-dive.css';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import { ProfilePopoutCard } from '../src/components/profile/ProfilePopoutCard';
import { buildProfileCardData } from '../src/components/profile/buildProfileCardData';
import { ProfilePresence, ProfileAvatarBadge } from '../src/components/profile/ProfilePresence';
import { ClButton } from '../src/components/cl';
import { Hand } from 'lucide-react';

/** The DM right-hand panel's profile card (DmProfileCard renders exactly this ProfilePopoutCard with className ppo--panel),
 *  fed a made-up profile, at the panel's default-ish width. ?w=<px> */
loadWebFonts();
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 320);
const svg = (s: string) => `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
const FACE = svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="b" x2="0" y2="1"><stop offset="0" stop-color="#5B7FA8"/><stop offset="1" stop-color="#2E4566"/></linearGradient></defs><rect width="100" height="100" fill="url(#b)"/><ellipse cx="50" cy="98" rx="38" ry="26" fill="#3B3F4C"/><rect x="43" y="58" width="14" height="16" fill="#C98F6B"/><ellipse cx="50" cy="44" rx="18" ry="21" fill="#D9A27E"/><path d="M31 42 Q32 18 50 19 Q70 18 69 42 Q66 30 50 29 Q36 30 31 42Z" fill="#3A2A22"/></svg>`);
const BANNER = svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 220"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B1D6E"/><stop offset=".55" stop-color="#B0346A"/><stop offset="1" stop-color="#F08A4B"/></linearGradient></defs><rect width="600" height="220" fill="url(#g)"/><circle cx="470" cy="70" r="38" fill="#FFE7B8" opacity=".85"/><path d="M0 170 L90 120 L170 160 L260 100 L360 165 L450 125 L600 175 L600 220 L0 220Z" fill="#1E0F38" opacity=".75"/></svg>`);

const base = {
    user_id: 'u-demo', discriminator: 7, avatar_url: 'x', banner_url: 'x', last_seen_at: null,
    status: 'online', custom_status_text: null, custom_status_emoji: null,
} as any;
const custom = {
    ...base, username: 'nightowl',
    bio: 'Rally sim addict, synth nerd, will absolutely talk your ear off about kelp forests. DMs open for co-op.',
    custom_status_text: 'grinding DiRT stages', custom_status_emoji: '🏁',
    is_pro: true, pro_since: '2026-06', level: 14, achievement_count: 31, high_five_count: 12,
    profile_theme: { primary: '#2a1748', accent: '#f06a8a' },
    avatar_decoration: q.get('deco') ?? 'aurora-ring', profile_effect: q.get('fx') ?? 'god-rays',
    time_zone: 'America/Chicago',
    badges: [{ badge_id: 'b1', icon: 'sparkles', color: 'violet', label: 'Early tester', sort_order: 0 }],
    showcase: { blocks: ['achievements', 'interests', 'links'], top_achievements: ['msgs-50000', 'streak-30', 'voice-500h'] },
    interests: ['gaming', 'music', 'cars', 'ocean'],
    links: [{ platform: 'github', handle: 'nightowl' }],
    friends_since: '2026-08',
};
const plain = { ...base, username: 'plainjane', bio: null, avatar_url: null, banner_url: null, level: 1 };

const mutuals = { friends: [
    { user_id: 'm1', username: 'kenji', discriminator: 3, avatar_url: null },
    { user_id: 'm2', username: 'zara', discriminator: 4455, avatar_url: null },
], servers: [{ server_id: 's1', name: 'Rally Club' }] };

// A stand-in album cover (a raster data: URI, like the blob: a friend's cover arrives as).
const COVER = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 120;
    const g = c.getContext('2d')!; const gr = g.createLinearGradient(0, 0, 120, 120);
    gr.addColorStop(0, '#1d2b64'); gr.addColorStop(1, '#f8507a'); g.fillStyle = gr; g.fillRect(0, 0, 120, 120);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = 'bold 22px sans-serif'; g.fillText('M83', 36, 68);
    return c.toDataURL('image/png');
})();
const ACTS: Record<string, any[]> = {
    none: [],
    listen: [{ kind: 'listening', title: 'Midnight City', detail: 'M83 - Hurry Up, We\'re Dreaming', source: 'spotifast', progress: { startedAt: Date.now() - 95_000, durationMs: 243_000 } }],
    cover: [{ kind: 'listening', title: 'Midnight City', detail: 'M83 - Hurry Up, We\'re Dreaming', source: 'spotify', art: COVER, progress: { startedAt: Date.now() - 95_000, durationMs: 243_000 } }],
    watch: [{ kind: 'watching', title: 'The Wolf of Wall Street - Official Trailer', detail: 'Paramount Pictures', source: 'browser' }],
};
const playing = (ACTS[q.get('act') ?? 'listen'] ?? ACTS.listen) as any;

function Panel({ profile, custom: isCustom }: { profile: any; custom: boolean }) {
    const data = buildProfileCardData(profile, { isOwn: false, anniversary: 0, myInterests: ['music', 'ocean'], mostPlayed: [], verified: true });
    const entry = { status: profile.status, custom_status_text: profile.custom_status_text, custom_status_emoji: profile.custom_status_emoji, custom_status_expires_at: null, current_game: null, on_mobile: false } as any;
    return (
        <div className="app-pane4" data-testid={isCustom ? 'panel-custom' : 'panel-plain'}
            style={{ width: W, background: 'var(--cl-surface, #121A33)', borderRadius: 16, paddingBottom: 14 }}>
            <div className="px-2 py-2"><div style={{ height: 34, borderRadius: 11, background: 'rgba(255,255,255,.05)', color: 'rgba(255,255,255,.4)', fontSize: 13, display: 'flex', alignItems: 'center', paddingLeft: 12 }}>Search in chat</div></div>
            <div className="px-2 pt-1 shrink-0 mb-3.5">
                <ProfilePopoutCard userId={profile.user_id} token="" isSelf={false} className="ppo--panel" testId="dm-profile-card"
                    label={`${profile.username}'s profile`} enter={false} data={data}
                    avatarId={null} bannerId={null}
                    avatarSrc={isCustom ? FACE : null} bannerSrc={isCustom ? BANNER : null}
                    presence={<ProfilePresence entry={entry} userId={profile.user_id} onMobile={false} lastSeen={null} />}
                    activities={isCustom ? playing : []}
                    avatarBadge={<ProfileAvatarBadge entry={entry} onMobile={false} />}
                    mutuals={null}
                    onOpenFull={() => {}}
                    brief
                />
            </div>
            <div style={{ padding: '0 16px', color: 'rgba(255,255,255,.45)', fontSize: 12 }}>Shared · Media 4 · Files 1 · Links 7</div>
        </div>
    );
}

/** ?scene=dm: one DM window (a stand-in chat column) with the panel on the right, as the app lays it out. */
const Bubble = ({ me, text }: { me?: boolean; text: string }) => (
    <div style={{ alignSelf: me ? 'flex-end' : 'flex-start', maxWidth: '70%', padding: '9px 13px', borderRadius: 14, fontSize: 14,
        background: me ? 'rgba(45,212,191,.16)' : 'rgba(255,255,255,.06)', color: 'rgba(255,255,255,.88)' }}>{text}</div>
);
const DmWindow = () => (
    <div style={{ display: 'flex', gap: 8, padding: 16, width: 1180, height: 820, boxSizing: 'border-box', background: '#0B1022' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--cl-surface, #121A33)', borderRadius: 16, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,.06)', color: '#fff', fontWeight: 700, fontSize: 15 }}>@ nightowl</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8, padding: 18 }}>
                <Bubble text="you on tonight?" />
                <Bubble me text="yeah after dinner, ~8" />
                <Bubble text="bet. bringing the rally setup" />
            </div>
            <div style={{ margin: 14, padding: '12px 14px', borderRadius: 12, background: 'rgba(255,255,255,.05)', color: 'rgba(255,255,255,.4)', fontSize: 14 }}>Message @nightowl</div>
        </div>
        <Panel profile={custom} custom />
    </div>
);

createRoot(document.getElementById('root')!).render(q.get('scene') === 'dm' ? <DmWindow /> : (
    <div style={{ display: 'flex', gap: 28, padding: 24, alignItems: 'flex-start' }}>
        <Panel profile={custom} custom />
        <Panel profile={plain} custom={false} />
    </div>
));
