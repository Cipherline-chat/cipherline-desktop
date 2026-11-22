import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Check, Clock, Crown, Loader2 } from 'lucide-react';
import { padDiscriminator } from '@cipherline/shared';
import { API_BASE } from '../../../constants';
import { useAuth } from '../../../contexts/AuthContext';
import { useSubscription } from '../../../contexts/SubscriptionContext';
import { useToast } from '../../../contexts/ToastContext';
import { useEscape } from '../../../hooks/useEscape';
import {
    cleanDiscriminatorDraft, canChangeDiscriminatorMirror, discriminatorCommitAction,
    discriminatorFieldState, discriminatorPreview, discriminatorSaveError,
    discriminatorWireValue,
} from '../../../utils/discriminatorField';
import { useProTagPopover } from './ProTagPopover';

export const DISCRIMINATOR_HELD_MESSAGE = 'Your new username gets its own #number when it saves. Change the number after that.';

export interface UsernameTagFieldProps {
    /** The label's content ("Username"; no Pro pill since 2026-11-16). */
    label: React.ReactNode;
    /** The username <input id="pf-username" className="ps-namefield-name">. ProfilePane owns its
     *  draft and its save (on leaving the pane); this only lays it out. */
    usernameInput: React.ReactElement;
    /** The username's own messages (cooldown / invalid / "saves when you leave"). */
    usernameMessages: React.ReactNode;
    /** The username field is in an error state (rings the whole field). */
    usernameInvalid: boolean;
    /** A username change is pending. Saving it picks a new #number for that name, so the
     *  number segment holds until then instead of changing a number that is about to go. */
    usernameDirty: boolean;
}

/**
 * Settings -> Profile: the username and its "#0000" as ONE field, reading like
 * `Shinobi #0001` (owner, 2026-11-16). The number is an attached segment you
 * edit in place: digits only, always all 4 (0001-9999; "42" is not accepted, type 0042).
 *
 * The page has no Save button (ProfilePane), and a username only saves when you
 * leave the pane. The number cannot wait that long: it is its own endpoint whose
 * outcome (taken, not Pro) has to land while you are still looking at it. So it
 * saves on Enter or when you leave the segment, shows a small check, and toasts.
 * Escape puts the saved number back.
 *
 * Pro gate: MIRROR ONLY. POST /v1/auth/discriminator enforces it (403), the
 * 1..9999 range (400), uniqueness (409) and the 24 h cooldown (429). Free and
 * trial accounts see the segment read-only with a gold crown; hovering,
 * clicking or focusing it opens a small crown popover saying it is a Pro
 * feature (owner 2026-11-16) - never the full-screen upsell. Inside the 24 h
 * cooldown it is read-only with "You can change your #number again in 7 h (...)".
 */
