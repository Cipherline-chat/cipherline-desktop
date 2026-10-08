import secureLocalStore from '../utils/secureLocalStore';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TurnstileFrame } from './TurnstileFrame';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { loadZxcvbn, useZxcvbn } from '../utils/passwordStrength';
import { API_BASE } from '../constants';
import type { OpenedBackupFile } from '../services/driveBackup';
import { Lock, Mail, Eye, EyeOff, Upload, KeyRound, Smartphone, Calendar, ShieldCheck, Monitor, Sparkles, CheckCircle2, ChevronRight, HardDrive, Gift, Check, X, Loader2 } from 'lucide-react';
import { markLocalHistory, probeLocalHistory } from '../utils/localHistoryFlag';
import { startOnboarding } from '../utils/onboardingProgress';
import cipherlineMark from '../assets/cipherline-mark.svg';
import { ClButton } from './ClButton';
import { DatePicker } from './DatePicker';
import { ClInput, ClCheckbox, ClSegment } from './cl';
import SlottedCodeInput from './SlottedCodeInput';
import { bubbleCount, makeBubbles } from '../utils/deepField';
import { registerOrReuseDevice } from '../utils/deviceRegistration';
import { openExternalLink } from '../utils/openExternalLink';
import QrSignInPanel from './link/QrSignInPanel';
import { ReferralAppliedCard } from './auth/ReferralAppliedCard';
import { AttributionClipboardOffer } from './auth/AttributionClipboardOffer';
import {
    clearPendingReferral, getPendingReferral, getPendingInvite, onPendingInviteChange, setPendingReferral, setPendingInvite,
    parseAttributionInput, peekClipboardOnce, rememberReferrer,
    resolveReferral,
    type ParsedAttribution, type ReferrerTag,
} from '../utils/signupAttribution';

/* ─────────────────────────────────────────────
   Sub-components
───────────────────────────────────────────── */
const Field: React.FC<{
    icon: React.ReactNode;
    type?: string;
    placeholder: string;
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
    rightSlot?: React.ReactNode;
    autoFocus?: boolean;
}> = ({ icon, type = 'text', placeholder, value, onChange, disabled, rightSlot, autoFocus }) => (
    <div className="relative">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 flex pointer-events-none" style={{ color: 'var(--cl-faint)' }}>{icon}</span>
        <ClInput
            type={type}
            placeholder={placeholder}
            value={value}
            onChange={e => onChange(e.target.value)}
            disabled={disabled}
            style={{ paddingLeft: '44px', paddingRight: rightSlot ? '44px' : undefined }}
            autoComplete="off"
            spellCheck={false}
            autoFocus={autoFocus}
        />
        {rightSlot && (
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 flex cursor-pointer" style={{ color: 'var(--cl-faint)' }}>{rightSlot}</span>
        )}
    </div>
);

const ErrorBanner: React.FC<{ msg: string }> = ({ msg }) => (
    <div className="auth-bannerin px-4 py-3 bg-cl-flash/10 border border-cl-flash/25 rounded-xl text-cl-flash text-sm text-center">{msg}</div>
);

const InfoBanner: React.FC<{ msg: string }> = ({ msg }) => (
    <div className="auth-bannerin px-4 py-3 bg-cl-lume/10 border border-cl-lume/25 rounded-xl text-cl-lume text-sm text-center">{msg}</div>
);

const StrengthBar: React.FC<{ score: number }> = ({ score }) => {
    const colors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-400', 'bg-green-400', 'bg-emerald-500'];
    const labels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
    return (
        <div>
            <div className="h-[3px] bg-white/[0.08] rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-300 ${colors[score]}`} style={{ width: `${(score + 1) * 20}%` }} />
            </div>
            <p className="text-[11px] text-cl-faint text-right mt-1">{labels[score]}</p>
        </div>
    );
};

/** Referral code field with live validation. Shows a gift icon, validates on 8 chars,
 *  and once the code resolves shows WHO it belongs to ("Invited by Sam#1234") in an
 *  animated card. Accepts a pasted referral link as well as a bare code. */
