import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCheck, EyeOff, Gamepad2, Info, KeyRound, Lock, Smartphone, X } from 'lucide-react';
import { ClToggle } from '../../cl';
import { useEscape } from '../../../hooks/useEscape';
import { StepActions } from '../OnboardingFlow';
import { DotTagLayer, burst, place, privacy as privacyScene, privacyAnchors } from '../dots';
import type { DotTag, PrivacyState, SatKey } from '../dots';
import type { StepProps } from '../types';
import {
    initialPinState, isComplete, isEntering, pinHeadline, pinLockedHere, pinReducer, pinToggleOn, type PinLength,
} from './pinEntry';
import './privacy.css';

/**
 * Step 2: Privacy. Ported from the approved round-6 prototype
 * (ob6/js/main.js R.privacy; README "Privacy: the dots illustrate what you
 * share").
 *
 * Every row is a REAL setting, read from and written through the very hook
 * instances Settings uses, the moment it is pressed (Settings commits on
 * toggle too). Nothing is buffered until Continue:
 *   - Send read receipts           usePrivacySettings.setShowReadReceipts
 *   - Share what you're playing    useGameSettings.setShowGameActivity
 *   - Show when you're on mobile   usePrivacySettings.setShowMobilePresence (PATCHes the server)
 *   - Hide from screenshots        usePrivacySettings.setScreenCaptureProtection (main: setContentProtection)
 *   - Unlock with a PIN            useScreenLock.setPin(pin, len) once both entries match (ScreenLockSettings' setup path)
 *
 * The dot sculpture (a gold key sealed in a teal lattice sphere, the three
 * "friends can see" icons in orbit) changes ONLY when one of those three
 * toggles is pressed: off folds the icon into the sphere as a dim bead and
 * leaves a faint ring; on flies it back out. Never on hover. With no WebGL
 * (`dots === null`) the step works the same, without the sculpture.
 */

const SAT_KEYS: readonly SatKey[] = ['receipts', 'playing', 'mobile'];
const ROWS: { key: SatKey; icon: React.ReactNode; title: string; desc: string }[] = [
    { key: 'receipts', icon: <CheckCheck size={16} />, title: 'Send read receipts', desc: 'Friends see when you’ve read their messages. Turn it off and you won’t see theirs either.' },
    { key: 'playing', icon: <Gamepad2 size={16} />, title: 'Share what you’re playing', desc: 'Friends see the game name as your status. Off means nothing is sent.' },
    { key: 'mobile', icon: <Smartphone size={16} />, title: 'Show when you’re on mobile', desc: 'A small phone instead of the dot, when your phone is the only place you’re online.' },
];
const TAG_NAME: Record<SatKey, string> = { receipts: 'Read receipts', playing: 'Playing', mobile: 'On mobile' };

/** The sculpture's world radius in the .viz box, and its nudge up (prototype values). */
const VIZ_R = 1.42;
const VIZ_DY = -14;
/** How long the last slot shows filled before the entry moves on (prototype). */
const ADVANCE_MS = 160;
const CONFIRM_MS = 120;
const MISMATCH_MS = 700;

