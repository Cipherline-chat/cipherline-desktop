import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Star, Check } from 'lucide-react';
import { ClButton } from '../cl';
import { useEscape } from '../../hooks/useEscape';
import { useAuth } from '../../contexts/AuthContext';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useNotificationPrefsSafe } from '../../contexts/NotificationContext';
import { useToast } from '../../contexts/ToastContext';
import type { CallSummaryInput } from '../../utils/betaDiagnostics/reporter';
import { prepareReportInputs, type LiveContext, type PreparedInputs } from '../../utils/diagnostics/collect';
import { sendDiagnosticReport } from '../../utils/diagnostics/send';
import {
    buildCallQualityBodies, isLowRating, sendCallQualityReports, type SendOutcome, type SendProgress,
} from '../../utils/diagnostics/callQualityReports';
import { dismissRatingCard, submitCallRating, useRatingCard } from '../../utils/betaDiagnostics/callSession';
import { RATING_TAGS, type CallType, type RatingTag } from '../../utils/betaDiagnostics/types';
import './reportProblem.css';
import './betaDiagnostics.css';

/**
 * "How was that call?" — a 1-tap call rating (contract: after a call of 30 s
 * or more, on every 25th such call, never twice in 10 minutes; see
 * utils/betaDiagnostics/settings.ts decideRatingPrompt). It is NOT gated on the
 * "Share beta diagnostics" toggle: rating is an explicit action. With the
 * toggle off nothing automatic is sent; when the user submits a rating, it is
 * uploaded together with that call's quality summary (one request). Dismissing
 * the card sends nothing.
 *
 * A LOW rating (1–2 of 5) adds a step: "Send a call quality report?" — Send
 * submits the call audio, screen share and camera reports through the manual
 * report pipeline (utils/diagnostics/callQualityReports.ts).
 *
 * A small floating card (the same .rp-prompt surface as the crash / GPU
 * prompts) — never a modal, never in the way: it does not take focus from
 * whatever the user went back to, Esc or "Not now" dismisses it, and it
 * leaves on its own after AUTO_DISMISS_MS untouched.
 *
 * Keyboard: the stars are a radio group (arrows move and choose, 1–5 choose
 * directly, Tab leaves); the tags are toggle buttons (aria-pressed).
 * Reduced motion: the card's entrance and the star press are static.
 *
 * What is sent: the 1–5 rating and the chosen tag enums, attached to this
 * call's quality summary (same call_summary_id) when one was queued; and, only
 * on an explicit Send after a low rating, the three diagnostic reports.
 * Nothing typed, never message content.
 */

export const AUTO_DISMISS_MS = 45_000;

const STAR_HINT = ['', 'Bad', 'Poor', 'Okay', 'Good', 'Great'] as const;
const TAG_LABEL: Record<RatingTag, string> = {
    echo: 'Echo', robotic: 'Robotic voice', cut_out: 'Audio cut out', one_way: 'Couldn’t hear / be heard',
    lag: 'Delay / lag', video_frozen: 'Video froze', video_blurry: 'Video blurry', share_problem: 'Screen share issue',
    too_quiet: 'Too quiet', too_loud: 'Too loud', other: 'Something else',
};

type Step = 'rate' | 'thanks' | 'offer' | 'sending' | 'done';

export interface CallRatingCardViewProps {
    /** Test / harness seam: render without the store. */
    onSubmit: (rating: 1 | 2 | 3 | 4 | 5, tags: RatingTag[]) => void;
    onDismiss: () => void;
    /**
     * Low-rating follow-up. When given, a rating of 1–2 asks "Send a call
     * quality report?" and Send calls this (progress is reported through the
     * callback; the promise settles with how many reports went out).
     */
    onSendReports?: (rating: number, tags: RatingTag[], onProgress: (p: SendProgress) => void) => Promise<SendOutcome>;
    initialStep?: Step;
    initialRating?: number;
    initialTags?: RatingTag[];
    initialSent?: boolean;
}

