import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Star, Check } from 'lucide-react';
import { ClButton } from '../cl';
import { useEscape } from '../../hooks/useEscape';
import { betaReporter } from '../../utils/betaDiagnostics/reporter';
import { dismissRatingCard, useRatingCard } from '../../utils/betaDiagnostics/callSession';
import { RATING_TAGS, type RatingTag } from '../../utils/betaDiagnostics/types';
import './reportProblem.css';
import './betaDiagnostics.css';

/**
 * "How was that call?" — the closed beta's 1-tap call rating (contract:
 * after a call of 30 s or more, at most once per 3 calls, never twice in 10
 * minutes; see utils/betaDiagnostics/settings.ts decideRatingPrompt).
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
 * call's quality summary (same call_summary_id). Nothing typed, nothing else.
 */

export const AUTO_DISMISS_MS = 45_000;

const STAR_HINT = ['', 'Bad', 'Poor', 'Okay', 'Good', 'Great'] as const;
const TAG_LABEL: Record<RatingTag, string> = {
    echo: 'Echo', robotic: 'Robotic voice', cut_out: 'Audio cut out', one_way: 'Couldn’t hear / be heard',
    lag: 'Delay / lag', video_frozen: 'Video froze', video_blurry: 'Video blurry', share_problem: 'Screen share issue',
    too_quiet: 'Too quiet', too_loud: 'Too loud', other: 'Something else',
};

export interface CallRatingCardViewProps {
    /** Test / harness seam: render without the store. */
    onSubmit: (rating: 1 | 2 | 3 | 4 | 5, tags: RatingTag[]) => void;
    onDismiss: () => void;
    initialRating?: number;
    initialTags?: RatingTag[];
    initialSent?: boolean;
}

export const CallRatingCardView: React.FC<CallRatingCardViewProps> = ({ onSubmit, onDismiss, initialRating = 0, initialTags = [], initialSent = false }) => {
    const [rating, setRating] = useState(initialRating);
    const [tags, setTags] = useState<RatingTag[]>(initialTags);
    const [sent, setSent] = useState(initialSent);
    const [touched, setTouched] = useState(initialRating > 0);
    const starRefs = useRef<Array<HTMLButtonElement | null>>([]);

    // Leave on its own if ignored; stay while the user is mid-rating.
    useEffect(() => {
        if (touched || sent) return;
        const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
        return () => clearTimeout(t);
    }, [touched, sent, onDismiss]);
    useEffect(() => {
        if (!sent) return;
        const t = setTimeout(onDismiss, 1600);
        return () => clearTimeout(t);
    }, [sent, onDismiss]);

    useEscape(onDismiss, !sent);

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
        setSent(true);
    };

    // Roving tabindex: the checked star (or the first) is the one Tab stop.
    const tabStop = rating ? rating - 1 : 0;

    return (
        <div className="cl-kit" style={{ display: 'contents' }}>
            <div className="rp-prompt bd-card" role="dialog" aria-modal="false" aria-labelledby="bd-rate-title" aria-describedby="bd-rate-desc">
                <div className="rp-prompt-head">
                    <div style={{ minWidth: 0 }}>
                        <h3 id="bd-rate-title">How was that call?<span className="bd-beta">Beta</span></h3>
                        <p id="bd-rate-desc">One tap helps us find call problems during the beta. Optional.</p>
                    </div>
                </div>

                {sent ? (
                    <div className="bd-thanks" role="status"><Check size={16} aria-hidden /> Thanks — that helps.</div>
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
    return createPortal(
        <CallRatingCardView
            key={card.callSummaryId}
            onSubmit={(rating, tags) => { betaReporter.rateCall(card.callSummaryId, rating, tags); }}
            onDismiss={dismissRatingCard}
        />,
        document.body,
    );
};

export default CallRatingCard;