export const UsernameTagField: React.FC<UsernameTagFieldProps> = ({
    label, usernameInput, usernameMessages, usernameInvalid, usernameDirty,
}) => {
    const { user, token, refreshProfile } = useAuth();
    const { status } = useSubscription();
    const toast = useToast();
    const current = user?.discriminator ?? null;
    /** null = not edited: the segment shows the saved number. */
    const [draft, setDraft] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [serverError, setServerError] = useState<{ value: string; message: string } | null>(null);
    const [saved, setSaved] = useState(false);
    /** The person left the segment (blur / Enter) with fewer than 4 digits: only then say so. */
    const [shortTried, setShortTried] = useState(false);
    /** The segment was focused while held by a pending rename: say why. */
    const [explain, setExplain] = useState(false);
    /** `next_change_at` from a cooldown 429, so the segment locks at once
     *  instead of waiting for /auth/me to catch up. */
    const [lockedUntil, setLockedUntil] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const nextChangeAt = lockedUntil ?? user?.next_discriminator_change_at ?? null;
    // Tick while a cooldown is known, so "again in 7 h" counts down and the segment unlocks on time.
    useEffect(() => {
        if (!nextChangeAt) return;
        const t = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(t);
    }, [nextChangeAt]);
    const digitsRef = useRef<HTMLInputElement>(null);
    const inFlight = useRef(false);
    const savedTimer = useRef<number | null>(null);
    useEffect(() => () => { if (savedTimer.current) window.clearTimeout(savedTimer.current); }, []);

    const canChange = canChangeDiscriminatorMirror(status);
    const field = discriminatorFieldState({
        draft: draft ?? '', current, canChange, isTrial: status?.subscription_status === 'trial',
        nextChangeAt, now,
    });
    const locked = field.kind === 'locked';
    const cooling = field.kind === 'cooldown';
    const held = !locked && !cooling && usernameDirty;
    const segmentState: 'locked' | 'cooldown' | 'held' | 'edit' = locked ? 'locked' : cooling ? 'cooldown' : held ? 'held' : 'edit';
    const { anchorProps: tip, describedBy: tipId, popover: tipPopover } = useProTagPopover(locked, locked ? field.message : '', 'pf-discriminator-protip');
    const errorFor = !held && serverError && serverError.value === draft ? serverError.message : null;
    // Fewer than 4 digits is "still typing" until they leave the segment or press Enter.
    const stillTyping = field.kind === 'invalid' && /^\d{1,3}$/.test(draft ?? '') && !shortTried;
    const fieldInvalid = field.kind === 'invalid' && !stillTyping;
    const digitsInvalid = !held && (fieldInvalid || !!errorFor);
    const savedNumber = current === null ? '' : padDiscriminator(current);
    // Held: the saved number, whatever was typed (it would not survive the rename anyway).
    const shown = held || cooling || locked ? savedNumber : (draft ?? savedNumber);
    const username = user?.username ?? '';

    const revert = () => { setDraft(null); setServerError(null); setShortTried(false); };

    // Escape puts the saved number back - only while the segment has an edit and focus;
    // otherwise the press falls through (e.g. to closing Settings).
    useEscape(() => {
        if (document.activeElement !== digitsRef.current) return false;
        revert();
    }, draft !== null || serverError !== null);

    const commit = async () => {
        if (held) return;
        const action = discriminatorCommitAction(field, draft, serverError?.value ?? null);
        if (action === 'revert') { revert(); return; }
        if (field.kind === 'invalid') setShortTried(true);
        if (action !== 'save' || field.kind !== 'ok' || inFlight.current || !token) return;
        const attempted = draft ?? '';
        inFlight.current = true;
        setBusy(true);
        setServerError(null);
        try {
            await axios.post(`${API_BASE}/auth/discriminator`, { discriminator: discriminatorWireValue(field.value) }, { headers: { Authorization: `Bearer ${token}` } });
            await refreshProfile();
            toast.push({ kind: 'success', message: `You are now ${discriminatorPreview(username, field.value)}.` });
            setDraft(null);
            setSaved(true);
            if (savedTimer.current) window.clearTimeout(savedTimer.current);
            savedTimer.current = window.setTimeout(() => setSaved(false), 2200);
        } catch (err) {
            const known = discriminatorSaveError(err);
            if (known?.kind === 'cooldown' && known.nextChangeAt) {
                // Changed elsewhere (another device / the website) in the last
                // 24 h: lock now and put the saved number back.
                setLockedUntil(known.nextChangeAt);
                setNow(Date.now());
                setDraft(null);
                void refreshProfile();
            } else {
                setServerError({ value: attempted, message: known?.message ?? 'Could not change your #number. Please try again.' });
            }
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };

    const onSegmentMouseDown = (e: React.MouseEvent) => {
        // A click anywhere on the segment (the "#", the padding) lands in the digits.
        if (e.target !== digitsRef.current) { e.preventDefault(); digitsRef.current?.focus(); }
    };
    const onDigitsKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (locked && (e.key === 'Enter' || e.key === ' ')) {
            // Keyboard "click": show the Pro box (focus already did), nothing else.
            e.preventDefault();
            tip.onClick();
            return;
        }
        if (e.key === 'Enter') { e.preventDefault(); void commit(); }
    };

    const statusIcon = locked ? <Crown size={13} strokeWidth={2.5} />
        : cooling ? <Clock size={12} strokeWidth={2.5} />
        : busy ? <Loader2 size={13} className="ps-spin" />
        : saved ? <Check size={14} strokeWidth={3} />
        : null;

    return (
        <div className="cl-fld" style={{ margin: 0 }}>
            <label htmlFor="pf-username" className="flex items-center gap-2">{label}</label>
            <div className="ps-namefield" data-invalid={usernameInvalid || digitsInvalid ? 'true' : undefined}>
                {usernameInput}
                {current !== null && (
                    <div
                        className="ps-namefield-num"
                        data-state={segmentState}
                        data-testid="pf-discriminator-segment"
                        ref={tip.setAnchor}
                        title={held ? DISCRIMINATOR_HELD_MESSAGE : undefined}
                        onMouseDown={onSegmentMouseDown}
                        onPointerEnter={tip.onPointerEnter}
                        onPointerLeave={tip.onPointerLeave}
                        onClick={tip.onClick}
                    >
                        <span className="ps-namefield-hash" aria-hidden="true">#</span>
                        <input
                            ref={digitsRef}
                            id="pf-discriminator"
                            className="ps-namefield-digits"
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={4}
                            size={4}
                            placeholder="0001"
                            aria-label="Number after your username"
                            aria-describedby={['sd-discriminator-msg', tipId].filter(Boolean).join(' ')}
                            aria-invalid={digitsInvalid || undefined}
                            aria-busy={busy || undefined}
                            aria-disabled={locked || cooling || undefined}
                            readOnly={locked || cooling || held || busy}
                            value={shown}
                            onChange={(e) => { if (locked || cooling) return; setShortTried(false); setDraft(cleanDiscriminatorDraft(e.target.value)); }}
                            onKeyDown={onDigitsKeyDown}
                            onFocus={(e) => {
                                if (locked) { tip.onFocus(); return; }
                                if (held) { setExplain(true); return; }
                                if (cooling) return;
                                e.currentTarget.select();
                            }}
                            onBlur={() => { if (locked) { tip.onBlur(); return; } void commit(); }}
                        />
                        <span className="ps-namefield-status" data-kind={locked ? 'locked' : cooling ? 'cooldown' : busy ? 'busy' : saved ? 'saved' : undefined} aria-hidden="true">
                            {statusIcon}
                        </span>
                    </div>
                )}
            </div>
            <div id="sd-username-msg" className="ps-namefield-msg" aria-live="polite">{usernameMessages}</div>
            <div id="sd-discriminator-msg" className="ps-namefield-msg" aria-live="polite">
                {field.kind === 'cooldown' && (
                    <p className="ps-note flex items-center gap-1" data-testid="pf-discriminator-cooldown" style={{ marginTop: 6 }}>
                        <Clock size={11} aria-hidden /> {field.message}
                    </p>
                )}
                {held && explain && <p className="ps-note" style={{ marginTop: 6 }}>{DISCRIMINATOR_HELD_MESSAGE}</p>}
                {fieldInvalid && !held && <p className="cl-fmsg">{field.message}</p>}
                {!fieldInvalid && errorFor && <p className="cl-fmsg">{errorFor}</p>}
                {field.kind === 'ok' && !errorFor && !held && (
                    <p className="ps-note" style={{ marginTop: 6, color: 'var(--cl-glow-text)' }}>
                        You will be {discriminatorPreview(username, field.value)}. Press Enter to save, Esc to undo.
                    </p>
                )}
                {saved && <span className="sr-only">Number saved.</span>}
            </div>
            {tipPopover}
        </div>
    );
};
