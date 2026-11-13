/* eslint-disable -- visual harness, not shipped */
// "Open someone's level" (owner 2026-11-13): the REAL ProfilePopoutCard / ProfileFullView fed made-up
// public profiles. ?scene=
//   card     the preview card (the level medallion is the button)
//   mid      full profile of a mid-level user (the shots press the level)
//   max      a level 10 user
//   eggs     a level from easter eggs alone (no achievements)
//   hidden   a profile whose level the server did not share
//   self     your own profile (local progress allowed)
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
import { ProfileFullView } from '../src/components/profile/ProfileFullView';
import { buildProfileCardData } from '../src/components/profile/buildProfileCardData';
import { ProfilePresence, ProfileAvatarBadge } from '../src/components/profile/ProfilePresence';
import { ACHIEVEMENTS } from '../src/utils/achievements/catalog';

loadWebFonts();
const q = new URLSearchParams(location.search);
const SCENE = q.get('scene') ?? 'mid';
const w = window as any;

const egg = (count: number, tier: number) => ({ badge_id: 'egg-hunter', icon: `egg-tier-${tier}`, color: ['', 'cyan', 'orange', 'blue', 'gold'][tier], label: `Egg hunter · ${count} easter eggs found`, sort_order: 1000, count });
const months = ['2026-02', '2026-03', '2026-05', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
const unlock = (ids: string[]) => ids.map((id, i) => ({ id, month: months[i % months.length] }));

// mira: voice-500h (silver 3) + 4 starters (bronze 1 each) = 7, + 4 eggs = 11 -> level 3, "11 of 16 points to level 4".
const MID = ['voice-500h', 'msgs-10', 'voice-10m', 'profile-custom', 'verify-1'];
// Level 10: every non-secret achievement + one secret, + 27 eggs.
const MAX = ACHIEVEMENTS.filter((a) => !a.secret).map((a) => a.id).concat(['night-shift']);
const tierPts = { bronze: 1, silver: 3, gold: 6 } as const;
const pts = (ids: string[]) => ids.reduce((s, id) => s + tierPts[ACHIEVEMENTS.find((a) => a.id === id)!.tier], 0);

const base = {
    discriminator: 7, avatar_url: 'img-mira', banner_url: null, last_seen_at: null,
    status: 'online', custom_status_text: null, custom_status_emoji: null, is_pro: false, pro_since: null,
    showcase: { blocks: ['achievements', 'interests'], top_achievements: [] }, interests: ['hiking', 'synthwave', 'linux'],
    bio: 'Kelp forests, synths and late-night co-op.', high_five_count: 3,
} as any;
const PROFILES: Record<string, any> = {
    card: { ...base, user_id: 'u-mira', username: 'mira', level: 3, level_points: 11, achievement_count: MID.length, badges: [egg(4, 1)] },
    mid: { ...base, user_id: 'u-mira', username: 'mira', level: 3, level_points: 11, achievement_count: MID.length, badges: [egg(4, 1)] },
    max: { ...base, user_id: 'u-dawson', username: 'dawson', avatar_url: 'img-kenji', is_pro: true, pro_since: '2025-02', level: 10, level_points: pts(MAX) + 27, achievement_count: MAX.length, badges: [egg(27, 4)], profile_theme: { primary: '#2a1748', accent: '#f06a8a' } },
    eggs: { ...base, user_id: 'u-jun', username: 'jun', avatar_url: 'img-jun', level: 2, level_points: 5, achievement_count: 0, badges: [egg(5, 1)], showcase: { blocks: ['interests'] } },
    hidden: { ...base, user_id: 'u-sana', username: 'sana', avatar_url: 'img-sana', level: undefined, level_points: undefined, achievement_count: 3, badges: [] },
    self: { ...base, user_id: 'u-me', username: 'Dawson', avatar_url: 'img-me', level: 3, level_points: 11, achievement_count: MID.length, badges: [egg(4, 1)] },
};
const p = PROFILES[SCENE] ?? PROFILES.mid;
w.__p = p;
w.__ach = { unlocked: SCENE === 'max' ? unlock(MAX) : SCENE === 'eggs' ? [] : SCENE === 'hidden' ? unlock(['msgs-10', 'voice-10m', 'verify-1']) : unlock(MID) };
w.__progress = SCENE === 'self' ? Object.fromEntries(ACHIEVEMENTS.map((a, i) => [a.id, { current: (i * 7) % 10, target: 10 }])) : null;
const isSelf = SCENE === 'self';
const data = buildProfileCardData(p, { isOwn: isSelf, anniversary: 0, myInterests: isSelf ? null : ['linux', 'chess'], mostPlayed: [], verified: false });
const entry = { status: 'online', custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false } as any;
w.__openedFull = [];

const App = () => {
    const [full, setFull] = React.useState<null | string>(SCENE === 'card' ? null : (q.get('tab') ?? 'overview'));
    if (full === null) {
        return (
            <div style={{ padding: 24, width: 340 }}>
                <div className="app-pane4" style={{ background: 'var(--cl-surface, #121A33)', borderRadius: 16, padding: '8px 8px 14px' }}>
                    <ProfilePopoutCard userId={p.user_id} token="t" isSelf={isSelf} className="ppo--panel" testId="card" label="profile" enter={false} data={data}
                        avatarId={p.avatar_url} bannerId={null}
                        presence={<ProfilePresence entry={entry} userId={p.user_id} onMobile={false} lastSeen={null} />}
                        avatarBadge={<ProfileAvatarBadge entry={entry} onMobile={false} />}
                        mutuals={null} onOpenFull={(t: string) => { w.__openedFull.push(t); setFull(t); }} brief />
                </div>
            </div>
        );
    }
    return (
        <div className="pfp-layer" style={{ top: 0 }}>
            <ProfileFullView key={full} userId={p.user_id} token="t" isSelf={isSelf} data={data} profile={null} avatarId={p.avatar_url} bannerId={null}
                presence={<ProfilePresence entry={entry} userId={p.user_id} onMobile={false} lastSeen={null} />}
                avatarBadge={<ProfileAvatarBadge entry={entry} onMobile={false} />}
                initialTab={full as any} onClose={() => {}} mutuals={isSelf ? null : { friends: [], servers: [] }} />
        </div>
    );
};
createRoot(document.getElementById('root')!).render(<App />);
