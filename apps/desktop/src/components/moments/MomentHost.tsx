import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { secureLocalStore } from '../../utils/secureLocalStore';
import { pushEscapeLayer } from '../../utils/escapeStack';
import { getHasActiveCall } from '../../utils/activeCallRegistry';
import { isTypingTarget } from '../../utils/easterEggs';
import {
    MOMENTS, MOMENT_EVENT, CEREMONY_EVENT, PENDING_POLL_MS, PENDING_MAX_MS,
    isMomentId, isCeremonyId, claimMoment, momentDueIn, momentRollIn, quietEnough, announcement,
    stillMs, momentStays, momentStyleVars, yieldMoments, stageDef, stageText, cleanPeerName,
    type MomentId, type CeremonyId, type StageId, type MomentDef, type MomentInviteDetail,
} from '../../utils/moments';
import { recordEggFound } from '../../utils/eggProgress';
import { MOMENT_VIEWS, CEREMONY_VIEWS } from './views';
import { MomentStill } from './MomentStill';
import '../../styles/moments.css';

/**
 * The one full-screen moment layer (utils/moments.ts has the why). Mounted
 * once for the signed-in app, next to EggLayer; renders nothing until a
 * trigger calls requestMoment(id).
 *
 * The contract every moment gets for free from here:
 *   - portal to <body>, above every app layer (z 50000) but below the system
 *     surfaces (screen-share picker, update prompt, screen lock, client block);
 *   - skip: Escape (through the shared escape stack, so it never ALSO closes
 *     the dialog underneath), any other key, or a click. A skip keystroke is
 *     never swallowed — typed text still lands where it was going;
 *   - focus: a stage moment takes focus only when it is not in a text field,
 *     and hands it back to where it was;
 *   - paced to be read (utils/moments.ts MomentTimeline): the phase times
 *     are published as CSS custom properties on the root, and the overlay
 *     unmounts at durationMs (≤ 9 s) — except a moment whose button `stays`,
 *     which waits on its settled frame until it is dismissed (a passive
 *     moment never stays: it can never sit over the app);
 *   - rarity: the ledger's policy, then (once per trigger) the policy's die,
 *     rolled with the injected `random`;
 *   - hidden window → the animation and its clock pause; visible → resume;
 *   - reduced motion → a still card with the punchline instead;
 *   - the punchline is announced once through a polite live region;
 *   - one at a time: a user-action moment that arrives while another plays is
 *     dropped; an ambient one waits (up to 15 min) for a quiet moment — no
 *     call, no typing, window visible — and plays then.
 *
 * A CEREMONY (utils/moments.ts CEREMONIES — today the first safety-number
 * verification) rides the same stage but is not an egg: it skips the rarity
 * policy, the die, the seen-ledger, the quiet-moment wait and the Egg hunter
 * count, and it replaces a moment already on screen. Everything else above
 * (portal, skip, focus, pause, reduced-motion card, announcement) is shared.
 */

const store = {
    getItem: (k: string) => secureLocalStore.getItem(k),
    setItem: (k: string, v: string) => secureLocalStore.setItem(k, v),
};

const reducedMotion = () =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn']);

interface Playing { id: StageId; seq: number; reduced: boolean; serverId: string | null; peer: string | null }

