import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

/**
 * Animated digit slots for one-time codes (email verify, 2FA, password reset)
 * and, via the `length` prop, Screen Lock PINs (4 or 6 digits).
 *
 * Auto-fill behaviour (focus-triggered path, i.e. user switches back from their
 * email client):
 *   - Reads clipboard via Electron main-process IPC (`readClipboard`).
 *   - Rate-limited to 3 attempts per mount so it cannot be used for
 *     brute-forcing; server-side throttling is the primary gate.
 *   - 10 s cooldown between consecutive focus-triggered fills.
 *   - Deduplicates: will not re-fill the same code on the next focus.
 *   - navigator.clipboard is intentionally NOT used as a fallback — Chromium's
 *     clipboard-read permission blocks it in Electron without a user gesture.
 *
 * Manual paste (Ctrl+V) has no attempt limit — it is always user-initiated.
 * If onAutoSubmit is omitted the component is fill-only (account-deletion flow).
 */
export interface SlottedCodeInputHandle {
    /** Focus the hidden input. Exposed so callers can refocus from outside this
     *  component's own bounding box — e.g. Screen Lock's full-viewport overlay
     *  refocusing on any click, not just a click on the digit slots. */
    focus: () => void;
}

const SlottedCodeInput = forwardRef<SlottedCodeInputHandle, {
    value: string;
    onChange: (v: string) => void;
    onAutoSubmit?: (code: string) => void;
    disabled?: boolean;
    /** Flash the slots red — set briefly after a wrong code before it clears. */
    error?: boolean;
    /** Disable window-focus clipboard auto-fill. Use for TOTP fields where the
     *  email OTP may still be in the clipboard and auto-filling it would be wrong. */
    noAutoPaste?: boolean;
    /** Number of digit slots. Defaults to 6 (every OTP/TOTP call site). Screen
     *  Lock is the only caller that ever passes 4. */
    length?: number;
    /** Show a filled dot instead of the actual digit — for secrets (Screen
     *  Lock PINs) as opposed to one-time codes, where seeing the digits is
     *  fine (they're single-use and often read off an email/authenticator). */
    mask?: boolean;
}>(({ value, onChange, onAutoSubmit, disabled, error, noAutoPaste, length = 6, mask = false }, ref) => {
    const inputRef     = useRef<HTMLInputElement>(null);
    const animating    = useRef(false);
    const mounted      = useRef(true);
    // Prevents the Enter keydown from double-firing onAutoSubmit when the
    // user types the 6th digit (onChange fires it) then presses Enter.
    const autoSubmitPendingRef = useRef(false);

    // Focus-triggered auto-fill safeguards
    const focusFillCount  = useRef(0);   // max 20 per mount
    const lastFillAt      = useRef(0);   // cooldown between focus fills
    const lastFilledCode  = useRef('');  // don't re-fill the same code

    // Refs for the stable [] closure — track current prop values without recreating the handler
    const disabledRef    = useRef(disabled);
    disabledRef.current  = disabled;
    const noAutoPasteRef = useRef(noAutoPaste);
    noAutoPasteRef.current = noAutoPaste;
    // Set to true when window:focus fires while the input is disabled — we retry
    // the fill as soon as the input becomes enabled (e.g. email OTP finishes sending).
    const missedFocusRef = useRef(false);

    const [focused, setFocused] = useState(false);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    useImperativeHandle(ref, () => ({
        focus: () => inputRef.current?.focus(),
    }), []);

    const tryClipboardFillRef = useRef<() => Promise<void>>(async () => {});

    const animateFill = useCallback(async (cleaned: string) => {
        if (animating.current || disabled || !mounted.current) return;
        animating.current = true;

        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        onChange('');
        for (let i = 0; i < length; i++) {
            if (!mounted.current) { animating.current = false; return; }
            if (!reducedMotion && i > 0) await new Promise<void>(r => setTimeout(r, 55));
            onChange(cleaned.slice(0, i + 1));
        }

        if (!mounted.current) { animating.current = false; return; }
        animating.current = false;
        if (mounted.current) onAutoSubmit?.(cleaned);
    }, [onChange, onAutoSubmit, disabled, length]);

    const animateFillRef = useRef(animateFill);
    animateFillRef.current = animateFill;

    // Focus-triggered path only — Ctrl+V paste path has no limits (user-initiated).
    const tryClipboardFill = useCallback(async () => {
        if (noAutoPaste) return;                              // disabled for TOTP fields
        if (animating.current || disabled) return;
        if (focusFillCount.current >= 20) return;            // per-mount safety cap
        if (!window.electronAPI?.readClipboard) return;      // IPC not available

        const now = Date.now();
        if (now - lastFillAt.current < 1_500) return;        // 1.5 s cooldown (was 10 s)

        let text = '';
        try {
            text = await window.electronAPI.readClipboard();
        } catch { return; }
        if (!mounted.current || !text) return;

        const cleaned = text.trim().replace(/[^0-9]/g, '').slice(0, length);
        if (cleaned.length !== length) return;
        if (cleaned === lastFilledCode.current) return;      // same code, skip

        focusFillCount.current += 1;
        lastFillAt.current = now;
        lastFilledCode.current = cleaned;
        animateFillRef.current(cleaned);
    }, [disabled, noAutoPaste, length]);

    tryClipboardFillRef.current = tryClipboardFill;

    // window:focus → try to fill. If the input is disabled at that moment (e.g. email
    // code is still in-flight), record a missed fill so we can retry once it becomes
    // enabled.
    // We register BOTH the Electron IPC path (more reliable on some OS/app switches)
    // AND the DOM 'focus' event (fallback for older preloads / non-Electron builds).
    // Both can fire for the same focus event; the 1.5 s cooldown + same-code dedup
    // inside tryClipboardFill prevent any double-fill.
    useEffect(() => {
        const handleFocus = () => {
            if (disabledRef.current || noAutoPasteRef.current) {
                if (!noAutoPasteRef.current) missedFocusRef.current = true;
                return;
            }
            tryClipboardFillRef.current();
        };
        const unsubIpc = window.electronAPI?.onWindowFocus?.(handleFocus);
        // Always also listen to the DOM event — if the preload is an older build that
        // lacks onWindowFocus, or if the IPC path silently fails, this is the safety net.
        window.addEventListener('focus', handleFocus);
        return () => {
            unsubIpc?.();
            window.removeEventListener('focus', handleFocus);
        };
    }, []);

    // Refocus the hidden input whenever the parent clears the value after an error.
    // Skip during animation (animating.current) — that clear is intentional and the
    // fill loop immediately re-populates digits, so focus would just flash.
    const prevValueLenRef = useRef(value.length);
    useEffect(() => {
        const prev = prevValueLenRef.current;
        prevValueLenRef.current = value.length;
        if (prev > 0 && value.length === 0 && !disabled && !animating.current) {
            inputRef.current?.focus();
        }
    }, [value, disabled]);

    // When the input becomes enabled, retry ONLY if a focus event was missed while
    // it was disabled — not unconditionally (unconditional retry reads stale clipboard
    // content, sets the 10s cooldown, then blocks the real fill when the user returns).
    const prevDisabledRef = useRef(disabled);
    useEffect(() => {
        const wasDisabled = prevDisabledRef.current;
        prevDisabledRef.current = disabled;
        if (wasDisabled && !disabled && !noAutoPaste && missedFocusRef.current) {
            missedFocusRef.current = false;
            tryClipboardFillRef.current();
        }
    }, [disabled, noAutoPaste]);

    const digits = Array.from({ length }, (_, i) => value[i] ?? '');

    return (
        <div
            style={{ position: 'relative', display: 'flex', gap: 8, justifyContent: 'center' }}
            onClick={() => { if (!disabled) inputRef.current?.focus(); }}
        >
            {digits.map((digit, i) => {
                const isCursor = focused && !disabled && i === value.length && i < length;
                const filled   = Boolean(digit);
                return (
                    <div
                        key={i}
                        style={{
                            width: 44, height: 52, borderRadius: 12, flexShrink: 0,
                            background: error ? 'rgba(255,107,94,0.10)' : filled ? 'rgba(37,224,200,0.08)' : 'var(--cl-surface)',
                            border: `1.5px solid ${error ? 'var(--cl-flash, #FF6B5E)' : isCursor ? 'var(--cl-lume)' : filled ? 'rgba(37,224,200,0.32)' : 'var(--cl-border)'}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'border-color .15s, background .15s, box-shadow .15s',
                            boxShadow: error ? '0 0 0 3px rgba(255,107,94,0.13)' : isCursor ? '0 0 0 3px rgba(37,224,200,0.13)' : 'none',
                            position: 'relative', overflow: 'hidden',
                        }}
                    >
                        {digit ? (
                            mask ? (
                                <span
                                    key={`${i}-${digit}`}
                                    className="code-digit-pop"
                                    style={{
                                        width: 10, height: 10, borderRadius: '50%',
                                        background: 'var(--cl-text)',
                                        display: 'block',
                                    }}
                                />
                            ) : (
                                <span
                                    key={`${i}-${digit}`}
                                    className="code-digit-pop"
                                    style={{
                                        fontSize: 22,
                                        fontFamily: "'JetBrains Mono','SFMono-Regular',Consolas,monospace",
                                        fontWeight: 700,
                                        color: 'var(--cl-text)',
                                        lineHeight: 1,
                                        display: 'block',
                                    }}
                                >
                                    {digit}
                                </span>
                            )
                        ) : (
                            <span style={{
                                width: 6, height: 6, borderRadius: '50%',
                                background: isCursor ? 'var(--cl-lume)' : 'var(--cl-faint)',
                                opacity: isCursor ? 0.9 : 0.3,
                                transition: 'all .15s',
                            }} />
                        )}
                    </div>
                );
            })}

            <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                maxLength={length}
                value={value}
                onChange={e => {
                    if (animating.current) return;
                    const cleaned = e.target.value.replace(/[^\d]/g, '').slice(0, length);
                    onChange(cleaned);
                    if (cleaned.length === length) {
                        autoSubmitPendingRef.current = true;
                        onAutoSubmit?.(cleaned);
                        // Reset after a tick so Enter-after-fill is still possible
                        setTimeout(() => { autoSubmitPendingRef.current = false; }, 500);
                    }
                }}
                onKeyDown={e => {
                    if (e.key === 'Enter' && value.length === length) {
                        e.preventDefault();
                        // Skip if onChange already fired onAutoSubmit for this code
                        if (!autoSubmitPendingRef.current) onAutoSubmit?.(value);
                    }
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onPaste={e => {
                    const raw = e.clipboardData.getData('text');
                    const cleaned = raw.trim().replace(/[^0-9]/g, '').slice(0, length);
                    if (cleaned.length === length) {
                        e.preventDefault();
                        animateFillRef.current(cleaned);
                    }
                }}
                disabled={disabled}
                autoFocus
                autoComplete="one-time-code"
                style={{
                    position: 'absolute', inset: 0,
                    opacity: 0, fontSize: 1, color: 'transparent',
                    background: 'transparent', border: 'none', outline: 'none',
                    width: '100%', height: '100%',
                    cursor: disabled ? 'default' : 'text',
                    pointerEvents: disabled ? 'none' : 'auto',
                }}
            />
        </div>
    );
});

SlottedCodeInput.displayName = 'SlottedCodeInput';

export default SlottedCodeInput;
