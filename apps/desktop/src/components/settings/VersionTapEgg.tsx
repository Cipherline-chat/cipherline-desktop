import React, { useEffect, useRef, useState } from 'react';
import { Keys } from '../mascot/Keys';
import { eggCountNow, noteEggNow } from '../../hooks/useEasterEggs';
import { recordEggFound } from '../../utils/eggProgress';
import { DEV_MODE_EGG, versionTap } from '../../utils/versionTaps';
import type { Streak } from '../../utils/eggStreak';

/**
 * Wraps the app-version chip in Settings → Advanced. Seven quick taps turn on
 * "Keys developer mode": a small badge next to the version that does exactly
 * nothing, and says so. The chip's own click-to-copy is untouched (the taps
 * ride the click bubbling out of the real button, so keyboard activation
 * counts too). Counting and copy: utils/versionTaps.ts.
 */
const NOTE_MS = 2600;

export const VersionTapEgg: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [devOn, setDevOn] = useState(() => eggCountNow(DEV_MODE_EGG) > 0);
    const [note, setNote] = useState<string | null>(null);
    const streak = useRef<Streak | undefined>(undefined);
    const timer = useRef<number>(0);
    useEffect(() => () => window.clearTimeout(timer.current), []);

    const onTap = (e: React.MouseEvent) => {
        // Only the chip's own button counts, not the badge or the note.
        if (!(e.target as HTMLElement).closest('button')) return;
        const r = versionTap(streak.current, Date.now(), devOn);
        streak.current = r.streak;
        if (r.activate) { noteEggNow(DEV_MODE_EGG); recordEggFound('dev-mode'); setDevOn(true); }
        window.clearTimeout(timer.current);
        setNote(r.note);
        if (r.note) timer.current = window.setTimeout(() => setNote(null), NOTE_MS);
    };

    return (
        // The click comes from the real <button> inside (focusable, labelled);
        // this wrapper only listens to it bubble, so it is not itself interactive.
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }} onClick={onTap}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {devOn && (
                    <span
                        className="sd-mono"
                        title="Keys developer mode. Purely cosmetic."
                        data-testid="keys-dev-badge"
                        style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '1px 8px 1px 4px', borderRadius: 999,
                            fontSize: 10.5, color: 'var(--cl-lume)', border: '1px solid rgba(37,224,200,.35)', background: 'rgba(37,224,200,.08)',
                        }}
                    >
                        <span aria-hidden="true" style={{ display: 'inline-flex' }}>
                            <Keys size={16} interactive={false} waveOnMount={false} idleSway={false} />
                        </span>
                        dev mode
                        <span className="sr-only"> (purely cosmetic)</span>
                    </span>
                )}
                {children}
            </span>
            <span role="status" aria-live="polite" className="sd-mono" style={{ fontSize: 11, color: 'var(--cl-lume)', minHeight: note ? undefined : 0 }}>
                {note}
            </span>
        </span>
    );
};

export default VersionTapEgg;
