/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import axios from 'axios';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { ToastProvider } from '../src/contexts/ToastContext';
import { EggProgressHost } from '../src/components/EggProgressHost';
import { ProfileCardNameRow, ProfileCardStatusDot } from '../src/components/ProfileCardParts';
import { EncryptedAvatar } from '../src/components/EncryptedAvatar';
import { EGG_IDS, EGG_TIERS, EGG_TIER_COLORS, eggTierFor, recordEggFound } from '../src/utils/eggProgress';
import type { ProfileBadge } from '../src/utils/profileBadges';

/**
 * Egg-hunter harness. Real ProfileCardNameRow / ProfileBadgeRow / EggProgressHost / ToastProvider;
 * the only fakes are the network (axios adapter standing in for POST /v1/profile/eggs, with the same
 * tier maths as the API), useAuth and the avatar decrypt (vite aliases).
 *
 *   ?scene=cards    four profile cards, one per tier (+ a card with an admin badge and one with none)
 *   ?scene=toast    the toast pipeline: window.__find(n) records n more distinct eggs
 *   ?scene=toast&known=12   the account already holds 12 on the server (new-install case: no toast)
 *   ?scene=dense    the friends-list size (sm) of every tier
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'cards';
const known = Number(q.get('known') ?? 0);

(window as any).__posts = [] as unknown[];
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url);
    if (/\/profile\/eggs$/.test(url)) {
        const body = JSON.parse(String(config.data));
        (window as any).__posts.push(body);
        const count = Math.max(known, new Set(body.ids).size);
        const t = eggTierFor(count);
        return { data: { tier: t?.tier ?? 0, tier_name: t?.name ?? null, count }, status: 200, statusText: 'OK', headers: {}, config };
    }
    throw new Error('unexpected ' + url);
};

const egg = (tier: number, count: number): ProfileBadge => ({
    badge_id: 'egg-hunter',
    icon: `egg-tier-${tier}`,
    color: EGG_TIER_COLORS[tier],
    label: `Egg hunter · ${EGG_TIERS[tier - 1].name} · ${count} easter eggs found`,
    sort_order: 1000,
});
const founder: ProfileBadge = { badge_id: 'b1', icon: 'star', color: 'gold', label: 'Founder', sort_order: 0 };

const NAMES = ['Mira', 'Jun', 'Sana', 'Okoye'];
const AVATARS = ['img-mira', 'img-jun', 'img-sana', 'img-me'];

const Card: React.FC<{ name: string; avatar: string; disc: number; badges?: ProfileBadge[]; caption: string }> = ({ name, avatar, disc, badges, caption }) => (
    <div data-card={caption} style={{ width: 300, background: '#131A30', border: '1px solid #1E2848', borderRadius: 18, padding: '22px 18px 20px', textAlign: 'center' }}>
        <div style={{ position: 'relative', width: 84, height: 84, margin: '0 auto 12px' }}>
            <div style={{ width: 84, height: 84, borderRadius: '50%', overflow: 'hidden' }}>
                <EncryptedAvatar attachmentId={avatar} userId={null} token="t" className="w-full h-full" fallbackSize={30} disableClickProfile />
            </div>
            <ProfileCardStatusDot color="#2BD97C" title="Online" />
        </div>
        <ProfileCardNameRow name={name} discriminator={disc} badges={badges} />
        <div style={{ marginTop: 10, fontSize: 11, color: '#5E6B8F', letterSpacing: '.08em', textTransform: 'uppercase' }}>{caption}</div>
    </div>
);

const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{ minHeight: '100vh', padding: 32, fontFamily: 'Nunito, sans-serif', color: '#F4F7FF', background: '#0B0F1E' }}>{children}</div>
);

const CardsScene = () => (
    <Stage>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            {EGG_TIERS.map((t, i) => (
                <Card key={t.tier} name={NAMES[i]} avatar={AVATARS[i]} disc={1000 + i * 111} badges={[egg(t.tier, t.min)]} caption={`tier ${t.tier} · ${t.name} · ${t.min}`} />
            ))}
            <Card name="Dawson" avatar="img-me" disc={7} badges={[founder, egg(3, 12)]} caption="admin badge + Deep Diver" />
            <Card name="Newcomer" avatar="img-jun" disc={4242} badges={[]} caption="no badge (under 3 eggs)" />
        </div>
    </Stage>
);

const DenseScene = () => (
    <Stage>
        <div style={{ width: 360, background: '#0F1528', border: '1px solid #1E2848', borderRadius: 14, padding: 10 }}>
            {EGG_TIERS.map((t, i) => (
                <div key={t.tier} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px' }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', overflow: 'hidden' }}>
                        <EncryptedAvatar attachmentId={AVATARS[i]} userId={null} token="t" className="w-full h-full" fallbackSize={16} disableClickProfile />
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#E6ECFF' }}>
                        {NAMES[i]}
                        <DenseBadges badges={[egg(t.tier, t.min)]} />
                    </div>
                </div>
            ))}
        </div>
    </Stage>
);
import { ProfileBadgeRow } from '../src/components/ProfileBadgeRow';
const DenseBadges: React.FC<{ badges: ProfileBadge[] }> = ({ badges }) => <ProfileBadgeRow badges={badges} size="sm" className="ml-1.5 align-middle" />;

const ToastScene = () => (
    <ToastProvider>
        <Stage>
            <p style={{ color: '#5E6B8F', fontSize: 13 }}>Toast pipeline: recordEggFound → debounce → POST /profile/eggs (stub) → tier event → toast.</p>
        </Stage>
        <EggProgressHost />
    </ToastProvider>
);

let cursor = 0;
(window as any).__find = (n: number) => { for (let i = 0; i < n; i++) recordEggFound(EGG_IDS[cursor++ % EGG_IDS.length]); };

const SCENES: Record<string, React.FC> = { cards: CardsScene, dense: DenseScene, toast: ToastScene };
const Scene = SCENES[scene] ?? CardsScene;
(async () => {
    await secureLocalStore.hydrate();
    createRoot(document.getElementById('root')!).render(<Scene />);
})();
