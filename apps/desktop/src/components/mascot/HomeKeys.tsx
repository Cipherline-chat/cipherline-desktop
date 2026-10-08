import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keys, type KeysFace, type KeysMood, type KeysSignal, type PokeReaction } from './Keys';
import { isMotionActive } from '../../utils/idleMotion';
import {
    registerClick, isBroken, reached, lineIndex, SPAM_GAP_MS, SPAM_COUNTS_AT,
    type SpamStreak,
} from '../../utils/keysBurst';
import { SHOWS, REST, ready, upNext, deal, type Move, type Personality, type Target } from '../../utils/keysSpam';
import { readSpamBag, writeSpamBag } from '../../utils/keysSpamStore';
import { BROWS } from '../../utils/keysBrain';
import '../../styles/home-keys.css';

/**
 * Keys on the Home deck: the shared rig (Keys.tsx) plus what makes him feel
 * alive in a spot he occupies all day, and the easter egg.
 *
 *  - A slow jellyfish swim: a quick little stroke up, then a long glide down.
 *    It moves ONE html wrapper (.hk-swim) with transform only, so it runs on
 *    the compositor; the shared rig's twelve-segment leg sway, which costs
 *    main-thread style + paint every frame (SVG children cannot be
 *    composited), is turned off here (`idleSway={false}`). The swim stops
 *    with the rest of the app's decoration when the window is blurred,
 *    hidden or untouched (utils/idleMotion.ts) and under reduced motion.
 *  - Blinks (the rig's own), and every so often a glance to one side.
 *  - Pointer over him: his eyes follow it and he leans toward it a little.
 *    One rAF per burst of pointer moves writes two CSS variables; React does
 *    not re-render.
 *  - One click: the rig's poke ladder (a wiggle, happy brows, a quip from
 *    the host).
 *  - Spam him and KEEP IT UP: he puts on a show that builds for five
 *    seconds (one of five, a different one each streak: utils/keysSpam.ts),
 *    then the host opens the Firewall game. Stop short and he settles back
 *    down his own way. The streak rule is utils/keysBurst.ts. Every show's
 *    motion is Web Animations on html elements (transform / opacity:
 *    compositor), started from the click handler, so nothing runs between
 *    clicks.
 */

export type PlayVerdict = 'ok' | 'call' | 'motion' | 'unavailable';

export const BURST_LINES = {
    call: 'fine, but after your call.',
    motion: 'I’d play, but motion is turned down.',
    unavailable: 'I’d play, but this machine can’t draw the game.',
} as const;

/** From the 5-second click to the game opening: long enough to see the finale. */
export const PLAY_DELAY_MS = 750;
const LINE_MS = 2400;

export interface HomeKeysProps {
    /** The signed-in account: the show rotation is kept per account. */
    userId: string;
    signal: KeysSignal;
    /** The host's quip (the poke ladder's lines); a show line outranks it. */
    speech: string | null;
    /** The ambience switch: the swim, glances and idle perks. */
    lively: boolean;
    /** The ladder's pokes (the host picks the line). Not called for streak clicks. */
    onPoke: (count: number) => void;
    /** Asked when the streak completes: may the game open right now? */
    canPlay: () => PlayVerdict;
    /** Open the game. */
    onPlay: () => void;
}

const reducedMotion = () =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** The keyframe's animated properties (not its offset / easing / composite). */
const propsOf = (k: Keyframe) => Object.keys(k).filter(p => p !== 'offset' && p !== 'easing' && p !== 'composite');

/** His silhouette (the mark's own shapes), for the glitch's ghost copies. */
const Silhouette: React.FC<{ className: string; reg: (el: Element | null) => void }> = ({ className, reg }) => (
    <svg ref={reg} className={className} viewBox="0 0 110 92" aria-hidden="true" focusable="false">
        <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" />
        <rect x="22.5" y="47" width="13" height="27" rx="6.5" />
        <rect x="39.8" y="47" width="13" height="27" rx="6.5" />
        <rect x="57.1" y="47" width="13" height="27" rx="6.5" />
        <rect x="74.4" y="47" width="13" height="27" rx="6.5" />
    </svg>
);