export const MomentHost: React.FC<{ random?: () => number }> = ({ random }) => {
    const rng = useRef(random ?? Math.random);
    useEffect(() => { rng.current = random ?? Math.random; }, [random]);
    const [playing, setPlaying] = useState<Playing | null>(null);
    const [said, setSaid] = useState('');
    const playingRef = useRef<Playing | null>(null);
    const seq = useRef(0);
    const lastKeyAt = useRef(-Infinity);
    const pending = useRef<{ id: MomentId; since: number; serverId: string | null } | null>(null);

    // Keystroke TIMING only (never the key): "is someone typing right now?"
    useEffect(() => {
        const onKey = () => { lastKeyAt.current = Date.now(); };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    const quiet = useCallback(() => quietEnough({
        hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
        inCall: getHasActiveCall(),
        sinceKeyMs: Date.now() - lastKeyAt.current,
    }), []);

    /** 'played' | 'drop' (not due / claim refused) | 'wait' (busy or not quiet). */
    const tryStart = useCallback((id: MomentId, serverId: string | null): 'played' | 'drop' | 'wait' => {
        const def: MomentDef = MOMENTS[id];
        if (playingRef.current) return 'wait';
        if (def.waitForIdle && !quiet()) return 'wait';
        if (!claimMoment(store, id, Date.now())) return 'drop';
        // A moment that stands in for another one (New Year's call fireworks vs
        // the underwater ones) spends it for the day without showing it.
        yieldMoments(store, id, Date.now());
        const p: Playing = { id, seq: ++seq.current, reduced: reducedMotion(), serverId, peer: null };
        playingRef.current = p;
        setPlaying(p);
        setSaid(announcement(id));
        // The Egg hunter badge counts the moment under its bare registry id
        // (EGG_IDS lists every MOMENTS key); `moment:` is only the ledger's prefix.
        recordEggFound(id);
        return 'played';
    }, [quiet]);

    /**
     * A ceremony: guaranteed. No ledger, no dice, no waiting, no egg find; it
     * replaces whatever moment is on screen (the keyed stage remounts).
     */
    const startCeremony = useCallback((id: CeremonyId, peer: string | null) => {
        const name = peer ? cleanPeerName(peer) : null;
        const p: Playing = { id, seq: ++seq.current, reduced: reducedMotion(), serverId: null, peer: name };
        playingRef.current = p;
        setPlaying(p);
        setSaid(announcement(id, name));
    }, []);

    const offer = useCallback((id: MomentId, serverId: string | null) => {
        if (!momentDueIn(store, id, Date.now())) return;
        // The rarity die: once per trigger, before anything is claimed.
        if (!momentRollIn(store, id, rng.current)) return;
        const r = tryStart(id, serverId);
        // Only ambient moments queue; a reaction to a click is now or never.
        if (r === 'wait' && MOMENTS[id].waitForIdle && !pending.current) {
            pending.current = { id, since: Date.now(), serverId };
        }
    }, [tryStart]);

    useEffect(() => {
        const onReq = (e: Event) => {
            const detail = (e as CustomEvent<{ id?: unknown; serverId?: unknown }>).detail;
            const id = detail?.id;
            const serverId = typeof detail?.serverId === 'string' && detail.serverId ? detail.serverId : null;
            if (isMomentId(id)) offer(id, serverId);
        };
        const onCeremony = (e: Event) => {
            const detail = (e as CustomEvent<{ id?: unknown; peer?: unknown }>).detail;
            if (isCeremonyId(detail?.id)) startCeremony(detail.id, typeof detail?.peer === 'string' ? detail.peer : null);
        };
        window.addEventListener(MOMENT_EVENT, onReq);
        window.addEventListener(CEREMONY_EVENT, onCeremony);
        const poll = window.setInterval(() => {
            const p = pending.current;
            if (!p) return;
            if (Date.now() - p.since > PENDING_MAX_MS) { pending.current = null; return; }
            if (tryStart(p.id, p.serverId) !== 'wait') pending.current = null;
        }, PENDING_POLL_MS);
        return () => {
            window.removeEventListener(MOMENT_EVENT, onReq);
            window.removeEventListener(CEREMONY_EVENT, onCeremony);
            window.clearInterval(poll);
        };
    }, [offer, tryStart, startCeremony]);

    const done = useCallback(() => {
        playingRef.current = null;
        setPlaying(null);
    }, []);

    // Clear the live region shortly after, so the same line can be announced
    // again next time (a live region ignores an unchanged text).
    useEffect(() => {
        if (playing || !said) return;
        const t = window.setTimeout(() => setSaid(''), 1000);
        return () => window.clearTimeout(t);
    }, [playing, said]);

    return (
        <>
            <span className="sr-only" role="status" aria-live="polite" data-testid="moment-live">{said}</span>
            {playing && <MomentStage key={playing.seq} id={playing.id} reduced={playing.reduced} serverId={playing.serverId} peer={playing.peer} onDone={done} />}
        </>
    );
};

/** A setTimeout that can be paused (hidden window) and resumed. `null` never fires. */
function usePausableTimer(ms: number | null, onFire: () => void) {
    const left = useRef(ms);
    const startedAt = useRef(0);
    const t = useRef<number | null>(null);
    const fire = useRef(onFire);
    useEffect(() => { fire.current = onFire; });
    const resume = useCallback(() => {
        if (t.current !== null || left.current === null) return;
        startedAt.current = Date.now();
        t.current = window.setTimeout(() => { t.current = null; fire.current(); }, Math.max(0, left.current));
    }, []);
    const pause = useCallback(() => {
        if (t.current === null) return;
        window.clearTimeout(t.current);
        t.current = null;
        if (left.current !== null) left.current -= Date.now() - startedAt.current;
    }, []);
    useEffect(() => { resume(); return pause; }, [resume, pause]);
    return { pause, resume };
}

/** A button only makes sense on a stage moment (a passive one lets clicks through). */
const stageAction = (def: MomentDef) => (def.mode === 'stage' ? def.action ?? null : null);

const MomentStage: React.FC<{ id: StageId; reduced: boolean; serverId: string | null; peer: string | null; onDone: () => void }> = ({ id, reduced, serverId, peer, onDone }) => {
    const def: MomentDef = stageDef(id);
    const ceremony = isCeremonyId(id);
    const ref = useRef<HTMLDivElement>(null);
    const actionRef = useRef<HTMLButtonElement>(null);
    // A moment whose button stays has no clock at all: it ends on a press, a
    // click on the backdrop, or a key.
    const timer = usePausableTimer(momentStays(id) ? null : reduced ? stillMs(id, peer) : def.durationMs, onDone);
    const action = stageAction(def);
    const stage = def.mode === 'stage';

    // Focus: take it (stage only, and never out of a text field), give it back.
    useLayoutEffect(() => {
        const el = ref.current;
        const prev = document.activeElement as HTMLElement | null;
        const took = stage && !isTypingTarget(prev);
        if (took) el?.focus({ preventScroll: true });
        return () => {
            if (!took || !prev || !prev.isConnected) return;
            const a = document.activeElement;
            if (!a || a === document.body || a === el || (el && el.contains(a))) prev.focus({ preventScroll: true });
        };
    }, [stage]);

    // Escape: the top layer of the shared stack while we run.
    useEffect(() => pushEscapeLayer(() => onDone()), [onDone]);

    // Any other key skips — and is NOT swallowed, so typing never loses a letter.
    // Passive moments also skip on a pointer press (which still reaches the app).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // (Escape normally never gets here: the stack's capture listener
            // took it first. If it does — screen lock, IME — it is just a key.)
            if (MODIFIER_KEYS.has(e.key)) return;
            // The moment's own button (Enter / Space on it) is not a skip.
            if (actionRef.current && e.target === actionRef.current) return;
            // With a button on screen, Tab goes to it instead of skipping.
            if (e.key === 'Tab' && actionRef.current) {
                e.preventDefault();
                actionRef.current.focus({ preventScroll: true });
                return;
            }
            onDone();
        };
        const onPointer = () => onDone();
        window.addEventListener('keydown', onKey, true);
        if (!stage) window.addEventListener('pointerdown', onPointer, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('pointerdown', onPointer, true);
        };
    }, [onDone, stage]);

    // Hold = freeze the animation AND its clock (a hidden window; a hand on
    // the action button). Two independent reasons, so a counter, not a flag.
    const holds = useRef(0);
    const hold = useCallback((on: boolean) => {
        const before = holds.current;
        holds.current = Math.max(0, before + (on ? 1 : -1));
        const anims = ref.current?.getAnimations?.({ subtree: true }) ?? [];
        if (before === 0 && holds.current > 0) { timer.pause(); anims.forEach(a => a.pause()); }
        else if (before > 0 && holds.current === 0) { anims.forEach(a => a.play()); timer.resume(); }
    }, [timer]);
    useEffect(() => {
        let hidden = false;
        const onVis = () => {
            const now = document.visibilityState === 'hidden';
            if (now !== hidden) { hidden = now; hold(now); }
        };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, [hold]);
    const handOn = useRef(false);
    // (A button that stays has no clock to hold; its scene just keeps settling.)
    const hand = (on: boolean) => { if (!momentStays(id) && handOn.current !== on) { handOn.current = on; hold(on); } };

    const text = stageText(id, peer);
    return createPortal(
        <div
            ref={ref}
            className={`mo-root mo-${def.mode}${reduced ? ' mo-reduced' : ''}${ceremony ? ' mo-ceremony' : ''}`}
            style={(reduced && ceremony
                ? { ...momentStyleVars(id), '--mo-still': `${stillMs(id, peer)}ms` }
                : momentStyleVars(id)) as React.CSSProperties}
            data-testid="moment"
            data-moment={id}
            {...(stage
                ? { role: 'dialog', 'aria-modal': false, 'aria-label': ceremony ? 'Press any key to skip.' : 'Easter egg. Press any key to skip.', tabIndex: -1, onClick: onDone }
                : { 'aria-hidden': true })}
        >
            {reduced
                ? <MomentStill headline={text.headline} line={text.line} />
                : isCeremonyId(id) ? React.createElement(CEREMONY_VIEWS[id], { headline: text.headline, line: text.line, peer }) : React.createElement(MOMENT_VIEWS[id])}
            {action && (
                <button
                    ref={actionRef}
                    type="button"
                    className="mo-action"
                    data-testid="moment-action"
                    onClick={e => {
                        e.stopPropagation();
                        const detail: MomentInviteDetail = { serverId };
                        window.dispatchEvent(new CustomEvent(action.event, { detail }));
                        onDone();
                    }}
                    onPointerEnter={() => hand(true)}
                    onPointerLeave={() => hand(false)}
                    onFocus={() => hand(true)}
                    onBlur={() => hand(false)}
                >
                    {action.label}
                </button>
            )}
        </div>,
        document.body,
    );
};

export default MomentHost;
