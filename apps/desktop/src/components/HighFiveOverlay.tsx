import React, { useEffect, useRef, useState } from 'react';
import { Hand } from 'lucide-react';
import { Keys } from './mascot/Keys';
import { HIGH_FIVE_PLAY_EVENT, type HighFiveEventDetail } from '../utils/profileMoments';
import '../styles/profile-extras.css';

const SHOW_MS = 2600;
const SHOW_REDUCED_MS = 1600;

/**
 * Keys gives you a high five. Mounted once in the signed-in app; the host that
 * decides whether to celebrate (never under Do Not Disturb, see
 * hooks/useProfileMoments.ts) fires HIGH_FIVE_PLAY_EVENT. Transform/opacity
 * only; under prefers-reduced-motion Keys just appears (no wave, no slide).
 */
export const HighFiveOverlay: React.FC = () => {
    const [play, setPlay] = useState<{ id: number; from: string } | null>(null);
    const [wave, setWave] = useState(false);
    const seq = useRef(0);

    useEffect(() => {
        let hide: ReturnType<typeof setTimeout> | null = null;
        let arm: ReturnType<typeof setTimeout> | null = null;
        const onPlay = (e: Event) => {
            const d = (e as CustomEvent<HighFiveEventDetail>).detail;
            const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (hide) clearTimeout(hide);
            if (arm) clearTimeout(arm);
            setWave(false);
            setPlay({ id: ++seq.current, from: d?.from_username || 'Someone' });
            // A rising edge on `wave` is what plays Keys' arm wave.
            if (!reduced) arm = setTimeout(() => setWave(true), 120);
            hide = setTimeout(() => { setPlay(null); setWave(false); }, reduced ? SHOW_REDUCED_MS : SHOW_MS);
        };
        window.addEventListener(HIGH_FIVE_PLAY_EVENT, onPlay);
        return () => {
            window.removeEventListener(HIGH_FIVE_PLAY_EVENT, onPlay);
            if (hide) clearTimeout(hide);
            if (arm) clearTimeout(arm);
        };
    }, []);

    if (!play) return null;
    return (
        <div className="pe-hifive" role="status" aria-live="polite" data-testid="high-five-overlay" key={play.id}>
            <Keys size={84} interactive={false} waveOnMount={false} idleSway={false} wave={wave} face="happy" ariaLabel="Keys high-fiving you" />
            <span className="pe-hifive__label"><Hand size={14} aria-hidden="true" /> High five from {play.from}</span>
        </div>
    );
};

export default HighFiveOverlay;
