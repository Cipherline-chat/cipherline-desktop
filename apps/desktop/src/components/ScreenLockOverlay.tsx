import React, { useEffect, useRef, useState } from 'react';
import { Lock, LogOut } from 'lucide-react';
import { ClButton } from './cl';
import SlottedCodeInput, { type SlottedCodeInputHandle } from './SlottedCodeInput';
import { useAuth } from '../contexts/AuthContext';
import type { ScreenLockHook } from '../hooks/useScreenLock';
import cipherlineMark from '../assets/cipherline-mark.svg';

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

    return (
        <div
            onClick={() => codeInputRef.current?.focus()}
            style={{
                position: 'fixed', inset: 0, zIndex: 999999,
                background: 'var(--cl-abyss)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            }}
        >
            <div style={{ width: '100%', maxWidth: 400 }}>
                <div style={{ textAlign: 'center', marginBottom: 22 }}>
                    <div
                        style={{
                            width: 56, height: 56, borderRadius: 18, margin: '0 auto 16px',
                            background: 'var(--cl-lume-tint)', border: '1.5px solid rgba(37,224,200,0.32)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: 'var(--cl-glow-lume)',
                        }}
                    >
                        <Lock style={{ width: 26, height: 26, color: 'var(--cl-lume)' }} />
                    </div>
                    <img src={cipherlineMark} alt="" width={28} height={22} style={{ marginBottom: 10, opacity: 0.7 }} />
                    <h1 style={{ fontSize: 20, fontWeight: 800, color: 'var(--cl-text)', marginBottom: 8 }}>
                        Cipherline is locked
                    </h1>
                    <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-faint)' }}>
                        Enter your PIN to continue.
                    </p>
                </div>

                <div
                    style={{
                        background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
                        borderRadius: 20, padding: 26, boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
                    }}
                >
                    <div style={{ marginBottom: 20 }}>
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
                    </div>

                    {cooldownSecs > 0 ? (
                        <p style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--cl-flash)', fontWeight: 600 }}>
                            Too many attempts. Try again in {cooldownSecs}s.
                        </p>
                    ) : error ? (
                        <p style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--cl-flash)' }}>
                            Wrong PIN. Try again.
                        </p>
                    ) : (
                        <p style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--cl-faint)' }}>
                            {screenLock.settings.pinLength}-digit PIN
                        </p>
                    )}

                    <div style={{ height: 1, background: 'var(--cl-border)', margin: '18px 0 14px' }} />

                    {!confirmingSignOut ? (
                        <button
                            onClick={() => setConfirmingSignOut(true)}
                            style={{
                                display: 'block', width: '100%', textAlign: 'center',
                                background: 'none', border: 'none', cursor: 'pointer',
                                fontSize: 12.5, color: 'var(--cl-faint)', textDecoration: 'underline',
                                textUnderlineOffset: 3,
                            }}
                        >
                            Forgot your PIN?
                        </button>
                    ) : (
                        <>
                            <p style={{ fontSize: 12, color: 'var(--cl-muted)', marginBottom: 10, lineHeight: 1.5, textAlign: 'center' }}>
                                This turns Screen Lock off and signs you out on this device. Nothing else is
                                lost — sign back in with your account password to pick up where you left off.
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