export const CallRatingCardView: React.FC<CallRatingCardViewProps> = ({ onSubmit, onDismiss, initialRating = 0, initialTags = [], initialSent = false, onSendReports, initialStep }) => {
    const [rating, setRating] = useState(initialRating);
    const [tags, setTags] = useState<RatingTag[]>(initialTags);
    const [step, setStep] = useState<Step>(initialStep ?? (initialSent ? 'thanks' : 'rate'));
    const [progress, setProgress] = useState<SendProgress>({ sent: 0, total: 3, waiting: false });
    const [outcome, setOutcome] = useState<SendOutcome | null>(null);
    const [touched, setTouched] = useState(initialRating > 0);
    const starRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const offerSendRef = useRef<HTMLDivElement | null>(null);
    const closeRef = useRef<HTMLDivElement | null>(null);
    const idle = step === 'rate';

    // Leave on its own if ignored; stay while the user is mid-rating.
    useEffect(() => {
        if (touched || !idle) return;
        const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
        return () => clearTimeout(t);
    }, [touched, idle, onDismiss]);
    useEffect(() => {
        // A fully sent confirmation leaves on its own; a partial one stays long enough to read.
        if (step === 'thanks' || (step === 'done' && outcome && outcome.sent === outcome.total)) {
            const t = setTimeout(onDismiss, 1600);
            return () => clearTimeout(t);
        }
        if (step === 'done') {
            const t = setTimeout(onDismiss, 12_000);
            return () => clearTimeout(t);
        }
    }, [step, outcome, onDismiss]);

    // The button the user just pressed is gone after a step change: keep keyboard focus inside the card.
    useEffect(() => {
        if (step === 'offer') offerSendRef.current?.querySelector('button')?.focus();
        else if (step === 'done' && outcome && outcome.sent < outcome.total) closeRef.current?.querySelector('button')?.focus();
    }, [step, outcome]);

    useEscape(onDismiss, step !== 'thanks');

    const choose = (n: number, focus = false) => {
        const v = Math.max(1, Math.min(5, n));
        setRating(v);
        setTouched(true);
        if (focus) starRefs.current[v - 1]?.focus();
    };

    const onStarKey = (e: React.KeyboardEvent) => {
        const cur = rating || 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); choose(cur + 1, true); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); choose(Math.max(1, cur - 1), true); }
        else if (e.key === 'Home') { e.preventDefault(); choose(1, true); }
        else if (e.key === 'End') { e.preventDefault(); choose(5, true); }
        else if (/^[1-5]$/.test(e.key)) { e.preventDefault(); choose(Number(e.key), true); }
    };

    const toggleTag = (t: RatingTag) => {
        setTouched(true);
        setTags(cur => (cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t]));
    };

    const submit = () => {
        if (!rating) return;
        onSubmit(rating as 1 | 2 | 3 | 4 | 5, tags);
        setStep(onSendReports && isLowRating(rating) ? 'offer' : 'thanks');
    };

    const sendReports = () => {
        if (!onSendReports) return;
        setStep('sending');
        void onSendReports(rating, tags, setProgress).then(o => { setOutcome(o); setStep('done'); }, () => { setOutcome({ sent: 0, total: 3 }); setStep('done'); });
    };

    // Roving tabindex: the checked star (or the first) is the one Tab stop.
    const tabStop = rating ? rating - 1 : 0;

    return (
        <div className="cl-kit" style={{ display: 'contents' }}>
            <div className="rp-prompt bd-card" role="dialog" aria-modal="false" aria-labelledby="bd-rate-title" aria-describedby="bd-rate-desc">
                <div className="rp-prompt-head">
                    <div style={{ minWidth: 0 }}>
                        {step === 'offer' || step === 'sending' || (step === 'done' && outcome) ? (
                            <>
                                <h3 id="bd-rate-title">Send a call quality report?</h3>
                                <p id="bd-rate-desc">Sorry that call was rough. A report shares call audio, camera and screen share diagnostics from it, never message content.</p>
                            </>
                        ) : (
                            <>
                                <h3 id="bd-rate-title">How was that call?</h3>
                                <p id="bd-rate-desc">Your rating is sent with this call’s quality stats. Optional.</p>
                            </>
                        )}
                    </div>
                </div>

                {step === 'thanks' ? (
                    <div className="bd-thanks" role="status"><Check size={16} aria-hidden /> Thanks — that helps.</div>
                ) : step === 'offer' ? (
                    <div className="rp-prompt-actions">
                        <ClButton variant="ghost" onClick={onDismiss}>Not now</ClButton>
                        <div ref={offerSendRef} style={{ display: 'contents' }}>
                            <ClButton onClick={sendReports}>Send report</ClButton>
                        </div>
                    </div>
                ) : step === 'sending' ? (
                    <div className="bd-thanks bd-sending" role="status" aria-live="polite">
                        {progress.waiting
                            ? `Sent ${progress.sent} of ${progress.total}. The rest will send automatically in about a minute.`
                            : `Sending… ${progress.sent} of ${progress.total}`}
                    </div>
                ) : step === 'done' && outcome ? (
                    <>
                        <div className={`bd-thanks${outcome.sent < outcome.total ? ' bd-thanks-warn' : ''}`} role="status">
                            {outcome.sent === outcome.total
                                ? <><Check size={16} aria-hidden /> Reports sent. Thank you.</>
                                : `Sent ${outcome.sent} of ${outcome.total}. The rest couldn’t be sent right now; you can send one from Settings → Report a problem.`}
                        </div>
                        {outcome.sent < outcome.total && (
                            <div className="rp-prompt-actions">
                                <div ref={closeRef} style={{ display: 'contents' }}>
                                    <ClButton variant="ghost" onClick={onDismiss}>Close</ClButton>
                                </div>
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <div className="bd-stars" role="radiogroup" aria-label="Call quality, 1 to 5 stars" onKeyDown={onStarKey}>
                            {[1, 2, 3, 4, 5].map(n => (
                                <button
                                    key={n}
                                    ref={el => { starRefs.current[n - 1] = el; }}
                                    type="button"
                                    role="radio"
                                    aria-checked={rating === n}
                                    aria-label={`${n} star${n === 1 ? '' : 's'} — ${STAR_HINT[n]}`}
                                    tabIndex={n - 1 === tabStop ? 0 : -1}
                                    className={`bd-star${n <= rating ? ' is-on' : ''}`}
                                    onClick={() => choose(n)}
                                >
                                    <Star aria-hidden />
                                </button>
                            ))}
                        </div>
                        <p className="bd-star-hint" aria-hidden>{rating ? STAR_HINT[rating] : ''}</p>

                        {rating > 0 && rating < 5 && (
                            <>
                                <p className="bd-tags-label" id="bd-tags-label">What went wrong? <span style={{ fontWeight: 500 }}>(optional)</span></p>
                                <div className="bd-tags" role="group" aria-labelledby="bd-tags-label">
                                    {RATING_TAGS.map(t => (
                                        <button key={t} type="button" className="bd-tag" aria-pressed={tags.includes(t)} onClick={() => toggleTag(t)}>
                                            {TAG_LABEL[t]}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}

                        <div className="rp-prompt-actions">
                            <ClButton variant="ghost" onClick={onDismiss}>Not now</ClButton>
                            <div style={{ display: 'contents' }}>
                                <ClButton onClick={submit} disabled={!rating}>Send</ClButton>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

/** The live card: shows when callSession decided this call gets one. */
export const CallRatingCard: React.FC = () => {
    const card = useRatingCard();
    if (!card) return null;
    return createPortal(<LiveRatingCard key={card.nonce ?? card.callSummaryId ?? 'card'} callSummaryId={card.callSummaryId} heldSummary={card.heldSummary} />, document.body);
};

const LiveRatingCard: React.FC<{ callSummaryId: string | null; heldSummary?: CallSummaryInput }> = ({ callSummaryId, heldSummary }) => {
    const { token, user } = useAuth();
    const { isPaid, canPublishVideo, maxUploadBytes } = useSubscription();
    const notif = useNotificationPrefsSafe();
    const toast = useToast();
    const live: LiveContext = useMemo(() => ({
        user: user ? { username: user.username, email: user.email } : null,
        entitlement: { isPaid, canPublishVideo, maxUploadBytes },
        notificationPrefs: notif?.prefs ?? null,
    }), [user, isPaid, canPublishVideo, maxUploadBytes, notif?.prefs]);
    const tokenRef = useRef(token);
    useEffect(() => { tokenRef.current = token; });
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

    // The call has just ended: take what a report needs NOW (call event log,
    // WebRTC stats ring, settings) before the next call can replace it.
    // Local only — nothing leaves the device until the user presses Send.
    const prepared = useRef<Promise<PreparedInputs | null> | null>(null);
    useEffect(() => {
        prepared.current = prepareReportInputs(live).catch(() => null);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, at the moment the card appears
    }, []);

    const onSendReports = useCallback(async (rating: number, tags: RatingTag[], onProgress: (p: SendProgress) => void): Promise<SendOutcome> => {
        const inputs = await prepared.current;
        if (!inputs) return { sent: 0, total: 3 };
        const bodies = buildCallQualityBodies(inputs, rating, tags);
        const out = await sendCallQualityReports(bodies, {
            send: body => {
                const t = tokenRef.current;
                return t ? sendDiagnosticReport(body, t) : Promise.resolve({ ok: false as const, reason: 'unauthorized' as const, message: '' });
            },
            sleep: ms => new Promise(r => setTimeout(r, ms)),
            onProgress,
        });
        // The card may have been closed while a rate-limit wait ran; say how it ended.
        if (!mounted.current) {
            toast.push(out.sent === out.total
                ? { kind: 'info', title: 'Call quality reports sent', message: 'Thank you.', durationMs: 5000 }
                : { kind: 'error', title: 'Some call reports weren’t sent', message: `Sent ${out.sent} of ${out.total}. You can send one from Settings → Report a problem.`, durationMs: 8000 });
        }
        return out;
    }, [toast]);

    return (
        <CallRatingCardView
            onSubmit={(rating, tags) => submitCallRating({ callSummaryId, heldSummary, callType: 'voice' as CallType }, rating, tags)}
            onSendReports={onSendReports}
            onDismiss={dismissRatingCard}
        />
    );
};

export default CallRatingCard;
