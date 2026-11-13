/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { loadWebFonts } from '../src/utils/webFonts';
import React, { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { ToastProvider, useToast } from '../src/contexts/ToastContext';
import { LevelUpCelebration } from '../src/components/levelUp/LevelUpCelebration';
import { LevelUpHost } from '../src/components/levelUp/LevelUpHost';
import { holdToasts } from '../src/utils/toastHold';
import { ACHIEVEMENT_UNLOCK_EVENT } from '../src/utils/achievements/keys';
import { levelUpKey } from '../src/utils/levelUp';

/**
 * The level-up celebration over a stand-in of the signed-in app.
 *
 *   ?scene=card   the REAL LevelUpCelebration, mounted at once (frames / video):
 *                 &variant=big|short &level=2 &from=1 &motion=full|still &toast=1 (an achievement
 *                 toast underneath, held exactly as LevelUpHost holds it)
 *                 window.__lvu: { closed, seek(ms) }
 *   ?scene=flow   the REAL LevelUpHost + toast stack, driven like the app drives it:
 *                 window.__unlock(level, points, next)  AchievementsHost's sequence: the unlock
 *                     event + toast, then the server ack (id null) with the account now at `level`
 *                 window.__server                       what /auth/me says (auth stub)
 *                 window.__record()                     the persisted level-up record
 *                 window.__refreshes                    how many times /auth/me was re-read
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'card';
const w = window as any;
w.__lvu = {
    closed: 0,
    seek(ms: number) { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } },
};

const Avatar: React.FC<{ c: string; s?: number }> = ({ c, s = 36 }) => <i style={{ width: s, height: s, borderRadius: '50%', background: c, flex: 'none', display: 'block' }} />;
const MESSAGES: Array<[string, string, string, string]> = [
    ['Sam', '#FF8FB1', '9:12 PM', 'ok the cave level finally clicked, you have to go LEFT at the glowing coral'],
    ['Robin', '#25E0C8', '9:13 PM', 'no way. I spent an hour going right'],
    ['Sam', '#FF8FB1', '9:13 PM', 'everyone does. the map lies'],
    ['Jules', '#FFC94D', '9:15 PM', 'are we still on for saturday? I can host'],
    ['Robin', '#25E0C8', '9:16 PM', 'yes! I will bring snacks. also sending the screenshots now'],
    ['Sam', '#FF8FB1', '9:16 PM', 'perfect, see you then'],
];
/** A quiet stand-in for the app: rail, channel list, a chat, the composer, members. */
const Backdrop: React.FC = () => (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--cl-abyss)', fontFamily: 'Nunito, sans-serif', color: 'var(--cl-text)' }}>
        <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 14px', background: '#080B17', fontFamily: 'Fredoka', fontWeight: 600, fontSize: 13, color: 'var(--cl-muted)' }}>Cipherline</div>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div style={{ width: 72, background: '#080B17', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 10 }}>
                {['var(--cl-lume)', '#5e8ee0', '#FF8FB1', '#FFC94D', 'var(--cl-surface)'].map((c, i) => <i key={i} style={{ width: 46, height: 46, borderRadius: i === 0 ? 16 : '50%', background: c, opacity: i === 0 ? 1 : 0.85 }} />)}
            </div>
            <div style={{ width: 236, background: 'var(--cl-deep)', padding: '16px 12px', fontSize: 14, color: 'var(--cl-muted)' }}>
                <div style={{ fontFamily: 'Fredoka', fontWeight: 600, color: 'var(--cl-text)', fontSize: 16, margin: '0 6px 14px' }}>Deep Divers</div>
                {['# general', '# screenshots', '# saturday-plans', '# off-topic'].map((c, i) => (
                    <div key={c} style={{ padding: '7px 8px', borderRadius: 8, background: i === 0 ? 'var(--cl-raise)' : 'transparent', color: i === 0 ? 'var(--cl-text)' : undefined }}>{c}</div>
                ))}
                <div style={{ margin: '18px 6px 8px', fontSize: 11, fontWeight: 800, letterSpacing: '.08em' }}>VOICE</div>
                <div style={{ padding: '7px 8px' }}>Lounge</div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ height: 52, borderBottom: '1px solid var(--cl-border)', display: 'flex', alignItems: 'center', padding: '0 20px', fontFamily: 'Fredoka', fontWeight: 600 }}># general</div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '16px 22px', gap: 16 }}>
                    {MESSAGES.map(([who, c, at, text], i) => (
                        <div key={i} style={{ display: 'flex', gap: 12 }}>
                            <Avatar c={c} />
                            <div>
                                <div style={{ fontSize: 14 }}><b style={{ color: c }}>{who}</b> <span style={{ color: 'var(--cl-faint, #6B7699)', fontSize: 12, marginLeft: 6 }}>{at}</span></div>
                                <div style={{ fontSize: 14, color: 'var(--cl-text)', marginTop: 2 }}>{text}</div>
                            </div>
                        </div>
                    ))}
                </div>
                <div style={{ margin: '0 20px 20px', height: 46, borderRadius: 14, background: 'var(--cl-surface)', color: 'var(--cl-faint, #6B7699)', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 14 }}>Message #general</div>
            </div>
            <div style={{ width: 220, background: 'var(--cl-deep)', padding: '16px 14px', fontSize: 14, color: 'var(--cl-muted)' }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', marginBottom: 10 }}>ONLINE, 3</div>
                {[['Robin', '#25E0C8'], ['Sam', '#FF8FB1'], ['Jules', '#FFC94D']].map(([n, c]) => (
                    <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}><Avatar c={c} s={30} />{n}</div>
                ))}
            </div>
        </div>
    </div>
);

