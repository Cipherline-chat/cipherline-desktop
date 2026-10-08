import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { ClButton } from '../../ClButton';
import { useEscape } from '../../../hooks/useEscape';
import type { EndingProps } from '../types';
import type { DotField } from '../dots';
import { stitch, icon, COL } from '../dots/scenes';
import { decideTrialBeat, type TrialBeat } from './endingTrial';
import {
    REVEAL, assembledShape, clearBuildMarks, collectReveal, markForBuild, revealEl, startHandover,
} from './buildOut';
import './ending.css';

/**
 * The ending of the first-run setup (round 6). Port of the approved
 * prototype (scratchpad ob6/js/main.js "the ending"):
 *
 *   1. three statements about what makes Cipherline different, each over a
 *      dot icon that morphs lock → laptop → folder-with-lock;
 *   2. the trial beat under a gold dot crown (honest about a withheld trial,
 *      see endingTrial.ts);
 *   3. the build-out: the dots fly out of the crown and condense onto the
 *      REAL Home mounted under this overlay (buildOut.ts), then one continuous
 *      dissolve hands over to it: the overlay's backdrop and the dots fade
 *      while the real elements fade + sharpen in place. No pop, no bounce.
 *
 * Click / Space / → / Enter moves to the next beat; Skip / Esc goes straight
 * to the end. Reduced motion (or no WebGL): one still, self-paced page.
 */

