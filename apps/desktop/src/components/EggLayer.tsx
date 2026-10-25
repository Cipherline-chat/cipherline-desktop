import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeysParty } from './KeysParty';
import { claimEggNow } from '../hooks/useEasterEggs';
import { recordEggFound } from '../utils/eggProgress';
import { KONAMI, isTypingTarget, konamiStep } from '../utils/easterEggs';

/** Konami can be re-run, but not stacked: one party per half minute. */
export const KONAMI_COOLDOWN_MS = 30_000;

const reducedMotion = () =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The global easter-egg surface, mounted once for the signed-in app. Today:
 * the Konami code (↑ ↑ ↓ ↓ ← → ← → B A) → Keys party.
 *
 * Listens in the BUBBLE phase on window and ignores every key aimed at an
 * input / textarea / contenteditable, so it can never see what is being typed
 * into the composer (privacy) and never fights a text field's arrow keys. The
 * cooldown is checked at fire time (claimEggNow).
 */
export const EggLayer: React.FC = () => {
    const [party, setParty] = useState<{ id: number; reduced: boolean } | null>(null);
    const progress = useRef(0);
    const seq = useRef(0);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
            if (isTypingTarget(e.target as HTMLElement | null)) { progress.current = 0; return; }
            progress.current = konamiStep(progress.current, e.key);
            if (progress.current < KONAMI.length) return;
            progress.current = 0;
            if (!claimEggNow('konami', { cooldownMs: KONAMI_COOLDOWN_MS })) return;
            setParty({ id: ++seq.current, reduced: reducedMotion() });
            recordEggFound('konami');
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const done = useCallback(() => setParty(null), []);
    return party ? <KeysParty key={party.id} reduced={party.reduced} onDone={done} /> : null;
};

export default EggLayer;