/** What AchievementsHost pushes for one unlock (same text shape, same icon markup). */
const pushUnlockToast = (push: ReturnType<typeof useToast>['push']) => push({
    kind: 'success', title: 'Achievement unlocked', message: 'Message in a Bottle: send your first message', durationMs: 8000,
    icon: <span className="inline-flex items-center justify-center rounded-full border w-7 h-7 bg-orange-500/15 border-orange-400/40 text-orange-300"><Trophy size={16} aria-hidden /></span>,
});

const Card: React.FC = () => {
    const { push } = useToast();
    const [open, setOpen] = useState(true);
    const variant = (q.get('variant') === 'short' ? 'short' : 'big') as 'big' | 'short';
    const level = Number(q.get('level') ?? 2);
    const from = Number(q.get('from') ?? level - 1);
    const motion = (q.get('motion') === 'still' ? 'still' : 'full') as 'full' | 'still';
    useEffect(() => {
        if (q.get('toast') === '1') pushUnlockToast(push);
        const release = holdToasts();
        return release;
    }, []);
    return (
        <>
            <Backdrop />
            {open && (
                <LevelUpCelebration
                    level={level} from={from} variant={variant} motion={motion}
                    points={Number(q.get('points') ?? level * level + 1)} nextPoints={level >= 10 ? null : (level + 1) * (level + 1)}
                    onClose={() => { w.__lvu.closed++; setOpen(false); }}
                />
            )}
        </>
    );
};

const Flow: React.FC = () => {
    const { push } = useToast();
    useEffect(() => {
        w.__unlock = (level: number, points: number, next: number | null) => {
            window.dispatchEvent(new CustomEvent(ACHIEVEMENT_UNLOCK_EVENT, { detail: { id: 'msgs-1' } }));
            setTimeout(() => pushUnlockToast(push), 1500); // AchievementsHost gathers for 1.5 s
            setTimeout(() => {                           // its push lands; the server now has the unlock
                w.__server = { level, points, next_level_points: next, showcase_slots: 3 };
                window.dispatchEvent(new CustomEvent(ACHIEVEMENT_UNLOCK_EVENT, { detail: { id: null } }));
            }, 3200);
        };
        w.__record = () => secureLocalStore.getItem(levelUpKey('me'));
    }, []);
    return (
        <>
            <Backdrop />
            <LevelUpHost />
        </>
    );
};

(async () => {
    await secureLocalStore.hydrate();
    secureLocalStore.setItem('cipherline_user_id', 'me'); // bind the stub account, as sign-in does
    await secureLocalStore.whenAccountReady();
    if (q.get('record')) secureLocalStore.setItem(levelUpKey('me'), q.get('record')!);
    createRoot(document.getElementById('root')!).render(<ToastProvider>{scene === 'flow' ? <Flow /> : <Card />}</ToastProvider>);
})();