type Paths = readonly string[];
const P_LOCK: Paths = ['M7 11V7a5 5 0 0 1 10 0v4', 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 15v2'];
const P_LAPTOP: Paths = ['M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z', 'M20.054 15.987H3.946'];
const P_FOLDERLOCK: Paths = ['M10 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v2.5', 'M20 17v-2a2 2 0 1 0-4 0v2', 'M15 17h6a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z'];
const P_CROWN: Paths = ['M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z', 'M5 21h14'];

interface Beat {
    icon: Paths;
    gold?: boolean;
    t: string;
    s: string;
    chips?: boolean;
    /** ms at full opacity (the prototype's holdFor, scaled to the reading). */
    hold: number;
}

const STATEMENTS: readonly Beat[] = [
    { icon: P_LOCK, t: 'Every message is end‑to‑end encrypted.', s: 'DMs, group chats and servers. Not even we can read them.', hold: 2420 },
    { icon: P_LAPTOP, t: 'Your history lives on your device.', s: 'And you decide how long it stays.', hold: 2200 },
    { icon: P_FOLDERLOCK, t: 'Back it up to your own Drive or folder.', s: 'Encrypted with your passphrase, free, and restorable on any of your devices.', hold: 2640 },
];
const trialToBeat = (tb: TrialBeat): Beat => ({
    icon: P_CROWN, gold: true, t: tb.title, s: tb.sub, chips: tb.kind === 'started', hold: 3000,
});

/** Beat fade in / out (match fin-in / fin-out in ending.css). */
const FIN_IN = 420, FIN_OUT = 280;
/** The build-out (prototype buildOut): condense 1.3 s, dissolve at 1.15 s, land at 2.5 s. */
const CONDENSE_MS = 1300, DISSOLVE_AT = 1150, DOTS_FADE_MS = 1100, LAND_AT = 2500;
/** Skip / Esc: the overlay's own short fade (ending.css [data-ob-skipping]). */
const SKIP_FADE_MS = 260;

const Chips: React.FC = () => (
    <div className="fin-chips">
        <span>Video &amp; screen share</span>
        <span>2 GB uploads <small>free: 100 MB</small></span>
        <span>Server storage up to 10 GB <small>free: 25 MB</small></span>
    </div>
);

const BeatView: React.FC<{ b: Beat; i: number; n: number; out?: boolean; still?: boolean }> = ({ b, i, n, out, still }) => (
    <div className={`fin-beat${b.gold ? ' gold' : ''}${out ? ' out' : ''}`}>
        <h2 className="fin-t">{b.t}</h2>
        <p className="fin-s">{b.s}</p>
        {b.chips && <Chips />}
        {n > 0 && (
            <div className="fin-steps" aria-hidden>
                {Array.from({ length: n }, (_, k) => <i key={k} className={k === i ? 'on' : ''} />)}
            </div>
        )}
        {!still && (n !== 0 || b.chips) && <p className="fin-hint">Click or press → for the next one</p>}
    </div>
);

/** DEV-only phase clock for phase-relative screenshots (ob6/tools/phaseshots.cjs). */
function devPhase(phase: string, key?: '__obBeatT0' | '__obBuildT0'): void {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__obPhase = phase;
    if (key) w[key] = performance.now();
}

const trialFrom = (d: Pick<EndingProps['deps'], 'trialGranted' | 'referralApplied' | 'bonusDays' | 'referrer' | 'subscription'>): TrialBeat | null =>
    decideTrialBeat({
        trialGranted: d.trialGranted,
        referralApplied: d.referralApplied,
        bonusDays: d.bonusDays,
        referrerName: d.referrer?.username ?? null,
        subscription: d.subscription,
    });

const iconShape = (f: DotField, b: Beat) =>
    stitch(f.N, [icon(3400, b.icon, { size: 0.62, lw: 1.9, color: b.gold ? COL.gold : COL.lumeHi })]);

export const OnboardingEnding: React.FC<EndingProps> = ({ deps, flow, reducedMotion, dots, showDots, onDone }) => {
    // ── what the trial beat says ────────────────────────────────────────────
    // Decided from the LATEST deps when it is needed: on a resume without the
    // finalize facts the live subscription may still be loading when the
    // ending mounts, and the statements give it ~9 s to arrive.
    const factsRef = useRef(deps);
    useEffect(() => { factsRef.current = deps; });
    const decideTrial = useCallback((): TrialBeat | null => trialFrom(factsRef.current), []);
    // The still page re-renders as the facts arrive.
    const { trialGranted, referralApplied, bonusDays, referrer, subscription } = deps;
    const staticTrial = useMemo(
        () => trialFrom({ trialGranted, referralApplied, bonusDays, referrer, subscription }),
        [trialGranted, referralApplied, bonusDays, referrer, subscription],
    );

    // ── join the official server, once, as the ending starts ───────────────
    const joinedRef = useRef(false);
    useEffect(() => {
        if (joinedRef.current || !flow.joinOfficial) return;
        joinedRef.current = true;
        void (async () => {
            try {
                const off = await deps.fetchOfficialServer();
                await deps.joinServer(off.invite_code);
            } catch { /* the rail simply lacks it */ }
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── animated or still ───────────────────────────────────────────────────
    // The shell creates the dot field in its own effect, which runs AFTER
    // this child's first effects, so `dots` can be null on the first render
    // even with WebGL. Give it a moment; still null = no WebGL = still page.
    const [noGl, setNoGl] = useState(false);
    useEffect(() => {
        if (dots || reducedMotion) return undefined;
        const t = window.setTimeout(() => setNoGl(true), 300);
        return () => window.clearTimeout(t);
    }, [dots, reducedMotion]);
    const mode: 'wait' | 'anim' | 'static' = reducedMotion ? 'static' : dots ? 'anim' : noGl ? 'static' : 'wait';

    const rootRef = useRef<HTMLDivElement>(null);
    const overlay = (): HTMLElement | null => rootRef.current?.closest<HTMLElement>('[data-ob-root]') ?? null;

    // ── the sequence ────────────────────────────────────────────────────────
    const [beat, setBeat] = useState<{ b: Beat; i: number; n: number; out: boolean } | null>(null);
    const timers = useRef<number[]>([]);
    const wakeRef = useRef<(() => void) | null>(null);
    const runId = useRef(0);
    const marked = useRef<HTMLElement[]>([]);
    const finished = useRef(false);

    const clearTimers = () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []; };
    const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };

    // The very end: hand the Home over, with nothing left behind.
    const finish = useCallback((how: 'landed' | 'skip' | 'open') => {
        if (finished.current) return;
        finished.current = true;
        runId.current++;
        clearTimers();
        wakeRef.current = null;
        clearBuildMarks(marked.current);
        marked.current = [];
        devPhase('done');
        const done = () => {
            if (flow.friendRequestSentTo) {
                deps.pushToast({ kind: 'success', title: 'Friend request sent', message: `Friend request sent to ${flow.friendRequestSentTo}` });
            }
            showDots(false);
            onDone();
        };
        if (how === 'skip' && !reducedMotion) {
            overlay()?.setAttribute('data-ob-skipping', '');
            window.setTimeout(done, SKIP_FADE_MS);
        } else done();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flow.friendRequestSentTo, deps.pushToast, showDots, onDone, reducedMotion]);

    useEffect(() => {
        if (mode !== 'anim' || !dots) return undefined;
        const F = dots;
        const run = runId;
        const id = ++run.current;
        const alive = () => id === run.current;
        /* a beat's wait can be cut short: click, Space, → or Enter */
        const wait = (ms: number, wakeable = false) => new Promise<boolean>((res) => {
            const t = window.setTimeout(() => { wakeRef.current = null; res(alive()); }, ms);
            timers.current.push(t);
            if (wakeable) wakeRef.current = () => { window.clearTimeout(t); wakeRef.current = null; res(alive()); };
        });

        void (async () => {
            showDots(true);
            F.param('follow', 0.35, 500); F.param('repel', 0, 500); F.param('yaw', 0, 600); F.param('pitch', 0, 600);
            F.param('spinRate', 0, 300); F.param('spin', 0, 600); F.param('cam', 3.2, 600); F.param('fog', 1, 600);
            F.param('offX', 0, 700); F.param('offY', 0.36, 700); F.param('scale', 1, 700);
            F.param('bright', 1.2, 500); F.param('px', 14, 500); F.param('drift', 1, 500);
            if (!(await wait(150))) return;
            const n = STATEMENTS.length;
            for (let i = 0; i <= n; i++) {
                let b: Beat;
                if (i < n) b = STATEMENTS[i];
                else {
                    const tb = decideTrial();
                    if (!tb) break;
                    b = trialToBeat(tb);
                }
                const isTrial = i === n;
                devPhase(isTrial ? 'trial' : `statement-${i + 1}`, '__obBeatT0');
                void F.morph(iconShape(F, b), { ms: 760, stagger: 0.42, arc: 0.4 });
                const shown = { b, i, n: isTrial ? 0 : n };
                setBeat({ ...shown, out: false });
                if (!(await wait(FIN_IN + b.hold, true))) return;
                setBeat({ ...shown, out: true });
                if (!(await wait(FIN_OUT))) return;
            }
            setBeat(null);

            // ── the build-out ──
            devPhase('build', '__obBuildT0');
            const shape = assembledShape(F.N, flow.username ?? factsRef.current.user?.username ?? null);
            marked.current = markForBuild(collectReveal());
            F.param('follow', 0, 400); F.param('offY', 0, 800); F.param('drift', 0, 700); F.param('px', 11, 700); F.param('bright', 1.15, 300);
            void F.morph(shape, { ms: CONDENSE_MS, stagger: 0.45, arc: 0.28 });
            /* one continuous dissolve: the Home fades + sharpens in place exactly as the dots and the backdrop fade */
            later(() => {
                if (!alive()) return;
                overlay()?.setAttribute('data-ob-dissolve', '');
                startHandover();
                void F.param('bright', 0, DOTS_FADE_MS);
                const groups = collectRevealMarked(marked.current);
                for (const [g, t0, step] of REVEAL) {
                    (groups.get(g) ?? []).forEach((el, j) => later(() => revealEl(el), t0 + j * step));
                }
            }, DISSOLVE_AT);
            later(() => { if (alive()) finish('landed'); }, LAND_AT);
        })();

        return () => {
            // StrictMode's simulated unmount, a real one, or a switch to the
            // still page (reduced motion turned on): stop this run and leave
            // nothing on the Dashboard.
            if (run.current === id) run.current++;
            clearTimers();
            wakeRef.current = null;
            if (!finished.current) {
                clearBuildMarks(marked.current);
                marked.current = [];
                overlay()?.removeAttribute('data-ob-dissolve');
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    // Unmount (incl. sign-out mid-ending): never leave marks on the Dashboard.
    useEffect(() => () => { clearBuildMarks(marked.current); marked.current = []; }, []);

    // ── input: click / Space / → / Enter = next beat, Esc = the end ─────────
    // Esc goes through the shared escape stack (hooks/useEscape), on top of
    // whatever the Dashboard underneath has registered.
    useEscape(() => { if (!finished.current) finish('skip'); }, mode !== 'wait');
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (finished.current) return;
            if ((e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') && wakeRef.current) {
                // Enter / Space on the focused Skip button is that button's own click.
                if (e.key !== 'ArrowRight' && (e.target as HTMLElement | null)?.closest?.('button')) return;
                e.preventDefault(); e.stopPropagation(); wakeRef.current();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [finish]);

    const isStatic = mode === 'static';
    const goRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!isStatic) return undefined;
        devPhase('static');
        showDots(false);
        const t = window.setTimeout(() => goRef.current?.querySelector('button')?.focus({ preventScroll: true }), 30);
        return () => window.clearTimeout(t);
    }, [isStatic, showDots]);

    return (
        <div ref={rootRef} className="ob-ending">
            {isStatic ? (
                <div className="fin fin--static">
                    <div className="fin-static">
                        <p className="eyebrow">Welcome to Cipherline</p>
                        <ul>
                            {STATEMENTS.map((b) => <li key={b.t}><b>{b.t}</b><span>{b.s}</span></li>)}
                        </ul>
                        {staticTrial ? (
                            <div className="fin-trial"><BeatView b={trialToBeat(staticTrial)} i={0} n={0} still /></div>
                        ) : <div className="fin-static-noTrial" />}
                        <div ref={goRef} className="fin-go">
                            <ClButton onClick={() => finish('open')}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>Open Cipherline <ArrowRight size={16} /></span>
                            </ClButton>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="fin" onClick={() => wakeRef.current?.()} aria-live="polite">
                    {beat && <BeatView key={beat.i} b={beat.b} i={beat.i} n={beat.n} out={beat.out} />}
                </div>
            )}
            {mode !== 'wait' && (
                <button type="button" className="ob-skip" onClick={() => finish('skip')}>
                    Skip <kbd>Esc</kbd>
                </button>
            )}
        </div>
    );
};

/** The marked elements regrouped by their `data-ob-bp` group, in DOM order. */
function collectRevealMarked(els: readonly HTMLElement[]): Map<string, HTMLElement[]> {
    const m = new Map<string, HTMLElement[]>();
    for (const el of els) {
        const g = el.getAttribute('data-ob-bp') || '';
        const a = m.get(g) ?? [];
        a.push(el);
        m.set(g, a);
    }
    return m;
}
