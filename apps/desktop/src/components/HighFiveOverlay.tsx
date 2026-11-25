import React, { useEffect, useRef, useState } from 'react';
import { celebrationReducedNow } from '../utils/a11y/motionPrefs';
import { Hand } from 'lucide-react';
import { Keys } from './mascot/Keys';
import { HIGH_FIVE_PLAY_EVENT, type HighFiveEventDetail } from '../utils/profileMoments';
import '../styles/profile-extras.css';

const SHOW_MS = 2800;
const SHOW_REDUCED_MS = 1800;
/** The exit slide. Kept in step with .pe-hifive--out in profile-extras.css. */
const LEAVE_MS = 240;

/**
 * Keys gives you a high five. Mounted once in the signed-in app; the host that
 * decides whether to celebrate (never under Do Not Disturb, see
 * hooks/useProfileMoments.ts) fires HIGH_FIVE_PLAY_EVENT.
 *
 * A pill centred under the title bar: Keys on the left, "High five!" and who
 * sent it on the right, the same padding on both sides. It drops in, Keys
 * winds up with one leg raised and swings it in as the sender's (coral) hand
 * comes down from above; they smack (a burst from the hand + a squash), Keys holds it a
 * beat, lowers his leg, and the pill slides back up. The whole move is CSS
 * (profile-extras.css, .pe-hifive-k): transform/opacity only. Under reduced
 * motion it is a still Keys with his leg up, and it just appears and goes.
 */
export const HighFiveOverlay: React.FC = () => {
    const [play, setPlay] = useState<{ id: number; from: string } | null>(null);
    const [leaving, setLeaving] = useState(false);
    const seq = useRef(0);

    useEffect(() => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const clear = () => { while (timers.length) clearTimeout(timers.pop()!); };
        const onPlay = (e: Event) => {
            const d = (e as CustomEvent<HighFiveEventDetail>).detail;
            const reduced = celebrationReducedNow();
            clear();
            setLeaving(false);
            setPlay({ id: ++seq.current, from: d?.from_username || 'Someone' });
            const show = reduced ? SHOW_REDUCED_MS : SHOW_MS;
            if (!reduced) timers.push(setTimeout(() => setLeaving(true), show - LEAVE_MS));
            timers.push(setTimeout(() => { setPlay(null); setLeaving(false); }, show));
        };
        window.addEventListener(HIGH_FIVE_PLAY_EVENT, onPlay);
        return () => {
            window.removeEventListener(HIGH_FIVE_PLAY_EVENT, onPlay);
            clear();
        };
    }, []);

    if (!play) return null;
    return (
        <div
            className={`pe-hifive${leaving ? ' pe-hifive--out' : ''}`}
            role="status"
            aria-live="polite"
            data-testid="high-five-overlay"
            key={play.id}
        >
            <span className="pe-hifive__keys" aria-hidden="true">
                <Keys size={54} interactive={false} waveOnMount={false} idleSway={false} face="happy" ariaLabel="" className="pe-hifive-k" />
                {/* The burst and ring live inside the hand so they always come from it. */}
                <span className="pe-hifive__hand">
                    <span className="pe-hifive__ring" />
                    <svg className="pe-hifive__smack" viewBox="0 0 34 34"><path d="M17.0 8.0L17.0 1.5M24.1 9.9L26.5 7.5M26.0 17.0L32.5 17.0M24.1 24.1L26.5 26.5M17.0 26.0L17.0 32.5M9.9 24.1L7.5 26.5M8.0 17.0L1.5 17.0M9.9 9.9L7.5 7.5" /></svg>
                    <Hand size={22} strokeWidth={2.2} />
                </span>
            </span>
            <span className="pe-hifive__text">
                <span className="pe-hifive__title">High five!</span>
                <span className="pe-hifive__from">from <b>{play.from}</b></span>
            </span>
        </div>
    );
};

export default HighFiveOverlay;
