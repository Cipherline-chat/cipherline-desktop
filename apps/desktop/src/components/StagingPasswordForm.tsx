import React, { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClField, ClInput } from './cl';
import { STAGING_PASSWORD_MAX_LENGTH, unlockErrorText } from '../utils/stagingLock';

/**
 * The one password form for the staging lock — used by the full-screen
 * StagingLockScreen (staging builds) and the Settings → Advanced prompt
 * (switching the update channel to Staging). Main verifies; this only sends
 * the attempt and renders the answer. The typed password lives in this
 * component's state until submit and is cleared after every attempt.
 */
export const StagingPasswordForm: React.FC<{
    onUnlocked: () => void;
    /** From staging-lock:status — a backoff already in force when we mounted. */
    initialRetryAfterMs?: number;
    submitLabel?: string;
    /** Extra controls rendered next to the submit button (e.g. Cancel). */
    secondary?: React.ReactNode;
}> = ({ onUnlocked, initialRetryAfterMs = 0, submitLabel = 'Unlock', secondary }) => {
    const id = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [password, setPassword] = useState('');
    const [show, setShow] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [retryUntil, setRetryUntil] = useState(() => (initialRetryAfterMs > 0 ? Date.now() + initialRetryAfterMs : 0));
    const [now, setNow] = useState(() => Date.now());

    // Tick once a second while a backoff is in force, so the countdown in the
    // error line stays honest and the button re-enables on time.
    useEffect(() => {
        if (retryUntil <= Date.now()) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [retryUntil]);

    const waitMs = Math.max(0, retryUntil - now);
    const waiting = waitMs > 0;
    // While a backoff is in force the countdown IS the error; otherwise the
    // last attempt's message ("Wrong password", or a transport failure).
    const shownError = waiting
        ? unlockErrorText({ ok: false, retryAfterMs: waitMs })
        : error;

    const submit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (busy || waiting || password.length === 0) return;
        const api = window.electronAPI;
        if (!api?.unlockStaging) { setError('Not available in this build.'); return; }
        setBusy(true);
        setError(null);
        try {
            const result = await api.unlockStaging(password);
            if (result.ok) {
                setPassword('');
                onUnlocked();
                return;
            }
            setPassword('');
            if (result.retryAfterMs > 0) {
                const t = Date.now();
                setNow(t);
                setRetryUntil(t + result.retryAfterMs);
            } else {
                setError(unlockErrorText(result));
            }
        } catch {
            setError('Could not check the password. Please try again.');
        } finally {
            setBusy(false);
            // Back to the field for the next try (it was disabled while busy).
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    };

    return (
        <form onSubmit={submit} noValidate>
            {/* Error rendered by hand rather than via ClField's `error`: that is a
                <p>, and inside a modal card `.mcard p` (muted, 22px margin) out-
                ranks `.fmsg`, turning the error grey and pushing the buttons. */}
            <ClField label="Staging password" htmlFor={id}>
                <div style={{ position: 'relative' }}>
                    <ClInput
                        ref={inputRef}
                        id={id}
                        type={show ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        maxLength={STAGING_PASSWORD_MAX_LENGTH}
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        aria-invalid={shownError ? true : undefined}
                        aria-describedby={`${id}-err`}
                        style={{ width: '100%', paddingRight: 40 }}
                    />
                    <button
                        type="button"
                        onClick={() => setShow((s) => !s)}
                        aria-label={show ? 'Hide password' : 'Show password'}
                        aria-pressed={show}
                        style={{
                            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: 'none', background: 'none', padding: 4, cursor: 'pointer',
                            color: 'var(--cl-faint)',
                        }}
                    >
                        {show ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                </div>
            </ClField>
            <div
                id={`${id}-err`}
                role="alert"
                style={{ minHeight: 18, marginTop: 6, fontSize: 12, fontWeight: 700, color: 'var(--cl-flash)' }}
            >
                {shownError}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                {secondary}
                <ClButton type="submit" loading={busy} disabled={busy || waiting || password.length === 0}>
                    {submitLabel}
                </ClButton>
            </div>
        </form>
    );
};

export default StagingPasswordForm;
