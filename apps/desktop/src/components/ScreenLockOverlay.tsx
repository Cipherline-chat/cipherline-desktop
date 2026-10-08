import React, { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { ClButton } from './cl';
import SlottedCodeInput, { type SlottedCodeInputHandle } from './SlottedCodeInput';
import { useAuth } from '../contexts/AuthContext';
import type { ScreenLockHook } from '../hooks/useScreenLock';
import LockScreenField from './LockScreenField';
import '../styles/screen-lock.css';

/**
 * The padlock. Drawn here (not an icon-font glyph) so the shackle can move and
 * the whole thing can take the state of the lock: lume when waiting, red after a
 * wrong PIN or while cooling down. The keyhole is cut out in the backdrop's own
 * navy so it reads as a hole on any background.
 */
const Padlock: React.FC<{ state: 'idle' | 'typing' | 'bad' | 'cool' }> = ({ state }) => {
    const bad = state === 'bad' || state === 'cool';
    const top = bad ? '#FF8A85' : '#5CF0DC';
    const bottom = bad ? '#E5484D' : '#14B8A4';
    return (
        <div className={`sl-lock${state === 'bad' ? ' is-bad' : ''}${state === 'cool' ? ' is-cool' : ''}${state === 'typing' ? ' is-typing' : ''}`} aria-hidden="true">
            <div className="sl-lock-glow" />
            <svg className="sl-lock-svg" viewBox="0 0 96 96" fill="none">
                <defs>
                    <linearGradient id="sl-body" x1="48" y1="40" x2="48" y2="88" gradientUnits="userSpaceOnUse">
                        <stop offset="0" stopColor={top} />
                        <stop offset="1" stopColor={bottom} />
                    </linearGradient>
                </defs>
                {/* Shackle: a rounded arch that disappears into the body. */}
                <path
                    className="sl-shackle"
                    d="M30 46 V33 a18 18 0 0 1 36 0 V46"
                    stroke={bad ? '#FF8A85' : '#A7F3EA'}
                    strokeWidth="7"
                    strokeLinecap="round"
                />
                {/* Body */}
                <rect x="17" y="42" width="62" height="46" rx="15" fill="url(#sl-body)" />
                {/* Top-edge sheen */}
                <path d="M21 56 a13 13 0 0 1 13 -12 h28" stroke="#FFFFFF" strokeOpacity=".28" strokeWidth="2.4" strokeLinecap="round" />
                {/* Keyhole */}
                <circle cx="48" cy="62" r="6.2" fill="#0B0F1E" />
                <rect x="45.4" y="64" width="5.2" height="12" rx="2.6" fill="#0B0F1E" />
            </svg>
        </div>
    );
};

/**
 * Full-viewport gate shown whenever `screenLock.isLocked` is true — visually
 * mirrors StorageLockedScreen's language, but this blocks VIEWING/interacting
 * with the UI only. It does not pause the WebSocket, notifications, or any
 * background sync (matches Signal Desktop / Slack's screen lock, not a full
 * app suspend). Mounted inside Dashboard at the highest z-index in the app so
 * it covers every modal, portal, and call-panel node.
 */
const ScreenLockOverlay: React.FC<{ screenLock: ScreenLockHook }> = ({ screenLock }) => {
    const { logout } = useAuth();
    const [pin, setPin] = useState('');
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmingSignOut, setConfirmingSignOut] = useState(false);
    const [cooldownSecs, setCooldownSecs] = useState(0);
    const [fieldLive, setFieldLive] = useState(false);
    const codeInputRef = useRef<SlottedCodeInputHandle>(null);

    // Refocus the hidden PIN input whenever the Cipherline window regains OS
    // focus (alt-tab back, click the taskbar icon, etc.) — SlottedCodeInput's
    // own window-focus listener skips this while noAutoPaste is set (that
    // flag is about disabling clipboard auto-fill, not refocusing).
    useEffect(() => {
        const refocus = () => codeInputRef.current?.focus();
        window.addEventListener('focus', refocus);
        return () => window.removeEventListener('focus', refocus);
    }, []);

    // Live countdown while locked out from repeated wrong attempts. Resets
    // cooldownSecs back to 0 in the cleanup (not the effect body) so leaving
    // the locked-out state — cooldown expiring or lockedOutUntil clearing on
    // a successful unlock — doesn't call setState synchronously mid-effect.
    useEffect(() => {
        if (!screenLock.lockedOutUntil) return;
        const tick = () => {
            const remaining = Math.max(0, Math.ceil((screenLock.lockedOutUntil! - Date.now()) / 1000));
            setCooldownSecs(remaining);
        };
        tick();
        const id = window.setInterval(tick, 250);
        return () => { window.clearInterval(id); setCooldownSecs(0); };
    }, [screenLock.lockedOutUntil]);

    const attempt = async (code: string) => {
        if (busy || cooldownSecs > 0) return;
        setBusy(true);
        const ok = await screenLock.unlock(code);
        setBusy(false);
        if (!ok) {
            setError(true);
            setPin('');
            setTimeout(() => setError(false), 500);
        }
    };

    const handleForgotPin = () => {
        screenLock.forgotPinReset();
        logout('Screen Lock was reset. Sign in again to continue.');
    };

    const lockState: 'idle' | 'typing' | 'bad' | 'cool' =
        cooldownSecs > 0 ? 'cool' : error ? 'bad' : pin.length > 0 ? 'typing' : 'idle';

    return (
        <div
            onClick={() => codeInputRef.current?.focus()}
            style={{
                position: 'fixed', inset: 0, zIndex: 999999,
                // The loading screen's own backdrop once its dots are up (they
                // are drawn on a transparent canvas); the flat abyss otherwise.
                background: fieldLive
                    ? 'linear-gradient(180deg, #131A30 0%, #0F1526 45%, #0B0F1E 100%)'
                    : 'var(--cl-abyss)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
                overflow: 'hidden',
            }}
        >
            {/* The loading screen's dots, behind everything (see LockScreenField). */}
            <LockScreenField onLive={setFieldLive} />

            <div className="sl-stage">
                <Padlock state={lockState} />

                <h1
                    style={{
                        margin: '0 0 6px', textAlign: 'center',
                        fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 26,
                        letterSpacing: '-.005em', color: 'var(--cl-text)',
                    }}
                >
                    Cipherline is locked
                </h1>
                <p style={{ margin: '0 0 18px', textAlign: 'center', fontSize: 14, color: 'var(--cl-faint)' }}>
                    Enter your PIN to unlock.
                </p>

                <div className="sl-panel">
                    <SlottedCodeInput
                        ref={codeInputRef}
                        value={pin}
                        onChange={setPin}
                        onAutoSubmit={attempt}
                        disabled={busy || cooldownSecs > 0}
                        error={error}
                        noAutoPaste
                        mask
                        length={screenLock.settings.pinLength}
                    />

                    <p className={`sl-status${cooldownSecs > 0 || error ? ' is-bad' : ''}`} role="status">
                        {cooldownSecs > 0
                            ? `Too many attempts. Try again in ${cooldownSecs}s.`
                            : error
                                ? 'Wrong PIN. Try again.'
                                : ''}
                    </p>

                    <div className="sl-divider" />

                    {!confirmingSignOut ? (
                        <button type="button" className="sl-forgot" onClick={() => setConfirmingSignOut(true)}>
                            Forgot your PIN?
                        </button>
                    ) : (
                        <>
                            <p style={{ fontSize: 12, color: 'var(--cl-muted)', margin: '0 0 10px', lineHeight: 1.5, textAlign: 'center' }}>
                                This turns Screen Lock off and signs you out on this device. Nothing else is
                                lost. Sign back in with your account password to pick up where you left off.
                            </p>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <ClButton fullWidth variant="ghost" onClick={() => setConfirmingSignOut(false)}>
                                    Cancel
                                </ClButton>
                                <ClButton fullWidth variant="danger" onClick={handleForgotPin}>
                                    <LogOut size={14} style={{ marginRight: 6 }} />
                                    Sign out
                                </ClButton>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ScreenLockOverlay;