export const PrivacyStep: React.FC<StepProps> = ({ deps, reducedMotion, dots, showDots, onNext, onBack }) => {
    const { privacy, gameSettings, screenLock } = deps;

    // ── what friends can see: the hooks are the truth (Back / resume show it) ──
    const sat: PrivacyState = {
        receipts: privacy.settings.showReadReceipts,
        playing: gameSettings.settings.showGameActivity,
        mobile: privacy.settings.showMobilePresence,
    };
    // The entrance reads the latest values without re-running on every toggle.
    const satRef = useRef(sat);
    useLayoutEffect(() => { satRef.current = sat; });

    const flip = (k: SatKey, v: boolean) => {
        if (k === 'receipts') privacy.setShowReadReceipts(v);
        else if (k === 'playing') gameSettings.setShowGameActivity(v);
        else privacy.setShowMobilePresence(v);
        // The only thing that moves the dots: an actual toggle press.
        if (dots) void dots.morph(privacyScene(dots.N, { ...sat, [k]: v }, k), { ms: 900, stagger: 0.25, arc: 0.12 });
    };

    // ── unlock with a PIN (the PIN lives only in this reducer's state) ─────────
    const [pin, dispatch] = useReducer(pinReducer, screenLock.settings, initialPinState);
    const [offBusy, setOffBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const entering = isEntering(pin);

    // Advance the entry a beat after the last slot fills, like the prototype.
    useEffect(() => {
        if (pin.stage === 'first' && isComplete(pin)) {
            const t = window.setTimeout(() => dispatch({ type: 'commitFirst' }), ADVANCE_MS);
            return () => window.clearTimeout(t);
        }
        if (pin.stage === 'again' && isComplete(pin) && !pin.mismatch) {
            const t = window.setTimeout(() => dispatch({ type: 'confirm' }), CONFIRM_MS);
            return () => window.clearTimeout(t);
        }
        if (pin.mismatch) {
            const t = window.setTimeout(() => dispatch({ type: 'mismatchReset' }), MISMATCH_MS);
            return () => window.clearTimeout(t);
        }
        return undefined;
    }, [pin]);

    // Both entries matched: the REAL setup path (ScreenLockSettings' submitSetupConfirm).
    const { setPin } = screenLock;
    useEffect(() => {
        if (pin.stage !== 'saving') return;
        let live = true;
        setPin(pin.first, pin.len).then(
            () => { if (live && mounted.current) dispatch({ type: 'saved' }); },
            () => { if (live && mounted.current) dispatch({ type: 'saveFailed' }); },
        );
        return () => { live = false; };
        // only on entering 'saving'; pin.first / pin.len are fixed for that stage
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pin.stage, setPin]);

    // Keep the caret in the slots while picking (turning on, after a length change or a mismatch).
    useEffect(() => {
        if (pin.stage === 'first' || pin.stage === 'again') inputRef.current?.focus({ preventScroll: true });
    }, [pin.stage, pin.len, pin.note]);

    const onPinToggle = async (on: boolean) => {
        if (on) { dispatch({ type: 'turnOn' }); return; }
        if (entering) { dispatch({ type: 'cancel' }); return; }
        // Set in THIS visit: the PIN is still in memory, so turn it off for real.
        if (pin.stage === 'done' && pin.first) {
            setOffBusy(true);
            const ok = await screenLock.disable(pin.first).catch(() => false);
            if (!mounted.current) return;
            setOffBusy(false);
            if (ok) dispatch({ type: 'turnedOff' });
        }
    };

    // ── the dot sculpture ──────────────────────────────────────────────────────
    const vizRef = useRef<HTMLDivElement>(null);
    const [tagsOn, setTagsOn] = useState(false);
    const [obRoot, setObRoot] = useState<Element | null>(null);
    useLayoutEffect(() => { setObRoot(vizRef.current?.closest('[data-ob-root]') ?? null); }, []);

    // The shell fades the canvas in and wakes it; it fades + pauses it again on
    // any step that does not use it.
    useEffect(() => { showDots(true); }, [showDots]);

    useEffect(() => {
        const el = vizRef.current;
        if (!dots || !el) return undefined;
        let live = true;
        // follow/repel 0: the spec says the globe reacts ONLY to a toggle
        // press, never to the pointer (the prototype kept a gentle follow).
        for (const [name, v] of [['follow', 0], ['repel', 0], ['bright', 1.25], ['px', 15], ['drift', 1], ['pitch', 0], ['yaw', 0]] as const) {
            void dots.param(name, v, 600);
        }
        void place(dots, el, VIZ_R, reducedMotion ? 0 : 900, VIZ_DY);
        const into = privacyScene(dots.N, satRef.current, null);
        if (reducedMotion) dots.snap(into);
        else {
            dots.snap(burst(dots.N, { r: 2.4, bright: 0.35 }));
            void dots.morph(into, { ms: 1500, stagger: 0.55, arc: 0.45 });
        }
        // The step slides in (a transform on its wrapper), so the first
        // measurement is off by the slide. Settle on the real box once it ends.
        const wrap = el.closest('.ob-step-anim');
        const anims = wrap && typeof wrap.getAnimations === 'function' ? wrap.getAnimations() : [];
        if (anims.length) {
            Promise.all(anims.map(a => a.finished)).then(() => { if (live) void place(dots, el, VIZ_R, 500, VIZ_DY); }, () => {});
        }
        const t = window.setTimeout(() => setTagsOn(true), reducedMotion ? 0 : 900);
        // Keep it on its box when the window resizes, or when a short window
        // scrolls the step (the canvas is fixed; the box is not).
        const onResize = () => { void place(dots, vizRef.current, VIZ_R, 0, VIZ_DY); };
        const scroller = el.closest('.ob-wiz');
        window.addEventListener('resize', onResize);
        scroller?.addEventListener('scroll', onResize, { passive: true });
        return () => {
            live = false;
            window.clearTimeout(t);
            window.removeEventListener('resize', onResize);
            scroller?.removeEventListener('scroll', onResize);
        };
    }, [dots, reducedMotion]);

    const anchors = privacyAnchors();
    const tags: DotTag[] | null = tagsOn ? [
        ...SAT_KEYS.map((k): DotTag => ({
            id: k,
            at: anchors[k],
            text: `${TAG_NAME[k]} · ${sat[k] ? 'shared' : 'just you'}`,
            cls: sat[k] ? '' : 'faded',
            opacity: sat[k] ? 1 : 0.75,
        })),
        {
            id: 'key',
            at: anchors.key,
            text: <><KeyRound size={11} style={{ display: 'inline', verticalAlign: -1, marginRight: 5 }} />Your keys · this device only</>,
            cls: 'key',
        },
    ] : null;

    // Esc cancels a PIN being picked — through the shared escape stack.
    useEscape(() => dispatch({ type: 'cancel' }), entering);

    const capture = privacy.settings.screenCaptureProtection;
    const pinOn = pinToggleOn(pin);
    const lockedHere = pinLockedHere(pin);
    const pinDone = pin.stage === 'done';

    return (
        <div className="step step--privacy" data-ob-step="privacy">
            <div className="copy">
                <p className="eyebrow">Privacy</p>
                <h1 className="h1">Only you and your people can read it.</h1>
                <p className="lede">
                    Your keys were made on this computer, and they never leave it. Our servers pass along sealed messages they can’t open. What’s left is what you <b>choose</b> to show.
                </p>

                <div className="card pv-card" role="group" aria-labelledby="pv-friends">
                    <p className="lbl" id="pv-friends">What friends can see</p>
                    {ROWS.map(r => (
                        <div className="row" data-row={r.key} key={r.key}>
                            <span className={`tile${sat[r.key] ? '' : ' dim'}`} aria-hidden>{r.icon}</span>
                            <div className="rl"><b>{r.title}</b><span>{r.desc}</span></div>
                            <ClToggle checked={sat[r.key]} onChange={v => flip(r.key, v)} aria-label={r.title} />
                        </div>
                    ))}
                </div>

                <div className="card card--launch" role="group" aria-labelledby="pv-lock">
                    <p className="lbl" id="pv-lock">Lock it down</p>
                    {!entering ? (
                        <div className="launch">
                            <div className="row" data-row="capture">
                                <span className={`tile${capture ? '' : ' dim'}`} aria-hidden><EyeOff size={15} /></span>
                                <div className="rl"><b>Hide from screenshots &amp; recordings</b></div>
                                <ClToggle checked={capture} onChange={privacy.setScreenCaptureProtection} aria-label="Hide from screenshots and recordings" />
                            </div>
                            <div className="row" data-row="pin">
                                <span className={`tile${pinOn ? '' : ' dim'}`} aria-hidden><Lock size={15} /></span>
                                <div className="rl">
                                    <b>Unlock Cipherline with a PIN</b>
                                    {pinDone && <em className="pin-chip"><Check size={11} /> <span>{pin.len}-digit PIN set</span></em>}
                                </div>
                                {lockedHere ? (
                                    // Set on an earlier visit: the PIN is not in memory here, so
                                    // turning it off (which needs the PIN) lives in Settings.
                                    <span title="Turn it off or change it in Settings → Privacy & Safety">
                                        <ClToggle checked disabled onChange={() => {}} aria-label="Unlock Cipherline with a PIN: on. Change it in Settings, Privacy and Safety" />
                                    </span>
                                ) : (
                                    <ClToggle checked={pinOn} disabled={offBusy} onChange={v => { void onPinToggle(v); }} aria-label="Unlock Cipherline with a PIN" />
                                )}
                            </div>
                        </div>
                    ) : (
                        // While choosing the PIN, the entry takes the toggles' place in
                        // the same card, so nothing below moves.
                        <div className={`pinset${pin.mismatch ? ' err' : ''}`}>
                            <span className="tile" aria-hidden><Lock size={15} /></span>
                            <div className="pin-copy">
                                <b id="pv-pin-head" aria-live="polite">{pinHeadline(pin)}</b>
                                {pin.stage === 'first' ? (
                                    // The 4 | 6 choice (ScreenLockSettings' ClSegment), compact, in the sub-line's place.
                                    <span className="pin-len" role="radiogroup" aria-label="PIN length">
                                        {([4, 6] as PinLength[]).map(n => (
                                            <button
                                                key={n}
                                                type="button"
                                                role="radio"
                                                aria-checked={pin.len === n}
                                                onClick={() => { dispatch({ type: 'setLength', len: n }); inputRef.current?.focus({ preventScroll: true }); }}
                                            >
                                                {n}
                                            </button>
                                        ))}
                                        <em>digits</em>
                                    </span>
                                ) : (
                                    <span>It never leaves this computer.</span>
                                )}
                            </div>
                            <label className="pin-slots">
                                {Array.from({ length: pin.len }, (_, i) => (
                                    <span key={i} className={`pin-slot${i < pin.val.length ? ' on' : ''}${i === pin.val.length ? ' cur' : ''}`} />
                                ))}
                                <input
                                    ref={inputRef}
                                    inputMode="numeric"
                                    maxLength={pin.len}
                                    autoComplete="off"
                                    spellCheck={false}
                                    aria-label="PIN"
                                    aria-describedby="pv-pin-head"
                                    value={pin.val}
                                    disabled={pin.stage === 'saving'}
                                    onChange={e => dispatch({ type: 'type', raw: e.target.value })}
                                />
                            </label>
                            <button type="button" className="pin-x" aria-label="Cancel" onClick={() => dispatch({ type: 'cancel' })} disabled={pin.stage === 'saving'}>
                                <X size={14} />
                            </button>
                        </div>
                    )}
                </div>

                <p className="foot"><Info size={13} /><span>You’ll find the rest in <b>Settings → Privacy &amp; Safety</b>.</span></p>
                <StepActions onBack={onBack} onNext={onNext} nextDisabled={pin.stage === 'saving' || offBusy} />
            </div>

            <div className="viz" ref={vizRef}>
                {dots && (
                    <div className="viz-cap">
                        <span className="k"><i />Your keys stay here</span>
                        <span className="s"><i />Lit: friends can see it</span>
                        <span className="p"><i />Folded in: just you</span>
                    </div>
                )}
            </div>
            {obRoot && dots && createPortal(<DotTagLayer field={dots} tags={tags} />, obRoot)}
        </div>
    );
};