export const HomeKeys: React.FC<HomeKeysProps> = ({ userId, signal, speech, lively, onPoke, canPlay, onPlay }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const reactRef = useRef<HTMLDivElement>(null);
    const [face, setFace] = useState<KeysFace | null>(null);
    const [line, setLine] = useState<{ text: string; cls?: string } | null>(null);
    const [mood, setMood] = useState<KeysMood>('awake');
    /** The show this streak gets (its elements mount on the streak's first click). */
    const [show, setShow] = useState<Personality | null>(null);
    /** The show's own eyes are drawn (from its `eyesFrom` on). */
    const [eyesOn, setEyesOn] = useState(false);

    const streak = useRef<SpamStreak | null>(null);
    const showRef = useRef<Personality | null>(null);
    const clickN = useRef(0);
    const dealt = useRef(false);
    /** Until when (performance.now) clicks are swallowed: the finale (or a
     *  refusal) plays out even though the spammer is still clicking. */
    const busyUntil = useRef(-Infinity);
    const els = useRef<Partial<Record<Target, Element | null>>>({});
    const held = useRef(new Map<Target, { anim: Animation; to: Keyframe }>());
    const transient = useRef(new Map<Target, Animation>());
    const timers = useRef<{ settle?: ReturnType<typeof setTimeout>; line?: ReturnType<typeof setTimeout>; play?: ReturnType<typeof setTimeout>; end?: ReturnType<typeof setTimeout> }>({});
    const latest = useRef({ canPlay, onPlay, userId });
    useEffect(() => { latest.current = { canPlay, onPlay, userId }; });

    const reg = useCallback((t: Target) => (el: Element | null) => { els.current[t] = el; }, []);

    /** Start a show's moves (Web Animations, compositor). Nothing loops. */
    const play = useCallback((moves: Move[]) => {
        if (reducedMotion()) return;
        const nodeFor = (t: Target): Element | null =>
            t === 'body' ? reactRef.current
                : t === 'rig' ? reactRef.current?.querySelector('[role="img"]') ?? null
                    : els.current[t] ?? null;
        for (const m of moves) {
            const node = nodeFor(m.target) as (Element & { animate?: Element['animate'] }) | null;
            if (!node || typeof node.animate !== 'function') continue;
            const prev = held.current.get(m.target);
            let frames = m.frames;
            if (frames.length > 1 && propsOf(frames[0]).length === 0) {
                // "from wherever it is now": its held state, else REST
                const from: Keyframe = {};
                const props = new Set(frames.slice(1).flatMap(propsOf));
                for (const p of props) from[p] = prev?.to[p] ?? REST[m.target][p];
                frames = [from, ...frames.slice(1)];
            }
            if (m.hold && prev) {
                // carry held properties this move does not touch, so nothing snaps
                const extra = propsOf(prev.to).filter(p => !(p in frames[0]));
                if (extra.length) {
                    const keep = Object.fromEntries(extra.map(p => [p, prev.to[p]]));
                    frames = [{ ...frames[0], ...keep }, ...frames.slice(1, -1), { ...frames[frames.length - 1], ...keep }];
                }
            }
            const anim = node.animate(frames, { duration: m.ms, easing: m.easing ?? 'linear', fill: m.hold ? 'forwards' : 'none' });
            if (m.hold) {
                const last = frames[frames.length - 1];
                held.current.set(m.target, { anim, to: Object.fromEntries(propsOf(last).map(p => [p, last[p]])) });
                prev?.anim.cancel();
            } else {
                transient.current.get(m.target)?.cancel();
                transient.current.set(m.target, anim);
            }
        }
    }, []);

    /** Drop every show animation (he is at REST by then, or covered by the game). */
    const resetAnims = useCallback(() => {
        held.current.forEach(h => h.anim.cancel());
        held.current.clear();
        transient.current.forEach(a => a.cancel());
        transient.current.clear();
    }, []);

    const say = useCallback((text: string, cls?: string) => {
        clearTimeout(timers.current.line);
        setLine(prev => (prev?.text === text && prev.cls === cls ? prev : { text, cls }));
        timers.current.line = setTimeout(() => setLine(null), LINE_MS);
    }, []);

    /** The show is over: back to plain Keys. */
    const endShow = useCallback(() => {
        clearTimeout(timers.current.settle);
        clearTimeout(timers.current.end);
        resetAnims();
        showRef.current = null;
        setShow(null);
        setEyesOn(false);
        setFace(null);
        rootRef.current?.classList.remove('hk-avoid');
    }, [resetAnims]);

    useEffect(() => () => {
        const t = timers.current;
        clearTimeout(t.settle); clearTimeout(t.line); clearTimeout(t.play); clearTimeout(t.end);
        resetAnims();
    }, [resetAnims]);

    /** The streak broke short of five seconds: this show's way of settling. */
    const recover = useCallback(() => {
        const id = showRef.current;
        const got = reached(streak.current);
        streak.current = null;
        if (!id || got < 0.05) { endShow(); return; }
        const rc = SHOWS[id].recover(got);
        play(rc.moves);
        if (got >= 0.4) say(SHOWS[id].recoveredLine, SHOWS[id].speech);
        clearTimeout(timers.current.settle);
        timers.current.settle = setTimeout(endShow, rc.ms + 40);
    }, [endShow, play, say]);

    // Every click asks here first (Keys' interceptPoke). A click that starts
    // a streak returns null: the rig runs its normal poke ladder. Clicks that
    // keep a streak going are the show's.
    const interceptPoke = useCallback((): PokeReaction | null => {
        const now = performance.now();
        // Mid-finale: he's busy. The clicks that are still coming in must not
        // start a new streak (that would cut the finale off).
        if (now < busyUntil.current) return 'none';
        if (isBroken(streak.current, now)) recover();
        const r = registerClick(streak.current, now);
        streak.current = r.streak;
        clearTimeout(timers.current.settle);

        if (!r.continued) {
            // A new streak: whatever was settling stops, and the next show
            // in the rotation is lined up (not used up: see SPAM_COUNTS_AT).
            if (showRef.current) endShow();
            const { userId: uid } = latest.current;
            const stored = readSpamBag(uid);
            const bag = ready(stored);
            if (bag !== stored) writeSpamBag(uid, bag);
            // Its elements mount with the streak's second click: a lone
            // poke never puts anything extra in the DOM.
            showRef.current = upNext(bag);
            clickN.current = 0;
            dealt.current = false;
            timers.current.settle = setTimeout(recover, SPAM_GAP_MS + 20);
            return null;
        }

        const id = showRef.current ?? 'dance';
        const s = SHOWS[id];
        const n = ++clickN.current;
        if (n === 1) setShow(id);
        if (!dealt.current && (r.fired || r.progress >= SPAM_COUNTS_AT)) {
            // This streak counts: the next one gets the next show.
            const { userId: uid } = latest.current;
            writeSpamBag(uid, deal(ready(readSpamBag(uid))));
            dealt.current = true;
        }

        if (r.fired) {
            const verdict = latest.current.canPlay();
            busyUntil.current = now + (verdict === 'ok' ? PLAY_DELAY_MS + 500 : 1200);
            if (verdict === 'ok') {
                play(s.finale().moves);
                say(s.finaleLine, s.speech);
                clearTimeout(timers.current.play);
                timers.current.play = setTimeout(() => {
                    latest.current.onPlay();
                    // back to plain Keys under the game, ready for when it closes
                    timers.current.end = setTimeout(endShow, 300);
                }, PLAY_DELAY_MS);
            } else {
                say(BURST_LINES[verdict]);
                const rc = s.recover(1);
                play(rc.moves);
                timers.current.settle = setTimeout(endShow, rc.ms + 40);
            }
            return 'none';
        }

        play(s.click(r.progress, n));
        if (r.progress >= s.eyesFrom) {
            if (s.eyes !== 'own') { setFace('blank'); setEyesOn(true); }
            else if (s.face) setFace(s.face);
        }
        rootRef.current?.classList.toggle('hk-avoid', !!s.avoid);
        say(s.lines[lineIndex(r.progress)], s.speech);
        // No click within the gap: the streak is over.
        timers.current.settle = setTimeout(recover, SPAM_GAP_MS + 20);
        return 'none';
    }, [endShow, play, recover, say]);

    // MID-STREAK ONLY: a click that lands in his hit zone (the slot plus its
    // padding) but not on him still counts as a click on him. During a show
    // he ducks, skews, shrinks and sidesteps (up to ~16 px), so a pointer
    // that has not moved is soon NOT over him, and a measured 1-4 clicks per
    // streak (real Chromium pointer, still cursor) missed him and threw away
    // the streak. Outside a live streak this does nothing, so the padding
    // never steals a click from a neighbour.
    const onZoneClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const rig = reactRef.current?.querySelector<HTMLElement>('[role="img"]');
        if (!rig || rig.contains(e.target as Node)) return;
        const s = streak.current;
        if (!s || isBroken(s, performance.now())) return;
        rig.click();
    }, []);

    // Look at the pointer while it is over him (a generous hit zone, see
    // home-keys.css): -1..1 from his centre, written straight to CSS.
    useEffect(() => {
        const el = rootRef.current;
        if (!el || reducedMotion()) return;
        let raf = 0;
        let px = 0, py = 0;
        const apply = () => {
            raf = 0;
            const r = el.getBoundingClientRect();
            const hw = r.width / 2 || 1, hh = r.height / 2 || 1;
            const x = Math.max(-1, Math.min(1, (px - (r.left + hw)) / hw));
            const y = Math.max(-1, Math.min(1, (py - (r.top + hh)) / hh));
            el.style.setProperty('--hk-x', x.toFixed(3));
            el.style.setProperty('--hk-y', y.toFixed(3));
        };
        const onMove = (e: PointerEvent) => {
            px = e.clientX; py = e.clientY;
            if (!el.classList.contains('is-look')) el.classList.add('is-look');
            if (!raf) raf = requestAnimationFrame(apply);
        };
        const onLeave = () => {
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            el.classList.remove('is-look');
            el.style.setProperty('--hk-x', '0');
            el.style.setProperty('--hk-y', '0');
        };
        el.addEventListener('pointermove', onMove, { passive: true });
        el.addEventListener('pointerleave', onLeave, { passive: true });
        return () => {
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerleave', onLeave);
            if (raf) cancelAnimationFrame(raf);
        };
    }, []);

    // Now and then, a glance to one side: one timer, a class for 1.8 s, no
    // React render. Not while the pointer has his attention, not mid-show,
    // not while the window is resting (idleMotion), never under reduced motion.
    useEffect(() => {
        const el = rootRef.current;
        if (!el || !lively) return;
        let t: ReturnType<typeof setTimeout>;
        let clear: ReturnType<typeof setTimeout>;
        const loop = () => {
            t = setTimeout(() => {
                if (!reducedMotion() && isMotionActive() && !el.classList.contains('is-look') && !showRef.current) {
                    const cls = Math.random() < 0.5 ? 'hk-glance-l' : 'hk-glance-r';
                    el.classList.add(cls);
                    clear = setTimeout(() => el.classList.remove(cls), 1800);
                }
                loop();
            }, 9000 + Math.random() * 9000);
        };
        loop();
        return () => {
            clearTimeout(t); clearTimeout(clear);
            el.classList.remove('hk-glance-l', 'hk-glance-r');
        };
    }, [lively]);

    const eyes = show && eyesOn ? SHOWS[show].eyes : null;
    const bubble = line ?? (speech ? { text: speech } : null);

    return (
        <div
            ref={rootRef}
            className="hk"
            data-swim={lively ? signal : 'off'}
            data-spam={show ?? undefined}
            onClick={onZoneClick}
        >
            {/* The bubble lives out here, not in the rig: it must not bob or
                lean with him. Hidden while he naps, as the rig does. */}
            {bubble && mood !== 'asleep' && (
                <span key={bubble.text} className={`k2-speech${bubble.cls ? ` ${bubble.cls}` : ''}`}>{bubble.text}</span>
            )}
            <div className="hk-lean">
                <div className="hk-swim">
                    <div className="hk-react" ref={reactRef}>
                        {/* Behind him: the show's back layer. */}
                        {show === 'glitch' && (
                            <>
                                <Silhouette className="hk-ghost hk-ghost-a" reg={reg('ghostA')} />
                                <Silhouette className="hk-ghost hk-ghost-b" reg={reg('ghostB')} />
                            </>
                        )}
                        {show === 'charge' && (
                            <span className="hk-rings" aria-hidden="true">
                                <span ref={reg('fill')} className="hk-ring hk-ring--fill" />
                                <span ref={reg('ring0')} className="hk-ring" />
                                <span ref={reg('ring1')} className="hk-ring" />
                                <span ref={reg('ring2')} className="hk-ring" />
                            </span>
                        )}
                        <Keys
                            fluid
                            idleSway={false}
                            lively={lively}
                            signal={signal}
                            onMoodChange={setMood}
                            face={face}
                            interceptPoke={interceptPoke}
                            onPoke={onPoke}
                        />
                        {/* In front: the show's face and props, in his own
                            viewBox's proportions (110 x 92). */}
                        <span className="hk-face" aria-hidden="true">
                            {show === 'camo' && <span ref={reg('stripes')} className="hk-stripes" />}
                            {eyes === 'pixel' && (
                                <svg className="hk-eyes" viewBox="0 0 110 92">
                                    <rect x="36.5" y="33" width="9" height="7" />
                                    <rect x="64.5" y="33" width="9" height="7" />
                                    <rect x="45.5" y="35" width="3" height="3" opacity=".6" />
                                </svg>
                            )}
                            {eyes === 'focus' && (
                                <svg className="hk-eyes hk-eyes--stroke" viewBox="0 0 110 92">
                                    <path d="M34 35 L48 39.5" />
                                    <path d="M62 39.5 L76 35" />
                                </svg>
                            )}
                            {eyes === 'float' && (
                                <>
                                    <svg ref={reg('eyesDark')} className="hk-eyes hk-eyes--stroke" viewBox="0 0 110 92">
                                        <path d={BROWS.awakeL} /><path d={BROWS.awakeR} />
                                    </svg>
                                    <svg ref={reg('eyesLight')} className="hk-eyes hk-eyes--stroke hk-eyes--light" viewBox="0 0 110 92">
                                        <path d={BROWS.awakeL} /><path d={BROWS.awakeR} />
                                    </svg>
                                </>
                            )}
                            {show === 'dance' && (
                                <>
                                    <span ref={reg('note0')} className="hk-note">♪</span>
                                    <span ref={reg('note1')} className="hk-note hk-note--b">♫</span>
                                    <span ref={reg('note2')} className="hk-note">♪</span>
                                </>
                            )}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default HomeKeys;
