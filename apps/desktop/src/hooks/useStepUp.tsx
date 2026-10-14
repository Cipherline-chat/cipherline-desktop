import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { StepUpModal } from '../components/StepUpModal';
import {
    fetchStepUpMethod, verifyStepUp, StepUpError, STEP_UP_TTL_MS, type StepUpMethod,
} from '../services/stepUp';

/**
 * Gate for revealing a stored secret behind a fresh "Confirm it's you".
 *
 *   const stepUp = useStepUp({ subject: 'your backup passphrase', onExpire: () => setShow(false) });
 *   ...
 *   if (await stepUp.request()) setShow(true);       // prompts only if not already unlocked
 *   ...
 *   {stepUp.modal}                                    // render once
 *
 * The unlocked window is held in memory only, in this hook instance: it is
 * never persisted, it ends after `ttlMs` (5 min, matching the server's
 * `step_up_until`) or when the owning component unmounts, and hiding a secret
 * never needs a step-up. If the method lookup or the verification cannot be
 * completed, the answer is "no" — the gate fails closed.
 */
export interface UseStepUpOptions {
    /** What is being revealed, for the dialog copy. */
    subject?: string;
    /** Called when the unlocked window lapses — re-mask whatever was revealed. */
    onExpire?: () => void;
    /** Test seam; defaults to the 5-minute server window. */
    ttlMs?: number;
}

export interface UseStepUp {
    /** True while a step-up is in force. */
    unlocked: boolean;
    /** Resolves true when the caller may reveal (already unlocked, or just verified). */
    request: () => Promise<boolean>;
    /** The dialog; render it once in the owning component. */
    modal: React.ReactNode;
}

export function useStepUp(opts: UseStepUpOptions = {}): UseStepUp {
    const { subject, onExpire, ttlMs = STEP_UP_TTL_MS } = opts;
    const { token } = useAuth();
    const toast = useToast();

    const [unlocked, setUnlocked] = useState(false);
    // `method` outlives the prompt so the dialog's wording doesn't flip while it animates out.
    const [method, setMethod] = useState<StepUpMethod>('totp');
    const [prompt, setPrompt] = useState<null | { busy: boolean; error: string | null }>(null);
    const expiresAt = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resolver = useRef<((ok: boolean) => void) | null>(null);
    const onExpireRef = useRef(onExpire);
    useEffect(() => { onExpireRef.current = onExpire; });

    const settle = useCallback((ok: boolean) => {
        const r = resolver.current;
        resolver.current = null;
        r?.(ok);
    }, []);

    // Unmount: drop the window and release any waiter (as "no").
    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
        expiresAt.current = 0;
        settle(false);
    }, [settle]);

    const request = useCallback(async (): Promise<boolean> => {
        if (expiresAt.current > Date.now()) return true;
        if (resolver.current || !token) return false; // one dialog at a time
        let m: StepUpMethod;
        try {
            m = await fetchStepUpMethod(token);
        } catch {
            toast.push({ kind: 'error', title: "Confirm it's you", message: "Couldn't reach Cipherline. Check your connection and try again." });
            return false;
        }
        return new Promise<boolean>((resolve) => {
            resolver.current = resolve;
            setMethod(m);
            setPrompt({ busy: false, error: null });
        });
    }, [token, toast]);

    const submit = useCallback(async (value: string) => {
        if (!token || !prompt) return;
        setPrompt({ busy: true, error: null });
        try {
            await verifyStepUp(token, method, value);
        } catch (err) {
            const kind = err instanceof StepUpError ? err.kind : 'unavailable';
            const error = kind === 'rejected'
                ? (method === 'totp' ? "That code didn't work. Try again." : "That password didn't work. Try again.")
                : kind === 'rate_limited'
                    ? 'Too many attempts. Wait a few minutes and try again.'
                    : "Couldn't verify right now. Check your connection and try again.";
            setPrompt({ busy: false, error });
            return;
        }
        expiresAt.current = Date.now() + ttlMs;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            expiresAt.current = 0;
            setUnlocked(false);
            onExpireRef.current?.();
        }, ttlMs);
        setUnlocked(true);
        setPrompt(null);
        settle(true);
    }, [token, prompt, method, ttlMs, settle]);

    const cancel = useCallback(() => {
        setPrompt(null);
        settle(false);
    }, [settle]);

    const modal = (
        <StepUpModal
            open={!!prompt}
            method={method}
            busy={!!prompt?.busy}
            error={prompt?.error ?? null}
            subject={subject}
            onSubmit={(v) => { void submit(v); }}
            onCancel={cancel}
            onEdit={() => setPrompt((p) => (p && p.error ? { ...p, error: null } : p))}
        />
    );

    return { unlocked, request, modal };
}
