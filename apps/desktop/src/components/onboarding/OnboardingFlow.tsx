import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ClButton } from '../ClButton';
import { Keys } from '../mascot/Keys';
import { bubbleCount, makeBubbles } from '../../utils/deepField';
import {
    ONBOARDING_STEPS, finishOnboarding, setOnboardingStep, type OnboardingStepId,
} from '../../utils/onboardingProgress';
import { INITIAL_FLOW_STATE, type OnboardingDeps, type OnboardingFlowState, type StepProps } from './types';
import { useDotField } from './dots';
import { StorageStep } from './steps/StorageStep';
import { PrivacyStep } from './steps/PrivacyStep';
import { ProfileStep } from './steps/ProfileStep';
import { InviteStep } from './steps/InviteStep';
import { OnboardingEnding } from './ending/OnboardingEnding';
import './onboarding.css';

/**
 * The round-6 first-run setup: storage → privacy → profile → bring a friend /
 * referral / invite → the ending (statements, the trial, the build-out into
 * the real Home). Approved prototype: scratchpad ob6 (README = decision log).
 *
 * Mounted by OnboardingHost OVER the signed-in Dashboard (see
 * utils/onboardingProgress.ts for why it runs after sign-in, and how it
 * resumes). This shell owns: the deep-field backdrop, the lockup + step dots,
 * step navigation (Back on steps 2–4, enter/exit motion), the resume marker,
 * the one shared WebGL dot canvas, and the hand-off to the ending.
 */

const STEP_COMPONENTS: Record<Exclude<OnboardingStepId, 'ending'>, React.FC<StepProps>> = {
    storage: StorageStep,
    privacy: PrivacyStep,
    profile: ProfileStep,
    invite: InviteStep,
};

/** Exit animation length — matches `.step.exit` in onboarding.css. */
const EXIT_MS = 230;

export interface OnboardingFlowProps {
    deps: OnboardingDeps;
    initialStep: OnboardingStepId;
    /** Called once the ending has handed over to the real Home. */
    onDone: () => void;
    /** Dev harness only: force the static (reduced-motion) path. */
    forceReducedMotion?: boolean;
    /** Dev harness only: do not write the resume marker. */
    persist?: boolean;
    /** Dev harness only: pretend earlier steps already set these (e.g. to play the ending with a sent friend request). */
    initialFlow?: Partial<OnboardingFlowState>;
}

/** Back + primary action row (`.acts`), shared by every step. */
export const StepActions: React.FC<{
    onBack?: () => void;
    onNext: () => void;
    nextLabel?: React.ReactNode;
    nextIcon?: React.ReactNode;
    nextDisabled?: boolean;
    loading?: boolean;
    children?: React.ReactNode;
}> = ({ onBack, onNext, nextLabel = 'Continue', nextIcon, nextDisabled, loading, children }) => (
    <div className="acts">
        {onBack && (
            <ClButton variant="ghost" onClick={onBack} disabled={loading}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ChevronLeft size={16} /> Back</span>
            </ClButton>
        )}
        <ClButton onClick={onNext} disabled={nextDisabled} loading={loading}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {nextLabel} {!loading && (nextIcon ?? <ChevronRight size={16} />)}
            </span>
        </ClButton>
        {children}
    </div>
);

/** The shared deep-field backdrop (AuthScreen / the old wizard's look), so the
 *  verify-email card hands off onto the same drifting field. */
const DeepField: React.FC = () => {
    const [bubbles] = useState(() => makeBubbles(bubbleCount()));
    return (
        <div className="ob-deep" aria-hidden>
            <div className="ob-deep-base" />
            <div className="auth-aurora" />
            <div className="ob-deep-field">
                {bubbles.map((b, i) => (
                    <span
                        key={i}
                        className="auth-bubble"
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        style={{ left: b.left, width: b.size, height: b.size, ['--dur' as any]: b.dur, ['--delay' as any]: b.delay, ['--sway' as any]: b.sway }}
                    />
                ))}
            </div>
            <div className="ob-deep-halo" />
            <div className="ob-deep-vig" />
        </div>
    );
};