const ReferralCodeField: React.FC<{
    value: string;
    onChange: (v: string) => void;
    disabled: boolean;
    forceOpen?: boolean;
    onValidityChange?: (valid: boolean | null) => void;
    /** Called with the referrer's public tag when the code resolves (null while unresolved / on removal). */
    onResolved?: (referrer: ReferrerTag | null) => void;
    /** The person pressed Remove on the applied card. */
    onRemove?: () => void;
}> = ({ value, onChange, disabled, forceOpen, onValidityChange, onResolved, onRemove }) => {
    const [open, setOpen] = useState(!!value || !!forceOpen);
    const [status, setStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid' | 'error'>('idle');
    // The resolved owner, keyed by the code it was resolved for: a stale answer for
    // an edited code simply stops matching (derived below), so no state has to be
    // reset synchronously when the code changes.
    const [resolved, setResolved] = useState<{ code: string; referrer: ReferrerTag | null } | null>(null);
    const referrer = resolved && resolved.code === value.trim() ? resolved.referrer : null;
    // Keep the callbacks in refs so the debounce closure doesn't capture stale props.
    const onValidityRef = useRef(onValidityChange);
    const onResolvedRef = useRef(onResolved);
    useEffect(() => { onValidityRef.current = onValidityChange; onResolvedRef.current = onResolved; });

    useEffect(() => { if (value || forceOpen) setOpen(true); }, [value, forceOpen]);

    useEffect(() => {
        const trimmed = value.trim();
        onResolvedRef.current?.(null);
        if (trimmed.length < 8) {
            setStatus('idle');
            onValidityRef.current?.(null);
            return;
        }
        setStatus('checking');
        let cancelled = false;
        const t = setTimeout(async () => {
            const res = await resolveReferral(trimmed);
            if (cancelled) return;
            if (res.valid) {
                setStatus('valid');
                setResolved({ code: trimmed, referrer: res.referrer ?? null });
                onResolvedRef.current?.(res.referrer ?? null);
                onValidityRef.current?.(true);
                // Carry it across the signup steps (and an app restart) until signup uses it.
                setPendingReferral(trimmed);
            } else {
                setStatus(res.failed ? 'error' : 'invalid');
                onValidityRef.current?.(false);
            }
        }, 500);
        return () => { cancelled = true; clearTimeout(t); };
    }, [value]);

    const rightSlot =
        status === 'checking' ? <Loader2 size={14} className="animate-spin" style={{ color: 'var(--cl-muted)' }} /> :
        status === 'valid'    ? <Check size={14} style={{ color: 'var(--cl-lume)' }} /> :
        status === 'invalid' || status === 'error' ? <X size={14} style={{ color: 'var(--cl-flash)' }} /> :
        null;

    const handleChange = (v: string) => {
        // A pasted landing-page link / deep link becomes its code.
        const parsed = parseAttributionInput(v);
        onChange(parsed?.kind === 'ref' ? parsed.code : v.toUpperCase());
    };

    return (
        <div>
            {!open ? (
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className="flex items-center gap-1.5 text-[12px] text-cl-muted hover:text-cl-lume transition-colors"
                >
                    <Gift size={12} />
                    Have a referral code? <span className="text-cl-lume">+7 free days</span>
                </button>
            ) : status === 'valid' && referrer ? (
                <ReferralAppliedCard
                    username={referrer.username}
                    discriminator={referrer.discriminator}
                    disabled={disabled}
                    onRemove={() => { onRemove?.(); }}
                />
            ) : (
                <div>
                    <Field
                        icon={<Gift size={15} />}
                        placeholder="Referral code or link"
                        value={value}
                        onChange={handleChange}
                        disabled={disabled}
                        autoFocus={!forceOpen && !value}
                        rightSlot={rightSlot}
                    />
                    {status === 'valid' && (
                        <p className="text-xs mt-1.5 pl-1 transition-all" style={{ color: 'var(--cl-lume)' }}>
                            +7 free days applied!
                        </p>
                    )}
                    {status === 'invalid' && (
                        <p className="text-xs mt-1.5 pl-1" style={{ color: 'var(--cl-flash)' }}>
                            That referral code isn't valid.
                        </p>
                    )}
                    {status === 'error' && (
                        <p className="text-xs mt-1.5 pl-1" style={{ color: 'var(--cl-flash)' }}>
                            Couldn't check that code right now. Check your connection and try again.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

/* ─────────────────────────────────────────────
   Page shell — defined at MODULE scope (not inside AuthScreen) so it keeps a
   stable component identity across renders. Defining it inside the component
   recreates the function every render, which unmounts/remounts the inputs and
   makes them lose focus after a single keystroke.
───────────────────────────────────────────── */
/** The mascot, poked — dry one-liners in the tagline slot it already owns. */
const MASCOT_QUIPS = [
    "shhh — your messages are encrypted.",
    "i can't read your messages. nobody can.",
    "your keys never leave this device.",
    "no, i won't tell. i literally can't.",
    "boop. still encrypted.",
    "i'm a vault, not a snitch.",
];

/**
 * Backdrop for the auth screens: a slow-drifting gradient wash, flat little
 * bubbles rising from below on a layer that parallax-translates with the
 * cursor (move the mouse → the field slides left/right + up/down, rAF-eased and
 * subtle), and a soft vignette. Behind the card, inert to pointers. Honors
 * prefers-reduced-motion (gradient + bubbles freeze, the field stops sliding).
 */
const AuthBackground: React.FC = () => {
    const fieldRef  = useRef<HTMLDivElement>(null);
    const auroraRef = useRef<HTMLDivElement>(null);
    const [bubbles, setBubbles] = useState(() => makeBubbles(bubbleCount()));

    // Regenerate dots when the window is resized to a different size tier.
    useEffect(() => {
        let last = bubbleCount();
        const onResize = () => {
            const next = bubbleCount();
            if (next !== last) { last = next; setBubbles(makeBubbles(next)); }
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        const field = fieldRef.current;
        if (!field) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        let raf = 0;
        const target = { x: 0, y: 0 };
        const cur = { x: 0, y: 0 };
        const onMove = (e: MouseEvent) => {
            target.x = (e.clientX / window.innerWidth - 0.5) * 46;    // ±23px left/right
            target.y = (e.clientY / window.innerHeight - 0.5) * 46;   // ±23px up/down
        };
        const tick = () => {
            cur.x += (target.x - cur.x) * 0.06;
            cur.y += (target.y - cur.y) * 0.06;
            field.style.transform = `translate3d(${cur.x.toFixed(2)}px, ${cur.y.toFixed(2)}px, 0)`;
            // Aurora parallaxes at ~40% of the field for a gentle depth offset
            // (its own gradient drift runs via CSS background-position, no clash).
            if (auroraRef.current) auroraRef.current.style.transform = `translate3d(${(cur.x * 0.4).toFixed(2)}px, ${(cur.y * 0.4).toFixed(2)}px, 0)`;
            raf = requestAnimationFrame(tick);
        };
        window.addEventListener('mousemove', onMove);
        raf = requestAnimationFrame(tick);
        return () => { window.removeEventListener('mousemove', onMove); cancelAnimationFrame(raf); };
    }, []);
    return (
        <div className="fixed inset-0 overflow-hidden pointer-events-none auth-scene-fade" style={{ zIndex: 0 }} aria-hidden>
            {/* Lume bloom — single expanding pulse, the first thing visible on mount */}
            <div className="auth-lume-bloom" aria-hidden />
            <div ref={auroraRef} className="auth-aurora" />
            <div ref={fieldRef} className="absolute inset-0 auth-bubbles-enter" style={{ willChange: 'transform' }}>
                {bubbles.map((b, i) => (
                    <span
                        key={i}
                        className="auth-bubble"
                        style={{ left: b.left, width: b.size, height: b.size, ['--dur' as any]: b.dur, ['--delay' as any]: b.delay, ['--sway' as any]: b.sway }}
                    />
                ))}
            </div>
            <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 85% at 50% -10%, transparent 45%, rgba(0,0,0,.4) 100%)' }} />
        </div>
    );
};

/**
 * Brand block — a big, clickable cipherline mascot that wiggles and pops a dry
 * one-liner into the tagline slot it already owns (doctrine-faithful: a slot the
 * UI owns, ≥3 rotating lines, reverts after a beat). Reduced-motion skips the
 * wiggle but still swaps the line.
 */
const AuthBrand: React.FC = () => {
    const markRef = useRef<HTMLImageElement>(null);
    const [quip, setQuip] = useState<string | null>(null);
    const idx = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const poke = () => {
        const el = markRef.current;
        if (el && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            el.animate([
                { transform: 'rotate(0) scale(1)' },
                { transform: 'rotate(-9deg) scale(1.07)' },
                { transform: 'rotate(7deg) scale(1.07)' },
                { transform: 'rotate(-3deg) scale(1.02)' },
                { transform: 'rotate(0) scale(1)' },
            ], { duration: 640, easing: 'cubic-bezier(.34,1.56,.64,1)' });
        }
        setQuip(MASCOT_QUIPS[idx.current % MASCOT_QUIPS.length]);
        idx.current += 1;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setQuip(null), 2600);
    };
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    return (
        <div className="text-center mb-8 auth-brand-drop">
            <button
                type="button"
                onClick={poke}
                title="poke me"
                aria-label="cipherline"
                className="inline-flex items-center justify-center mx-auto mb-4"
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, transition: 'transform .35s var(--cl-spring)' }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-3px)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0)')}
            >
                {/* float on the wrapper (transform), glow-pulse on the img (filter) —
                    different properties, so the click wiggle (WAA, transform) can ride
                    on top without fighting either. */}
                <span className="auth-mascot-float inline-flex">
                    <img ref={markRef} src={cipherlineMark} alt="cipherline" width={84} height={68} className="auth-mascot-img" />
                </span>
            </button>
            <h1 className="font-display text-[2rem] text-cl-text leading-none tracking-tight" style={{ fontWeight: 600 }}>cipherline</h1>
            <div className="h-5 mt-2 flex items-center justify-center">
                {quip
                    ? <p key={quip} className="cl-egg text-[13px] font-semibold" style={{ color: 'var(--cl-lume)' }}>{quip}</p>
                    : <p className="text-cl-faint text-sm">encrypted chat for your community</p>}
            </div>
        </div>
    );
};

const Shell: React.FC<{ children: React.ReactNode; shake?: boolean }> = ({ children, shake }) => {
    // Animate the card's height so switching views (e.g. login → sign-up) and
    // banners appearing make the card grow/shrink smoothly instead of snapping.
    const innerRef = useRef<HTMLDivElement>(null);
    const [h, setH] = useState<number | undefined>(undefined);
    useLayoutEffect(() => {
        const inner = innerRef.current;
        if (!inner) return;
        const measure = () => setH(inner.offsetHeight);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(inner);
        return () => ro.disconnect();
    }, []);
    return (
        <div className="w-screen h-screen bg-cl-abyss font-sans relative overflow-y-auto overflow-x-hidden custom-scrollbar">
            <AuthBackground />
            {/* Overflow-safe centering: a flex parent (min-h-full) with an m-auto
                child centers the form when it fits and scrolls — never clipping the
                tall sign-up form — when it doesn't. (align-items:center would pin the
                top off-screen and make it unscrollable.) */}
            <div className="relative min-h-full flex" style={{ zIndex: 1 }}>
            <div className="m-auto w-full max-w-sm px-5 py-10">
                <AuthBrand />
                {/* Glassy card — translucent deep + backdrop blur over the living bg,
                    top inner highlight + faint lume edge for a frosted-glass read.
                    Height animates (content measured below); `auth-shake` plays a
                    brief horizontal shake when a form errors. */}
                <div
                    className={`rounded-2xl relative auth-card-rise${shake ? ' auth-shake' : ''}`}
                    style={{
                        background: 'rgba(19,26,48,0.55)',
                        backdropFilter: 'blur(22px) saturate(1.3)',
                        WebkitBackdropFilter: 'blur(22px) saturate(1.3)',
                        border: '1px solid rgba(255,255,255,0.10)',
                        boxShadow: '0 24px 64px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.10), 0 0 0 1px rgba(37,224,200,.05)',
                        height: h,
                        overflow: 'hidden',
                        transition: 'height .34s cubic-bezier(.22,1,.36,1)',
                    }}
                >
                    <div ref={innerRef} className="p-7">{children}</div>
                </div>
            </div>
            </div>
        </div>
    );
};

/* ─────────────────────────────────────────────
   Shared post-auth helpers
   `registerOrReuseDevice` now lives in ../utils/deviceRegistration.ts so
   QrSignInPanel.tsx (QR sign-in's NEW-device half) can reuse the exact same
   path this file's password login uses, rather than a second copy.
───────────────────────────────────────────── */

/* ─────────────────────────────────────────────
   AuthScreen
───────────────────────────────────────────── */
type View =
    | 'login'
    | 'login-2fa'
    | 'register'
    | 'verify-email'
    | 'forgot-password'
    | 'reset-password'
    | 'device-not-approved'
    | 'restore-backup'
    | 'login-returning'
    | 'history-options'
    | 'history-unreadable';

/** Message off an unknown thrown value, '' when it carries none. */
function errText(err: unknown): string {
    return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

/** Animated "Welcome back" screen — its own component so the auto-advance
 *  useEffect gets a clean single-mount lifecycle. */
const ReturningShell: React.FC<{
    payload: { token: string; userId: string; deviceId: string; refresh_token?: string };
    email: string;
    login: (t: string, u: string, d: string, p: boolean, r?: string) => void;
}> = ({ payload, email, login }) => {
    useEffect(() => {
        markLocalHistory(payload.userId);
        const t = setTimeout(() => {
            login(payload.token, payload.userId, payload.deviceId, false, payload.refresh_token);
        }, 1600);
        return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <Shell>
            <div className="text-center auth-returning-enter" style={{ padding: '12px 0 8px' }}>
                <div
                    className="auth-returning-check"
                    style={{
                        width: 64, height: 64, borderRadius: 20,
                        background: 'rgba(37,224,200,0.12)',
                        border: '1.5px solid rgba(37,224,200,0.28)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        margin: '0 auto 20px',
                    }}
                >
                    <CheckCircle2 style={{ width: 32, height: 32, color: 'var(--cl-lume)' }} />
                </div>
                <h2 style={{ fontSize: 22, fontWeight: 800, color: 'var(--cl-text)', marginBottom: 6 }}>
                    Welcome back!
                </h2>
                {email && (
                    <p style={{ fontSize: 13, color: 'var(--cl-faint)', marginBottom: 0 }}>{email}</p>
                )}
                <p style={{ fontSize: 12, color: 'var(--cl-faint)', opacity: 0.55, marginTop: 20 }}>
                    Taking you in…
                </p>
            </div>
        </Shell>
    );
};

/** A quick confetti burst from (x,y) using the kit's `.cl-conf` particles —
 *  light = commitment, fired when an account is created. Reduced-motion skips it. */
function authConfetti(x: number, y: number) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['var(--cl-lume)', 'var(--cl-flash)', 'var(--cl-glow)', 'var(--cl-ok)'];
    for (let i = 0; i < 22; i++) {
        const s = document.createElement('span');
        s.className = 'cl-conf';
        s.style.cssText = `position:fixed;z-index:999;left:${x}px;top:${y}px;background:${colors[i % colors.length]}`;
        const ang = (Math.PI * 2 * i) / 22 + Math.random() * 0.4;
        const dist = 60 + Math.random() * 95;
        s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
        s.style.setProperty('--dy', `${Math.sin(ang) * dist - 30}px`);
        s.style.setProperty('--rot', `${Math.random() * 600 - 300}deg`);
        document.body.appendChild(s);
        setTimeout(() => s.remove(), 850);
    }
}


const LEGAL_TERMS_URL = 'https://cipherline.chat/terms';
const LEGAL_PRIVACY_URL = 'https://cipherline.chat/privacy';

/** A real link (keyboard-focusable, right-click copies the address) that opens in
 *  the system browser via the validated openExternalLink path, never in-app. */
const LegalLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
    <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => { e.preventDefault(); openExternalLink(href); }}
        className="text-cl-text font-semibold underline decoration-dotted underline-offset-2 hover:text-cl-lume transition-colors"
    >
        {children}
    </a>
);

const AuthScreen: React.FC = () => {
    const { login, logoutReason, clearLogoutReason } = useAuth();
    const [view, setView] = useState<View>(() => (!logoutReason && getPendingReferral() ? 'register' : 'login'));
    // Which panel the 'login' view shows — password form, or QR sign-in
    // (docs/QR-LINKING.md §2/§7). QrSignInPanel owns its own session/poll
    // lifecycle entirely; this is only which one is on screen.
    const [loginMode, setLoginMode] = useState<'password' | 'qr'>('password');

    // Shared form fields
    const [email, setEmail]                   = useState('');
    const [password, setPassword]             = useState('');
    // A referral carried in from a link (deep link, first-launch clipboard offer,
    // or a code remembered across an app restart mid-signup) is applied from the
    // first render — the person never has to retype it. See utils/signupAttribution.
    const [carriedReferral] = useState(() => getPendingReferral());
    const [referralCode, setReferralCode]     = useState(carriedReferral ?? '');
    const [referralFromLink, setReferralFromLink] = useState(!!carriedReferral);
    const [referralValidity, setReferralValidity] = useState<boolean | null>(null);
    // Who the applied code belongs to (null until it resolves, or on an old API
    // that can only say valid/invalid). Feeds the post-signup friend-request offer.
    const [referrer, setReferrer] = useState<ReferrerTag | null>(null);
    // The first-launch "use the link on your clipboard?" offer (see peekClipboardOnce).
    const [clipboardOffer, setClipboardOffer] = useState<ParsedAttribution | null>(null);
    // A server invite is being carried through signup (App shows the join prompt
    // once the account is ready). Only used to tell the person it is coming.
    const [carriedInvite, setCarriedInvite] = useState(() => !!getPendingInvite());
    useEffect(() => onPendingInviteChange(() => setCarriedInvite(!!getPendingInvite())), []);
    const [confirmPassword, setConfirmPassword] = useState('');
    const [dob, setDob]                       = useState('');
    const [showPassword, setShowPassword]     = useState(false);
    const [tosAccepted, setTosAccepted]       = useState(false);
    const [code, setCode]                     = useState('');
    const [newPassword, setNewPassword]       = useState('');

    // Login 2FA
    const [pending2faToken, setPending2faToken] = useState<string | null>(null);
    const [twoFactorMethod, setTwoFactorMethod] = useState<'email' | 'totp'>('email');
    const [usingBackupCode, setUsingBackupCode] = useState(false);
    const [resendCountdown, setResendCountdown] = useState(0);

    // Password reset multi-step state
    const [resetStep, setResetStep]           = useState<'code' | '2fa' | 'password'>('code');
    const [resetToken, setResetToken]         = useState<string | null>(null);
    const [resetRequires2fa, setResetRequires2fa] = useState(false);
    const [reset2faMode, setReset2faMode]     = useState<'totp' | 'backup'>('totp');
    const [reset2faCode, setReset2faCode]     = useState('');
    const [resetLogoutOthers, setResetLogoutOthers] = useState(true);

    // Verify-email
    const [verifyEmail, setVerifyEmail] = useState('');

    // Wrong-code feedback: flash the slots red, then clear the field after a beat
    // so the user can retype without manually deleting six digits.
    const [codeError, setCodeError] = useState(false);
    const codeClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Verification creates the account (POST /auth/finalize runs in
    // submitVerifyEmailCode) and signs straight in; the first-run setup then
    // runs over the Dashboard (components/onboarding/). `verifyExiting` plays
    // the verify card's exit before that hand-off.
    const [verifyExiting, setVerifyExiting] = useState(false);
    const [pendingRegPayload, setPendingRegPayload] = useState<{
        token: string; userId: string; deviceId: string;
        requiresPairing: boolean; refresh_token?: string;
    } | null>(null);

    // Restore backup
    const [restoreFile, setRestoreFile]       = useState<File | null>(null);
    const [restorePassword, setRestorePassword] = useState('');
    const [restoreBackupOrigin, setRestoreBackupOrigin] = useState<View>('device-not-approved');
    const [restoring, setRestoring]           = useState(false);

    const [loading, setLoading]               = useState(false);
    const [error, setError]                   = useState('');
    const [info,  setInfo]                    = useState(logoutReason ?? '');

    // Cloudflare Turnstile — only active when VITE_TURNSTILE_SITE_KEY is set.
    const TURNSTILE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || '';
    const [regTurnstileToken,    setRegTurnstileToken]    = useState('');
    const [forgotTurnstileToken, setForgotTurnstileToken] = useState('');
    const regTurnstileRef    = useRef<any>(null);
    const forgotTurnstileRef = useRef<any>(null);
    // Set when the Turnstile widget itself errors/expires (CDN blocked, ad-blocker,
    // flaky net). Without surfacing this, the widget just clears its token and the
    // primary CTA goes silently grey — a dead-end at the last step of signup. Only
    // one flow's widget is mounted at a time (register XOR forgot), so one shared
    // state is enough. Cleared on a successful challenge.
    const [turnstileError, setTurnstileError] = useState('');

    // Brief card shake whenever an error appears (wrong creds / failed validation).
    const [shake, setShake] = useState(false);
    useEffect(() => {
        if (!error) { setShake(false); return; }
        setShake(false);
        const r = requestAnimationFrame(() => setShake(true));   // force re-trigger
        const t = setTimeout(() => setShake(false), 520);
        return () => { cancelAnimationFrame(r); clearTimeout(t); };
    }, [error]);

    // Loaded on first need (see utils/passwordStrength) — not at app boot.
    const zxcvbn = useZxcvbn(!!password || !!newPassword);
    const strengthScore = password && zxcvbn ? zxcvbn(password).score : -1;

    // Resend countdown tick
    useEffect(() => {
        if (resendCountdown <= 0) return;
        const t = setTimeout(() => setResendCountdown(c => Math.max(0, c - 1)), 1000);
        return () => clearTimeout(t);
    }, [resendCountdown]);

    // Referral deep-link: cipherline://ref/CODE — sent by the landing page redirect
    // or when the user opens a referral link while the app is already running.
    useEffect(() => {
        const applyRef = (code: string) => {
            const upper = code.toUpperCase();
            // Remember it so it survives the verify-email step and an app restart.
            // (An invalid string is refused by setPendingReferral and the field's own
            // live check then reports it, exactly as before.)
            setPendingReferral(upper);
            setReferralCode(upper);
            setReferralFromLink(true);
            // If on login view, switch to register so the field is visible.
            setView(v => v === 'login' ? 'register' : v);
        };
        const cleanup = (window as any).electronAPI?.onDeepLinkRef?.((code: string) => applyRef(code));
        (window as any).electronAPI?.getPendingDeepLinkRef?.().then((code: string | null) => {
            if (code) applyRef(code);
        });
        return () => { cleanup?.(); };
    }, []);

    // First launch only: did the landing page copy a link for us? (Visitors who
    // did not have Cipherline installed click "Get Cipherline", which copies the
    // referral / invite link.) Checked once per install, and only offered when no
    // referral is already applied; the person decides whether to use it.
    useEffect(() => {
        if (carriedReferral) return;
        let alive = true;
        void peekClipboardOnce().then(found => { if (alive && found) setClipboardOffer(found); });
        return () => { alive = false; };
    }, [carriedReferral]);

    const acceptClipboardOffer = () => {
        const found = clipboardOffer;
        setClipboardOffer(null);
        if (!found) return;
        if (found.kind === 'ref') {
            setPendingReferral(found.code);
            setReferralCode(found.code);
            setReferralFromLink(true);
            setView(v => v === 'login' ? 'register' : v);
        } else {
            // The join prompt appears after signup (App reads the pending invite).
            setPendingInvite(found.code);
        }
    };

    const removeReferral = () => {
        clearPendingReferral();
        setReferralCode('');
        setReferralFromLink(false);
        setReferralValidity(null);
        setReferrer(null);
    };

    /* ─────────────────────────────────────────
       Helpers
    ───────────────────────────────────────── */
    const reset = () => {
        setError(''); setInfo(''); setLoading(false);
        clearLogoutReason();
        setCode(''); setNewPassword(''); setConfirmPassword(''); setUsingBackupCode(false);
        setCodeError(false);
        setResetStep('code'); setResetToken(null); setResetRequires2fa(false);
        setReset2faMode('totp'); setReset2faCode('');
        if (codeClearTimer.current) { clearTimeout(codeClearTimer.current); codeClearTimer.current = null; }
    };

    const switchView = (v: View) => { reset(); setView(v); };

    /**
     * Show a "that code was wrong" state: set the error message, flash the code
     * slots red, then clear the field after ~1s so the user can retype cleanly.
     * Used by every one-time-code verify path (email verify, 2FA, password reset).
     */
    const flashWrongCode = (msg: string) => {
        setError(msg);
        setCodeError(true);
        if (codeClearTimer.current) clearTimeout(codeClearTimer.current);
        codeClearTimer.current = setTimeout(() => {
            setCode('');
            setCodeError(false);
            codeClearTimer.current = null;
        }, 1000);
    };

    /**
     * Terminal point for existing-account logins (V1 direct + 2FA).
     * Branches to a "Welcome back" animation if this device already has
     * history for the account, otherwise offers three history-restore paths.
     */
    const finishExistingAccountLogin = async (
        token: string,
        userId: string,
        deviceId: string,
        refreshToken?: string,
    ) => {
        setPendingRegPayload({ token, userId, deviceId, requiresPairing: false, refresh_token: refreshToken });
        // Signing in to an EXISTING account means any carried referral was never going
        // to be used; drop it so it cannot resurface on a later signup.
        clearPendingReferral();
        // Async on purpose — see probeLocalHistory. Deciding this synchronously
        // read a namespace that is not in memory yet and mistook it for empty.
        const probe = await probeLocalHistory(userId);
        setView(probe === 'has' ? 'login-returning'
            : probe === 'none' ? 'history-options'
            : 'history-unreadable');
    };

    /** Re-run the probe from the `history-unreadable` screen. */
    const retryHistoryProbe = async () => {
        if (!pendingRegPayload) return;
        setError(''); setLoading(true);
        try {
            const probe = await probeLocalHistory(pendingRegPayload.userId);
            setView(probe === 'has' ? 'login-returning'
                : probe === 'none' ? 'history-options'
                : 'history-unreadable');
            if (probe === 'unreadable') setError('Still unable to read local data on this device.');
        } finally {
            setLoading(false);
        }
    };

    /* ─────────────────────────────────────────
       Login flow — step 1: email + password
    ───────────────────────────────────────── */
    const handleLoginSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(''); setInfo('');
        if (!email || !password) return setError('Please fill in all fields.');
        setLoading(true);
        try {
            const deviceName = (await window.electronAPI?.getDeviceName?.())?.trim() || undefined;
            const res = await axios.post(`${API_BASE}/auth/login`, { email: email.trim().toLowerCase(), password, device_name: deviceName });
            const data = res.data;
            // Unverified email path — the API has already re-sent a verification code
            if (data.status === 'verification_required') {
                setVerifyEmail(email.trim().toLowerCase());
                setInfo('Please verify your email — we sent a fresh code.');
                switchView('verify-email');
                return;
            }
            if (data.status === 'two_factor_required') {
                setPending2faToken(data.pending_2fa_token);
                setTwoFactorMethod(data.two_factor_method || 'email');
                setResendCountdown(data.two_factor_method === 'email' ? 60 : 0);
                switchView('login-2fa');
                return;
            }
            // V1 migration path: server skipped 2FA and issued tokens directly.
            if (data.status === 'ok' && data.access_token) {
                const { user_id, access_token, refresh_token } = data;
                const { deviceId, requiresPairing } = await registerOrReuseDevice(user_id, access_token, email || 'user');
                if (requiresPairing) {
                    setPendingRegPayload({ token: access_token, userId: user_id, deviceId, requiresPairing: true, refresh_token });
                    switchView('device-not-approved');
                    return;
                }
                await finishExistingAccountLogin(access_token, user_id, deviceId, refresh_token);
                return;
            }
            setError('Unexpected response from server.');
        } catch (err: any) {
            setError(
                axios.isAxiosError(err) && !err.response
                    ? "Can't reach Cipherline — check your connection and try again."
                    : err?.response?.data?.message || 'Sign in failed.',
            );
        } finally {
            setLoading(false);
        }
    };

    /* ─────────────────────────────────────────
       Login flow — step 2: 2FA verification
    ───────────────────────────────────────── */
    /** Core verify logic — called from the form handler and from clipboard auto-submit. */
    const submitVerify2faCode = async (autoCode: string) => {
        setError(''); setInfo('');
        if (!pending2faToken) return setError('Session expired. Please sign in again.');
        setLoading(true);
        try {
            const deviceName = (await window.electronAPI?.getDeviceName?.())?.trim() || undefined;
            const res = await axios.post(`${API_BASE}/auth/2fa/verify`, {
                pending_2fa_token: pending2faToken,
                code: autoCode,
                is_backup_code: usingBackupCode,
                device_name: deviceName,
            });
            const { user_id, access_token, refresh_token } = res.data;
            const { deviceId, requiresPairing } = await registerOrReuseDevice(user_id, access_token, 'user');
            if (requiresPairing) {
                setPendingRegPayload({ token: access_token, userId: user_id, deviceId, requiresPairing: true, refresh_token });
                switchView('device-not-approved');
                return;
            }
            await finishExistingAccountLogin(access_token, user_id, deviceId, refresh_token);
        } catch (err: any) {
            flashWrongCode(err?.response?.data?.message || 'Code is invalid or expired.');
        } finally {
            setLoading(false);
        }
    };

    const handleVerify2fa = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!code || code.length < 6) return setError('Enter your code.');
        await submitVerify2faCode(code);
    };

    const handleResend2faEmail = async () => {
        if (!pending2faToken || resendCountdown > 0) return;
        setError(''); setInfo('');
        try {
            await axios.post(`${API_BASE}/auth/2fa/send-email-code`, { pending_2fa_token: pending2faToken });
            setInfo('Code re-sent. Check your inbox.');
            setResendCountdown(60);
        } catch (err: any) {
            setError(err?.response?.data?.message || 'Could not resend code.');
        }
    };

    /* ─────────────────────────────────────────
       Register flow — step 1: collect fields → POST /register
    ───────────────────────────────────────── */
    const handleRegisterSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(''); setInfo('');
        // No username here any more: it is picked on the onboarding profile
        // step, after the account exists (PATCH /auth/profile).
        if (!email || !password || !confirmPassword || !dob) {
            return setError('Please fill in all fields.');
        }
        if (!tosAccepted) return setError('Please accept the Terms of Service to continue.');
        if (password !== confirmPassword) return setError('Passwords do not match.');
        if (referralCode.trim() && referralValidity !== true) {
            return setError(referralValidity === false
                ? 'That referral code isn\'t valid — remove it or fix it to continue.'
                : 'Still checking your referral code — wait a moment and try again.');
        }
        let pwCheck: ReturnType<Awaited<ReturnType<typeof loadZxcvbn>>>;
        try { pwCheck = (await loadZxcvbn())(password); } catch { return setError('Could not check password strength — try again.'); }
        if (pwCheck.score < 3) {
            const fb = pwCheck.feedback.warning;
            return setError(`Password too weak. ${fb || 'Use a stronger password.'}`);
        }
        setLoading(true);
        try {
            // Anti-abuse proof-of-work. Fetch a challenge; if the server has it
            // enabled (difficulty>0) solve it in the Electron main process before
            // registering. Disabled (difficulty 0) or any error → register as
            // before; the server is the authority and re-checks.
            let powFields: { challenge_token?: string; pow_solution?: string } = {};
            try {
                const ch = await axios.get(`${API_BASE}/auth/register-challenge`);
                const difficulty: number = ch.data?.difficulty ?? 0;
                const token: string | undefined = ch.data?.challenge_token;
                if (difficulty > 0 && token && window.electronAPI?.solvePow) {
                    const nonce = await window.electronAPI.solvePow(token, difficulty);
                    if (nonce) powFields = { challenge_token: token, pow_solution: nonce };
                }
            } catch { /* challenge unavailable — let the server decide */ }

            await axios.post(`${API_BASE}/auth/register`, {
                email: email.trim().toLowerCase(),
                password,
                dob,
                ...powFields,
                ...(TURNSTILE_KEY && regTurnstileToken ? { turnstile_token: regTurnstileToken } : {}),
            });
            // Account created — celebrate from roughly where the button sits.
            authConfetti(window.innerWidth / 2, window.innerHeight * 0.6);
            setVerifyEmail(email.trim().toLowerCase());
            setInfo('Check your email for a 6-digit code.');
            switchView('verify-email');
            setResendCountdown(60);
        } catch (err: any) {
            regTurnstileRef.current?.reset();
            setRegTurnstileToken('');
            setError(
                axios.isAxiosError(err) && !err.response
                    ? "Can't reach Cipherline — check your connection and try again."
                    : err?.response?.data?.message || 'Registration failed.',
            );
        } finally {
            setLoading(false);
        }
    };

    /* ─────────────────────────────────────────
       Register flow — step 2: verify email → tokens
    ───────────────────────────────────────── */
    /** Core verify logic — called from the form handler and from clipboard auto-submit. */
    const submitVerifyEmailCode = async (autoCode: string) => {
        setError(''); setInfo(''); setVerifyExiting(false);
        setLoading(true);
        try {
            const res = await axios.post(`${API_BASE}/auth/verify-email`, { email: verifyEmail, code: autoCode });
            const { finalize_token } = res.data;

            // TOS was accepted on the register form — finalize (create) the
            // account now. No username: the server gives it a temporary one
            // and flags it `username_pending` until the profile step picks
            // the real one.
            const finRes = await axios.post(`${API_BASE}/auth/finalize`, {
                finalize_token,
                tos_accepted: true,
                ...(referralCode.trim() ? { referral_code: referralCode.trim().toUpperCase() } : {}),
            });
            const { user_id, access_token, refresh_token, referral_applied, trial_granted, bonus_days } = finRes.data;
            // The code has been used — one-shot. (A pending SERVER invite is NOT
            // cleared here: it is carried until the person answers the join prompt.)
            clearPendingReferral();
            if (referral_applied && referrer) rememberReferrer(user_id, referrer);
            const { deviceId, requiresPairing } = await registerOrReuseDevice(user_id, access_token, 'user');

            // Open the first-run setup for this account on this device. It runs
            // after sign-in, over the Dashboard, and resumes from this marker if
            // the app is closed part-way (utils/onboardingProgress.ts).
            // trial_granted is a real boolean on every /auth/finalize response —
            // read defensively anyway so an older API build degrades to "say
            // nothing" rather than to "claim withheld".
            startOnboarding(user_id, {
                trialGranted: typeof trial_granted === 'boolean' ? trial_granted : undefined,
                referralApplied: !!referral_applied,
                bonusDays: typeof bonus_days === 'number' ? bonus_days : undefined,
                ...(referral_applied ? { referralCode: referralCode.trim().toUpperCase() } : {}),
            });
            // The "Finish setting up" checklist is for freshly-onboarded accounts.
            try { secureLocalStore.setItem(`cipherline_onboarded_v2_${user_id}`, '1'); } catch { /* checklist just stays hidden */ }
            markLocalHistory(user_id);

            setLoading(false);
            // Let the verify card drift away on the shared field, then sign in:
            // the Dashboard mounts with the setup already up over it.
            setVerifyExiting(true);
            await new Promise<void>(r => setTimeout(r, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420));
            await login(access_token, user_id, deviceId, requiresPairing, refresh_token);
            return;
        } catch (err: any) {
            setVerifyExiting(false);
            flashWrongCode(err?.response?.data?.message || 'Verification failed.');
        }
        setLoading(false);
    };

    const handleVerifyEmail = async (e: React.FormEvent) => {
        e.preventDefault();
        if (code.length < 6) return setError('Enter the 6-digit code from your email.');
        await submitVerifyEmailCode(code);
    };

    const handleResendVerifyEmail = async () => {
        if (resendCountdown > 0) return;
        setError(''); setInfo('');
        try {
            await axios.post(`${API_BASE}/auth/resend-verification-email`, { email: verifyEmail });
            setInfo('Code re-sent. Check your inbox.');
            setResendCountdown(60);
        } catch (err: any) {
            setError(err?.response?.data?.message || 'Could not resend code.');
        }
    };

    /* ─────────────────────────────────────────
       Forgot password flow
    ───────────────────────────────────────── */
    const handleForgotSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(''); setInfo('');
        if (!email) return setError('Enter your email.');
        setLoading(true);
        try {
            await axios.post(`${API_BASE}/auth/forgot-password`, {
                email: email.trim().toLowerCase(),
                ...(TURNSTILE_KEY && forgotTurnstileToken ? { turnstile_token: forgotTurnstileToken } : {}),
            });
            setInfo('If that email is on file, a reset code has been sent.');
            switchView('reset-password');
            setResendCountdown(60);
        } catch (err: any) {
            forgotTurnstileRef.current?.reset();
            setForgotTurnstileToken('');
            setError(
                axios.isAxiosError(err) && !err.response
                    ? "Can't reach Cipherline — check your connection and try again."
                    : err?.response?.data?.message || 'Could not send reset email.',
            );
        } finally {
            setLoading(false);
        }
    };

    // Step 1: verify email OTP → get reset_token and learn if 2FA required
    const submitResetEmailCode = async (autoCode: string) => {
        setError(''); setInfo('');
        if (autoCode.length < 6) return;
        setLoading(true);
        try {
            const res = await axios.post(`${API_BASE}/auth/verify-reset-code`, {
                email: email.trim().toLowerCase(),
                code: autoCode,
            });
            setResetToken(res.data.reset_token);
            setResetRequires2fa(res.data.requires_2fa === true);
            setCode(''); setCodeError(false);
            setResetStep(res.data.requires_2fa ? '2fa' : 'password');
        } catch (err: any) {
            flashWrongCode(err?.response?.data?.message || 'Invalid or expired code.');
        } finally {
            setLoading(false);
        }
    };

    const handleResetCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (code.length < 6) return setError('Enter the 6-digit code from your email.');
        await submitResetEmailCode(code);
    };

    // Step 2 (if 2FA required): validate the TOTP/backup code against the server,
    // get an upgraded reset_token, then advance to the password step.
    const handleReset2faNext = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        const ready = reset2faMode === 'backup' ? reset2faCode.trim().length >= 6 : reset2faCode.length === 6;
        if (!ready) return setError(reset2faMode === 'backup' ? 'Enter your backup code.' : 'Enter the 6-digit code from your authenticator app.');
        if (!resetToken) return setError('Session expired — start over.');
        setLoading(true);
        try {
            const body: Record<string, string> = { reset_token: resetToken };
            if (reset2faMode === 'totp') body.totp_code = reset2faCode;
            else body.backup_code = reset2faCode.trim();
            const res = await axios.post(`${API_BASE}/auth/verify-reset-2fa`, body);
            setResetToken(res.data.reset_token);
            setResetStep('password');
        } catch (err: any) {
            setError(err?.response?.data?.message || 'Invalid code. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    // Step 3: set the new password using the (2FA-upgraded) reset_token.
    const handleResetPasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (newPassword.length < 8) return setError('New password is too short.');
        let resetScore: number;
        try { resetScore = (await loadZxcvbn())(newPassword).score; } catch { return setError('Could not check password strength — try again.'); }
        if (resetScore < 3) return setError('New password is too weak.');
        if (newPassword !== confirmPassword) return setError('Passwords do not match.');
        if (!resetToken) return setError('Session expired — start over.');
        setLoading(true);
        try {
            const body: Record<string, string | boolean> = {
                reset_token: resetToken,
                new_password: newPassword,
                logout_other_devices: resetLogoutOthers,
            };
            if (resetRequires2fa) {
                if (reset2faMode === 'totp') body.totp_code = reset2faCode;
                else body.backup_code = reset2faCode.trim();
            }
            await axios.post(`${API_BASE}/auth/reset-password`, body);
            setInfo('Password reset. Please sign in with your new password.');
            setPassword(''); setNewPassword('');
            switchView('login');
        } catch (err: any) {
            const msg = err?.response?.data?.message || 'Reset failed.';
            // If the 2FA code was wrong, go back and re-enter it
            if (/two-factor|invalid two|backup/i.test(msg) && resetRequires2fa) {
                setReset2faCode(''); setResetStep('2fa');
            }
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    /* ─────────────────────────────────────────
       Restore backup (device-not-approved path)
    ───────────────────────────────────────── */
    const handleRestoreBackup = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!restoreFile || !restorePassword || !pendingRegPayload) return;
        setRestoring(true); setError('');
        try {
            // Format-aware open — the SAME reader the Settings restore uses.
            // This used to call decryptBackup + JSON.parse directly, which
            // understands only the legacy v1/v2 layouts; every backup the
            // current app writes is a v3 container, so it always failed here
            // with a misleading "wrong password" while the identical file
            // restored fine from Settings.
            let backup: OpenedBackupFile;
            try {
                // Lazy: keeps the backup/container reader out of the pre-login
                // bundle — this is the only pre-login path that needs it.
                const { openBackupFile } = await import('../services/driveBackup');
                backup = await openBackupFile(restoreFile, restorePassword);
            } catch (err: unknown) {
                // A wrong passphrase and a corrupt file both surface as an
                // AES-GCM auth-tag failure, so those keep the generic message;
                // anything the reader explains for itself is shown verbatim.
                const msg = errText(err);
                setError(msg && !/decrypt|cipher|auth|tag|operation failed/i.test(msg)
                    ? msg
                    : 'Decryption failed. Incorrect password or corrupted file.');
                return;
            }
            if (!backup.userId) {
                setError('This backup is missing account information — it can’t be restored.');
                return;
            }
            // Account binding: this restore is unlocking THIS account on this
            // device — the backup must belong to it, not some other account.
            if (backup.userId !== pendingRegPayload.userId) {
                setError('This backup belongs to a different account — sign in to that account to restore it.');
                return;
            }
            await axios.post(`${API_BASE}/devices/${pendingRegPayload.deviceId}/bypass-approval`, {},
                { headers: { Authorization: `Bearer ${pendingRegPayload.token}` } });
            // Bind the account first: per-account keys written before the store
            // knows the active user are filed master-tier (readable by every
            // account on the device, and invisible to the account's own rebind).
            secureLocalStore.setItem('cipherline_user_id', backup.userId);
            await secureLocalStore.whenAccountReady();
            // This device keeps its OWN keypair. The backup's (older vaults
            // carried the exporting device's `cipherline_private_key` pair) is
            // never installed here — that copied one device's key material onto
            // another, against the multi-device rule. It was never what
            // unlocked the account either: the device registered on its own
            // identity proof before this screen, and login() below mints this
            // device's pair if it has none.
            // History, topics, channel messages, GIFs, attachments, avatar keys
            // and every registry-included setting are applied by the shared
            // restore code. The hand-maintained subset that used to live here
            // had already drifted away from it.
            await backup.apply(pendingRegPayload.userId);
            markLocalHistory(pendingRegPayload.userId);
            login(pendingRegPayload.token, pendingRegPayload.userId, pendingRegPayload.deviceId, false, pendingRegPayload.refresh_token);
        } catch (err: unknown) {
            setError(errText(err) || 'Restore failed.');
        } finally {
            setRestoring(false);
        }
    };

    /* ─────────────────────────────────────────
       Render: Device-not-approved + Restore-backup
    ───────────────────────────────────────── */
    if (view === 'device-not-approved' && pendingRegPayload) {
        return (
            <Shell>
                <div className="text-center mb-7">
                    <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                        <ShieldCheck className="w-7 h-7 text-cl-lume" />
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">Device Not Approved</h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        Another active device must approve this login to sync your history.
                    </p>
                </div>
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                <div className="flex flex-col gap-3">
                    <ClButton fullWidth onClick={() => switchView('restore-backup')}>Restore Local Backup</ClButton>
                    <ClButton
                        fullWidth
                        variant="ghost"
                        onClick={async () => {
                            try {
                                await axios.post(`${API_BASE}/devices/${pendingRegPayload.deviceId}/bypass-approval`, {},
                                    { headers: { Authorization: `Bearer ${pendingRegPayload.token}` } });
                                markLocalHistory(pendingRegPayload.userId);
                                login(pendingRegPayload.token, pendingRegPayload.userId, pendingRegPayload.deviceId, false, pendingRegPayload.refresh_token);
                            } catch (err: any) {
                                setError(err?.response?.data?.message || 'Failed to bypass approval');
                            }
                        }}
                    >
                        Start Fresh (No History)
                    </ClButton>
                    <ClButton variant="ghost" fullWidth onClick={() => { setView('login'); setPendingRegPayload(null); reset(); }}>
                        ← Back to Sign In
                    </ClButton>
                </div>
            </Shell>
        );
    }

    if (view === 'restore-backup' && pendingRegPayload) {
        return (
            <Shell>
                <div className="text-center mb-7">
                    <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                        <Upload className="w-7 h-7 text-cl-lume" />
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">Restore Local Backup</h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        Select your <code className="bg-black/40 px-1.5 py-0.5 rounded text-xs">.enc</code> backup file and enter its password.
                    </p>
                </div>
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                <form onSubmit={handleRestoreBackup} className="flex flex-col gap-3">
                    <input
                        type="file" accept=".enc"
                        onChange={e => setRestoreFile(e.target.files?.[0] || null)} required
                        className="text-sm rounded-xl px-4 py-2.5 cursor-pointer file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium"
                        style={{ background: 'var(--cl-surface)', border: '1.5px solid var(--cl-border)', color: 'var(--cl-faint)', '--file-bg': 'rgba(37,224,200,.15)', '--file-color': 'var(--cl-lume)' } as React.CSSProperties}
                    />
                    <Field icon={<Lock size={15} />} type="password" placeholder="Backup Password" value={restorePassword} onChange={setRestorePassword} disabled={restoring} />
                    <ClButton type="submit" fullWidth disabled={restoring || !restoreFile || !restorePassword} loading={restoring}>
                        {restoring ? 'Decrypting…' : 'Restore Account'}
                    </ClButton>
                    <ClButton type="button" fullWidth variant="ghost" onClick={() => switchView(restoreBackupOrigin)} disabled={restoring}>Cancel</ClButton>
                </form>
            </Shell>
        );
    }

    /* ─────────────────────────────────────────
       Render: Returning user — "Welcome back"
    ───────────────────────────────────────── */
    if (view === 'login-returning' && pendingRegPayload) {
        return (
            <ReturningShell
                payload={pendingRegPayload}
                email={email}
                login={login}
            />
        );
    }

    /* ─────────────────────────────────────────
       Render: History options
    ───────────────────────────────────────── */
    /**
     * "We could not READ your local data" — deliberately NOT the same screen as
     * "you have no local data".
     *
     * The history-options screen below offers a restore-from-backup, which
     * writes an older vault over whatever is on this device. That offer is only
     * safe when we actually established that there is nothing here. When the
     * probe could not establish anything, the honest answer is that we don't
     * know — so this screen offers only retry and continue, and never anything
     * destructive. Continuing touches no local data: `login()` binds the
     * account, and the Dashboard reads whatever is really there.
     */
    if (view === 'history-unreadable' && pendingRegPayload) {
        return (
            <Shell>
                <div className="text-center mb-7">
                    <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                        <HardDrive className="w-7 h-7 text-cl-lume" />
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">Couldn’t read local data</h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        We couldn’t check what’s stored on this device, so we don’t know whether your
                        history is here. Nothing has been changed or deleted.
                    </p>
                </div>
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                <div className="flex flex-col gap-2">
                    <ClButton onClick={retryHistoryProbe} disabled={loading} className="w-full">
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Try again'}
                    </ClButton>
                    <button
                        onClick={() => {
                            // No markLocalHistory() here: we never established
                            // that this device holds history, so claiming it
                            // does would be inventing the state we failed to read.
                            login(pendingRegPayload.token, pendingRegPayload.userId, pendingRegPayload.deviceId, false, pendingRegPayload.refresh_token);
                        }}
                        disabled={loading}
                        className="w-full text-left rounded-2xl border border-cl-border bg-cl-surface hover:bg-cl-raise transition-colors p-4 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/50 disabled:opacity-50"
                    >
                        <div className="flex items-center gap-3">
                            <Monitor className="w-5 h-5 text-cl-lume flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold text-cl-text">Continue to Cipherline</div>
                                <div className="text-xs text-cl-faint mt-0.5">Sign in and leave everything on this device as it is</div>
                            </div>
                            <ChevronRight className="w-4 h-4 text-cl-faint flex-shrink-0" />
                        </div>
                    </button>
                </div>
            </Shell>
        );
    }

    if (view === 'history-options' && pendingRegPayload) {
        const goToRestore = () => { setRestoreBackupOrigin('history-options'); switchView('restore-backup'); };
        return (
            <Shell>
                <div className="text-center mb-7">
                    <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                        <HardDrive className="w-7 h-7 text-cl-lume" />
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">No history on this device</h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        How would you like to continue?
                    </p>
                </div>
                {info && <div className="mb-4"><InfoBanner msg={info} /></div>}
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                <div className="flex flex-col gap-2">
                    <button
                        onClick={() => {
                            // Hardening follow-up (device-sync audit): this used to
                            // just show static instructions pointing at a "Settings →
                            // Storage → Export History" feature that doesn't exist
                            // anywhere in the app — a confirmed dead end. The REAL,
                            // working "sync from another device" flow
                            // (HistorySyncBanner.tsx, POST /v1/devices/history-request
                            // over the live WS connection) can only run once this
                            // device is actually logged in and connected — it can't
                            // run from this pre-login screen. Proceed to login exactly
                            // like "Start fresh" does; HistorySyncBanner detects the
                            // empty local history on Dashboard mount and offers the
                            // real sync flow automatically from there.
                            markLocalHistory(pendingRegPayload.userId);
                            login(pendingRegPayload.token, pendingRegPayload.userId, pendingRegPayload.deviceId, false, pendingRegPayload.refresh_token);
                        }}
                        className="w-full text-left rounded-2xl border border-cl-border bg-cl-surface hover:bg-cl-raise transition-colors p-4 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/50"
                    >
                        <div className="flex items-center gap-3">
                            <Monitor className="w-5 h-5 text-cl-lume flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold text-cl-text">Sync from existing device</div>
                                <div className="text-xs text-cl-faint mt-0.5">Continue, then choose a device to sync from once you're in</div>
                            </div>
                            <ChevronRight className="w-4 h-4 text-cl-faint flex-shrink-0" />
                        </div>
                    </button>
                    <button
                        onClick={goToRestore}
                        className="w-full text-left rounded-2xl border border-cl-border bg-cl-surface hover:bg-cl-raise transition-colors p-4 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/50"
                    >
                        <div className="flex items-center gap-3">
                            <Upload className="w-5 h-5 text-cl-lume flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold text-cl-text">Restore from backup file</div>
                                <div className="text-xs text-cl-faint mt-0.5">Decrypt a .enc backup you exported previously</div>
                            </div>
                            <ChevronRight className="w-4 h-4 text-cl-faint flex-shrink-0" />
                        </div>
                    </button>
                    <button
                        onClick={() => {
                            markLocalHistory(pendingRegPayload.userId);
                            login(pendingRegPayload.token, pendingRegPayload.userId, pendingRegPayload.deviceId, false, pendingRegPayload.refresh_token);
                        }}
                        className="w-full text-left rounded-2xl border border-cl-border bg-cl-surface hover:bg-cl-raise transition-colors p-4 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/50"
                    >
                        <div className="flex items-center gap-3">
                            <Sparkles className="w-5 h-5 text-cl-lume flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold text-cl-text">Start fresh</div>
                                <div className="text-xs text-cl-faint mt-0.5">Jump straight in — no history restored</div>
                            </div>
                            <ChevronRight className="w-4 h-4 text-cl-faint flex-shrink-0" />
                        </div>
                    </button>
                </div>
            </Shell>
        );
    }

    /* ─────────────────────────────────────────
       Render: Verify email (post-register)
    ───────────────────────────────────────── */
    if (view === 'verify-email') {
        return (
            <>
            <Shell>
                {/* Fades out as the first-run setup takes over — the backdrop's dots
                    keep drifting underneath, so the handoff reads as one continuous scene. */}
                <div
                    style={{
                        opacity: verifyExiting ? 0 : 1,
                        transform: verifyExiting ? 'translateY(-16px) scale(0.96)' : 'none',
                        filter: verifyExiting ? 'blur(6px)' : 'none',
                        pointerEvents: verifyExiting ? 'none' : 'auto',
                        // A touch longer + softer so the prompt has time to fully drift
                        // away before the cutscene surface settles in over it.
                        transition: 'opacity .55s ease, transform .6s cubic-bezier(.4,0,.2,1), filter .55s ease',
                    }}
                >
                    <div className="text-center mb-6">
                        <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                            <Mail className="w-7 h-7 text-cl-lume" />
                        </div>
                        <h2 className="text-xl font-bold text-cl-text mb-1">Verify your email</h2>
                        <p className="text-cl-faint text-sm leading-relaxed">
                            We sent a 6-digit code to <span className="text-cl-muted">{verifyEmail}</span>.
                        </p>
                    </div>
                    {info && <div className="mb-4"><InfoBanner msg={info} /></div>}
                    {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                    <form onSubmit={handleVerifyEmail} className="flex flex-col gap-3">
                        <SlottedCodeInput value={code} onChange={setCode} disabled={loading || verifyExiting} onAutoSubmit={submitVerifyEmailCode} error={codeError} />
                        <ClButton type="submit" fullWidth disabled={loading || verifyExiting || code.length < 6} loading={loading || verifyExiting}>
                            {loading || verifyExiting ? 'Verifying…' : 'Verify and continue'}
                        </ClButton>
                        <ClButton variant="ghost" fullWidth onClick={handleResendVerifyEmail} disabled={resendCountdown > 0 || verifyExiting}>
                            {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend code'}
                        </ClButton>
                        <ClButton variant="ghost" fullWidth onClick={() => switchView('register')} disabled={verifyExiting}>← Wrong email? Start over</ClButton>
                    </form>
                </div>
            </Shell>
            </>
        );
    }

    /* ─────────────────────────────────────────
       Render: Login 2FA
    ───────────────────────────────────────── */
    if (view === 'login-2fa') {
        const totpMode = twoFactorMethod === 'totp' && !usingBackupCode;
        return (
            <Shell>
                <div className="text-center mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                        {totpMode ? <Smartphone className="w-7 h-7 text-cl-lume" /> : <Mail className="w-7 h-7 text-cl-lume" />}
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">Two-step verification</h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        {usingBackupCode ? (
                            'Enter one of your saved backup codes.'
                        ) : totpMode ? (
                            'Open your authenticator app and enter the 6-digit code.'
                        ) : (
                            'We sent a 6-digit code to your email.'
                        )}
                    </p>
                </div>
                {info && <div className="mb-4"><InfoBanner msg={info} /></div>}
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                <form onSubmit={handleVerify2fa} className="flex flex-col gap-3">
                    {usingBackupCode ? (
                        <Field
                            icon={<KeyRound size={15} />}
                            placeholder="abcd-efgh-ijkl-mnop"
                            value={code}
                            onChange={setCode}
                            disabled={loading}
                            autoFocus
                        />
                    ) : (
                        <SlottedCodeInput value={code} onChange={setCode} disabled={loading} onAutoSubmit={submitVerify2faCode} error={codeError} noAutoPaste={totpMode} />
                    )}
                    <ClButton type="submit" fullWidth disabled={loading || code.length < 6} loading={loading}>
                        {loading ? 'Verifying…' : 'Verify and sign in'}
                    </ClButton>

                    {twoFactorMethod === 'email' && !usingBackupCode && (
                        <ClButton variant="ghost" fullWidth onClick={handleResend2faEmail} disabled={resendCountdown > 0}>
                            {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend code'}
                        </ClButton>
                    )}

                    {twoFactorMethod === 'totp' && (
                        <ClButton variant="ghost" fullWidth onClick={() => { setUsingBackupCode(b => !b); setCode(''); setError(''); }}>
                            {usingBackupCode ? '← Use authenticator instead' : 'Use backup code'}
                        </ClButton>
                    )}

                    <ClButton variant="ghost" fullWidth onClick={() => { setPending2faToken(null); switchView('login'); }}>← Cancel</ClButton>
                </form>
            </Shell>
        );
    }

    /* ─────────────────────────────────────────
       Render: Forgot password
    ───────────────────────────────────────── */
    if (view === 'forgot-password') {
        return (
            <Shell>
                <div className="text-center mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                        <KeyRound className="w-7 h-7 text-cl-lume" />
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">Reset password</h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        Enter your account email — we'll send you a reset code.
                    </p>
                </div>
                {info && <div className="mb-4"><InfoBanner msg={info} /></div>}
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                <form onSubmit={handleForgotSubmit} className="flex flex-col gap-3">
                    <Field icon={<Mail size={15} />} placeholder="Email" value={email} onChange={setEmail} disabled={loading} autoFocus />
                    {TURNSTILE_KEY && (
                        <div className="flex flex-col items-center gap-1.5">
                            <TurnstileFrame
                                ref={forgotTurnstileRef}
                                siteKey={TURNSTILE_KEY}
                                onSuccess={(t) => { setForgotTurnstileToken(t); setTurnstileError(''); }}
                                onError={() => { setForgotTurnstileToken(''); setTurnstileError("The human-check couldn't load. Check your connection (or an ad-blocker) and retry."); }}
                                onExpire={() => setForgotTurnstileToken('')}
                            />
                            {turnstileError && (
                                <div className="text-xs text-amber-400 text-center">
                                    {turnstileError}{' '}
                                    <button type="button" className="underline" onClick={() => { setTurnstileError(''); forgotTurnstileRef.current?.reset(); }}>Retry</button>
                                </div>
                            )}
                        </div>
                    )}
                    <ClButton
                        type="submit"
                        fullWidth
                        disabled={loading || !email || (TURNSTILE_KEY !== '' && !forgotTurnstileToken)}
                        loading={loading}
                    >
                        {loading ? 'Sending…' : 'Send reset code'}
                    </ClButton>
                    <ClButton variant="ghost" fullWidth onClick={() => switchView('login')}>← Back to sign in</ClButton>
                </form>
            </Shell>
        );
    }

    if (view === 'reset-password') {
        // Step 1: verify email code
        if (resetStep === 'code') return (
            <Shell>
                <div className="text-center mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                        <Mail className="w-7 h-7 text-cl-lume" />
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">Check your email</h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        Enter the 6-digit code we sent to <strong className="text-cl-text">{email || 'your email'}</strong>.
                    </p>
                </div>
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                <form onSubmit={handleResetCodeSubmit} className="flex flex-col gap-3">
                    <SlottedCodeInput value={code} onChange={setCode} disabled={loading} error={codeError} onAutoSubmit={submitResetEmailCode} />
                    <ClButton type="submit" fullWidth disabled={loading || code.length < 6} loading={loading}>
                        {loading ? 'Verifying…' : 'Verify'}
                    </ClButton>
                    <ClButton variant="ghost" fullWidth onClick={() => switchView('forgot-password')}>← Resend code</ClButton>
                </form>
            </Shell>
        );

        // Step 2: 2FA (only if account has TOTP enabled) — validated server-side before advancing.
        if (resetStep === '2fa') return (
            <Shell>
                <div className="text-center mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                        <ShieldCheck className="w-7 h-7 text-cl-lume" />
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">Two-factor verification</h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        {reset2faMode === 'totp'
                            ? 'Enter the 6-digit code from your authenticator app.'
                            : 'Enter one of your backup codes.'}
                    </p>
                </div>
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                <form onSubmit={handleReset2faNext} className="flex flex-col gap-3">
                    {reset2faMode === 'backup' ? (
                        <Field
                            icon={<KeyRound size={15} />}
                            placeholder="Backup code"
                            value={reset2faCode}
                            onChange={setReset2faCode}
                            autoFocus
                        />
                    ) : (
                        <SlottedCodeInput value={reset2faCode} onChange={setReset2faCode} noAutoPaste />
                    )}
                    <div className="flex justify-center gap-4 text-[12px]">
                        {reset2faMode === 'totp' && (
                            <button type="button" onClick={() => { setReset2faMode('backup'); setReset2faCode(''); }}
                                className="text-cl-lume hover:underline" style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                                Use a backup code
                            </button>
                        )}
                        {reset2faMode === 'backup' && (
                            <button type="button" onClick={() => { setReset2faMode('totp'); setReset2faCode(''); }}
                                className="text-cl-lume hover:underline" style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                                Use authenticator app
                            </button>
                        )}
                    </div>
                    <ClButton type="submit" fullWidth loading={loading}
                        disabled={loading || (reset2faMode === 'backup' ? reset2faCode.trim().length < 6 : reset2faCode.length !== 6)}>
                        {loading ? 'Verifying…' : 'Continue'}
                    </ClButton>
                    <ClButton variant="ghost" fullWidth onClick={() => { setResetStep('code'); setReset2faCode(''); }}>← Back</ClButton>
                </form>
            </Shell>
        );

        // Step 3: set new password
        return (
            <Shell>
                <div className="text-center mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                        <Lock className="w-7 h-7 text-cl-lume" />
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">New password</h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        Choose a strong password for your account.
                    </p>
                </div>
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                <form onSubmit={handleResetPasswordSubmit} className="flex flex-col gap-3">
                    <Field
                        icon={<Lock size={15} />}
                        type={showPassword ? 'text' : 'password'}
                        placeholder="New password"
                        value={newPassword}
                        onChange={setNewPassword}
                        disabled={loading}
                        rightSlot={
                            <button type="button" onClick={() => setShowPassword(s => !s)} className="flex items-center justify-center text-cl-faint hover:text-cl-text transition-colors" style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 4 }}>
                                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                            </button>
                        }
                    />
                    {newPassword && zxcvbn && <StrengthBar score={zxcvbn(newPassword).score} />}
                    <Field
                        icon={<Lock size={15} />}
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Confirm new password"
                        value={confirmPassword}
                        onChange={setConfirmPassword}
                        disabled={loading}
                    />
                    {confirmPassword && newPassword !== confirmPassword && (
                        <p className="text-xs -mt-1" style={{ color: 'var(--cl-flash)' }}>Passwords do not match</p>
                    )}
                    <ClCheckbox
                        checked={resetLogoutOthers}
                        onChange={setResetLogoutOthers}
                        label={<span className="text-[13px] text-cl-muted">Sign out all other devices</span>}
                    />
                    <ClButton type="submit" fullWidth disabled={loading || !newPassword || newPassword !== confirmPassword} loading={loading}>
                        {loading ? 'Resetting…' : 'Reset password'}
                    </ClButton>
                    <ClButton variant="ghost" fullWidth onClick={() => setResetStep(resetRequires2fa ? '2fa' : 'code')}>← Back</ClButton>
                </form>
            </Shell>
        );
    }

    /* ─────────────────────────────────────────
       Render: Register
    ───────────────────────────────────────── */
    if (view === 'register') {
        return (
            <Shell shake={shake}>
                {clipboardOffer && (
                    <div className="mb-4"><AttributionClipboardOffer found={clipboardOffer} onUse={acceptClipboardOffer} onDismiss={() => setClipboardOffer(null)} /></div>
                )}
                <h2 className="text-lg font-bold text-cl-text text-center mb-1">Create your account</h2>
                <p className="text-cl-faint text-sm text-center mb-6">7-day free trial. No card required.</p>
                {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
                {carriedInvite && (
                    <div className="mb-4"><InfoBanner msg="You were invited to a server. Once your account is ready, we'll ask if you'd like to join." /></div>
                )}
                <form onSubmit={handleRegisterSubmit} className="flex flex-col gap-3">
                    <Field icon={<Mail size={15} />} placeholder="Email" value={email} onChange={setEmail} disabled={loading} />
                    <DatePicker icon={<Calendar size={15} />} placeholder="Date of birth (YYYY-MM-DD)" ariaLabel="Date of birth" value={dob} onChange={setDob} disabled={loading} />
                    <div>
                        <Field
                            icon={<Lock size={15} />}
                            type={showPassword ? 'text' : 'password'}
                            placeholder="Password"
                            value={password}
                            onChange={setPassword}
                            disabled={loading}
                            rightSlot={
                                <button type="button" onClick={() => setShowPassword(s => !s)} className="flex items-center justify-center text-cl-faint hover:text-cl-text transition-colors" style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 4 }}>
                                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                            }
                        />
                        {strengthScore >= 0 && <div className="mt-2"><StrengthBar score={strengthScore} /></div>}
                    </div>
                    <Field
                        icon={<Lock size={15} />}
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Confirm password"
                        value={confirmPassword}
                        onChange={setConfirmPassword}
                        disabled={loading}
                    />
                    {/* Optional referral code — collapsible to keep the form lean; auto-expands when pre-filled from a referral link */}
                    <ReferralCodeField value={referralCode} onChange={setReferralCode} disabled={loading} forceOpen={referralFromLink} onValidityChange={setReferralValidity} onResolved={setReferrer} onRemove={removeReferral} />

                    {/* Age (13+) is enforced by the neutral date-of-birth gate above +
                        the Terms; no need to restate it here. This is the clickwrap
                        consent to the Terms & Privacy Policy. The checkbox is a <button>,
                        so the links can't live inside its label (nested interactive
                        content, and the click would also toggle the box) — they sit beside
                        it, and the plain words still toggle it like a normal label.
                        Kept to one line so the box doesn't float against a wrapped label. */}
                    <div className="flex items-center gap-[11px]">
                        <ClCheckbox checked={tosAccepted} onChange={setTosAccepted} />
                        <span className="text-[13px] text-cl-muted leading-snug whitespace-nowrap">
                            <span className="cursor-pointer select-none" onClick={() => setTosAccepted(!tosAccepted)}>I agree to the</span>{' '}
                            <LegalLink href={LEGAL_TERMS_URL}>Terms</LegalLink> &amp;{' '}
                            <LegalLink href={LEGAL_PRIVACY_URL}>Privacy Policy</LegalLink>.
                        </span>
                    </div>
                    {TURNSTILE_KEY && (
                        <div className="flex flex-col items-center gap-1.5">
                            <TurnstileFrame
                                ref={regTurnstileRef}
                                siteKey={TURNSTILE_KEY}
                                onSuccess={(t) => { setRegTurnstileToken(t); setTurnstileError(''); }}
                                onError={() => { setRegTurnstileToken(''); setTurnstileError("The human-check couldn't load. Check your connection (or an ad-blocker) and retry."); }}
                                onExpire={() => setRegTurnstileToken('')}
                            />
                            {turnstileError && (
                                <div className="text-xs text-amber-400 text-center">
                                    {turnstileError}{' '}
                                    <button type="button" className="underline" onClick={() => { setTurnstileError(''); regTurnstileRef.current?.reset(); }}>Retry</button>
                                </div>
                            )}
                        </div>
                    )}
                    <ClButton
                        type="submit"
                        fullWidth
                        loading={loading}
                        disabled={loading || (TURNSTILE_KEY !== '' && !regTurnstileToken)}
                    >
                        {loading ? 'Creating account…' : 'Create account'}
                    </ClButton>
                    <div className="flex justify-center mt-2">
                        <button type="button" onClick={() => switchView('login')} className="text-[13px] text-cl-muted hover:text-cl-text transition-colors">
                            Already have an account? <span className="text-cl-lume font-semibold">Sign in</span>
                        </button>
                    </div>
                </form>
            </Shell>
        );
    }

    /* ─────────────────────────────────────────
       Render: Login (default)
    ───────────────────────────────────────── */
    return (
        <Shell shake={shake}>
            {clipboardOffer && (
                <div className="mb-4"><AttributionClipboardOffer found={clipboardOffer} onUse={acceptClipboardOffer} onDismiss={() => setClipboardOffer(null)} /></div>
            )}
            <h2 className="text-lg font-bold text-cl-text text-center mb-1">Welcome back</h2>
            <p className="text-cl-faint text-sm text-center mb-4">Sign in to your Cipherline account.</p>
            <ClSegment
                className="mb-5"
                options={[
                    { value: 'password', label: 'Password' },
                    { value: 'qr', label: 'Sign in with your phone' },
                ]}
                value={loginMode}
                onChange={setLoginMode}
            />
            {info && <div className="mb-4"><InfoBanner msg={info} /></div>}
            {error && <div className="mb-4"><ErrorBanner msg={error} /></div>}
            {loginMode === 'qr' ? (
                <QrSignInPanel />
            ) : (
                <form onSubmit={handleLoginSubmit} className="flex flex-col gap-3">
                    <Field icon={<Mail size={15} />} placeholder="Email" value={email} onChange={setEmail} disabled={loading} />
                    <Field
                        icon={<Lock size={15} />}
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Password"
                        value={password}
                        onChange={setPassword}
                        disabled={loading}
                        rightSlot={
                            <button type="button" onClick={() => setShowPassword(s => !s)} className="flex items-center justify-center text-cl-faint hover:text-cl-text transition-colors" style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 4 }}>
                                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                            </button>
                        }
                    />
                    <ClButton type="submit" fullWidth loading={loading}>
                        {loading ? 'Signing in…' : 'Sign in'}
                    </ClButton>
                    {/* Secondary actions as light text links — not heavy full-width buttons. */}
                    <div className="flex flex-col items-center gap-2.5 mt-2">
                        <button type="button" onClick={() => switchView('forgot-password')} className="text-[13px] text-cl-faint hover:text-cl-lume transition-colors">
                            Forgot your password?
                        </button>
                        <button type="button" onClick={() => switchView('register')} className="text-[13px] text-cl-muted hover:text-cl-text transition-colors">
                            Don't have an account? <span className="text-cl-lume font-semibold">Sign up</span>
                        </button>
                    </div>
                </form>
            )}
            {loginMode === 'qr' && (
                <div className="flex flex-col items-center gap-2.5 mt-4">
                    <button type="button" onClick={() => switchView('register')} className="text-[13px] text-cl-muted hover:text-cl-text transition-colors">
                        Don't have an account? <span className="text-cl-lume font-semibold">Sign up</span>
                    </button>
                </div>
            )}
        </Shell>
    );
};

export default AuthScreen;