export const OnboardingFlow: React.FC<OnboardingFlowProps> = ({ deps, initialStep, onDone, forceReducedMotion, persist = true, initialFlow }) => {
    const osReduced = !!useReducedMotion();
    const reducedMotion = osReduced || !!forceReducedMotion;
    const { userId } = deps;

    const [phase, setPhase] = useState<'steps' | 'ending'>(initialStep === 'ending' ? 'ending' : 'steps');
    const [step, setStep] = useState<Exclude<OnboardingStepId, 'ending'>>(initialStep === 'ending' ? 'invite' : initialStep);
    const [direction, setDirection] = useState<1 | -1>(1);
    const [leaving, setLeaving] = useState<null | 1 | -1>(null);
    const [flow, setFlowState] = useState<OnboardingFlowState>(() => ({ ...INITIAL_FLOW_STATE, ...initialFlow }));
    const setFlow = useCallback((patch: Partial<OnboardingFlowState>) => setFlowState(prev => ({ ...prev, ...patch })), []);

    // ── the shared dot field ────────────────────────────────────────────────
    // One full-window field for the whole setup (privacy, invite, the ending):
    // 7000 points, transparent over the deep field, stops 2.6 s after the
    // last change. Null when WebGL is unavailable — every step must cope.
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const dots = useDotField(canvasRef, { count: 7000, transparent: true, settle: 2600, reducedMotion });
    const [dotsOn, setDotsOn] = useState(false);
    const dotsOnRef = useRef(false);
    const pauseTimer = useRef<number | null>(null);
    const showDots = useCallback((on: boolean) => {
        if (dotsOnRef.current === on) return;
        dotsOnRef.current = on;
        setDotsOn(on);
        if (pauseTimer.current) { window.clearTimeout(pauseTimer.current); pauseTimer.current = null; }
        // Fade first, then stop drawing entirely (the .6 s opacity transition).
        if (on) dots?.pause(false);
        else pauseTimer.current = window.setTimeout(() => { if (!dotsOnRef.current) dots?.pause(true); }, 650);
    }, [dots]);
    useEffect(() => () => { if (pauseTimer.current) window.clearTimeout(pauseTimer.current); }, []);
    // Nothing draws until a step asks for the dots.
    useEffect(() => { if (dots && !dotsOnRef.current) dots.pause(true); }, [dots]);

    // ── navigation ──────────────────────────────────────────────────────────
    const busyRef = useRef(false);
    const goTo = useCallback((next: OnboardingStepId, dir: 1 | -1) => {
        if (busyRef.current) return;
        busyRef.current = true;
        if (persist) setOnboardingStep(userId, next);
        // Leaving step 4 forward: the referrer friend-request offer has had its
        // one moment; forget it so the Dashboard never offers it a second time.
        if (next === 'ending') deps.clearReferrer();
        if (next !== 'privacy' && next !== 'invite') showDots(false);
        const swap = () => {
            setLeaving(null);
            setDirection(dir);
            if (next === 'ending') setPhase('ending');
            else setStep(next);
            busyRef.current = false;
        };
        if (reducedMotion) { swap(); return; }
        setLeaving(dir);
        window.setTimeout(swap, EXIT_MS);
    }, [persist, userId, reducedMotion, showDots, deps]);

    const idx = ONBOARDING_STEPS.indexOf(step);
    const onNext = useCallback(() => {
        const next = ONBOARDING_STEPS[idx + 1] ?? 'ending';
        goTo(next, 1);
    }, [idx, goTo]);
    const onBack = idx > 0 ? () => goTo(ONBOARDING_STEPS[idx - 1], -1) : undefined;

    const finish = useCallback(() => {
        if (persist) finishOnboarding(userId);
        onDone();
    }, [persist, userId, onDone]);

    // A fresh step starts at the top of the scroller.
    const wizRef = useRef<HTMLDivElement>(null);
    useEffect(() => { wizRef.current?.scrollTo({ top: 0 }); }, [step]);

    const Step = STEP_COMPONENTS[step];
    const stepCls = leaving ? `exit${leaving < 0 ? ' back' : ''}` : `enter${direction < 0 ? ' back' : ''}`;

    return (
        <div className={`ob${reducedMotion ? ' rm' : ''}`} role="dialog" aria-modal="true" aria-label="Set up Cipherline" data-ob-root>
            <DeepField />
            <canvas ref={canvasRef} className={`ob-dots${dotsOn ? ' on' : ''}${phase === 'ending' ? ' over' : ''}`} aria-hidden />

            {phase === 'steps' && (
                <div className="ob-wiz" ref={wizRef}>
                    <header className="ob-head">
                        <div className="ob-lockup">
                            <span className="ob-lockup-keys"><Keys size={38} interactive={false} waveOnMount={false} /></span>
                            <span>Cipherline</span>
                        </div>
                        <div className="ob-stepdots" aria-hidden>
                            {ONBOARDING_STEPS.map((s, i) => <i key={s} className={i === idx ? 'on' : ''} />)}
                        </div>
                    </header>
                    <div className="ob-body">
                        {/* The wrapper carries the enter/exit motion; the step renders
                            its own `.step` grid (`step--one` for single-column). */}
                        <div className={`ob-step-anim ${stepCls}`} key={step}>
                            <Step
                                deps={deps}
                                flow={flow}
                                setFlow={setFlow}
                                reducedMotion={reducedMotion}
                                dots={dots}
                                showDots={showDots}
                                onNext={onNext}
                                onBack={onBack}
                                direction={direction}
                            />
                        </div>
                    </div>
                </div>
            )}

            {phase === 'ending' && (
                <OnboardingEnding
                    deps={deps}
                    flow={flow}
                    reducedMotion={reducedMotion}
                    dots={dots}
                    showDots={showDots}
                    onDone={finish}
                />
            )}
        </div>
    );
};
