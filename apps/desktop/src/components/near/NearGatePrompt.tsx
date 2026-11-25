import React, { useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck, Lock } from 'lucide-react';
import { ClButton } from '../ClButton';
import { ClField, ClInput, ClModal } from '../cl';
import { DialogHeader, DialogBody, DialogFooter } from '../dialog/DialogFrame';
import { DialogForm } from '../dialog/DialogExtras';
import { useNearSession } from '../../hooks/useNearSession';
import { nearBridge } from '../../utils/nearBridge';
import { nt } from '../../utils/nearStrings';
import { safeLabel } from '../../utils/nearModel';
import type { NearGatePrompt as GatePrompt } from '../../types/near';

/**
 * The approval gate on a computer with no fingerprint / face sign-in (spec `bio.pw.*`): "enter your account password to
 * approve {device}". Shown only when the Electron build's main process asks for it while `nearApprove` is in flight.
 *
 * What the page does and does not do. It collects the typed secret and hands it to main (`nearGateSubmit`); MAIN checks it
 * with the server (the app's `verify-step-up` route) and only then tells the helper "approved". The page never learns a
 * verdict it could forward, so nothing here can approve a sign-in by itself; this component is just the keyboard.
 * Accounts with two-factor sign-in are asked for the authenticator / backup code, exactly like the app's other "Confirm it's
 * you" prompts (the server decides which; the spec only words the password case).
 *
 * The typed value lives only in this component's state and is cleared when the prompt closes.
 */
export const NearGatePrompt: React.FC = () => {
    const [prompt, setPrompt] = useState<GatePrompt | null>(null);
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const snap = useNearSession();
    const id = useId();
    const input = useRef<HTMLInputElement>(null);
    const device = safeLabel(snap?.peer?.label, 'New device');

    useEffect(() => {
        const api = nearBridge();
        if (typeof api?.onNearGatePrompt !== 'function') return;
        return api.onNearGatePrompt((p) => {
            if (p.closed) {
                setPrompt((cur) => (cur && cur.ticket === p.ticket ? null : cur));
                setValue(''); setBusy(false); setError(null);
            } else {
                setPrompt({ ticket: p.ticket, method: p.method });
                setValue(''); setBusy(false); setError(null);
            }
        });
    }, []);

    if (!prompt) return null;
    const totp = prompt.method === 'totp';

    const close = () => { setPrompt(null); setValue(''); setError(null); };
    const cancel = () => {
        if (busy) return;
        void nearBridge()?.nearGateCancel?.(prompt.ticket);
        close();
    };
    const submit = async () => {
        const api = nearBridge();
        if (!api?.nearGateSubmit || busy || value.trim().length === 0) return;
        setBusy(true); setError(null);
        let res: Awaited<ReturnType<NonNullable<typeof api.nearGateSubmit>>> = 'unavailable';
        try { res = await api.nearGateSubmit(prompt.ticket, value); } catch { res = 'unavailable'; }
        setBusy(false);
        if (res === 'ok' || res === 'locked' || res === 'expired') { close(); return; }
        setValue('');
        setError(res === 'rejected' ? nt('bio.pw.err') : nt('b.ap.bioFail'));
        requestAnimationFrame(() => input.current?.focus());
    };

    return (
        <ClModal open onClose={cancel} width={420} closeOnOverlay={false} label={nt('bio.pw.title')} cardClassName="dlg-card">
            <DialogHeader
                icon={<ShieldCheck size={19} strokeWidth={2.2} />}
                title={nt('bio.pw.title')}
                subtitle={totp
                    ? <>Enter a code from your authenticator app, or a backup code, to approve {device}.</>
                    : <>{nt('bio.pw.body', { device })}</>}
            />
            <DialogForm onSubmit={() => { void submit(); }}>
                <DialogBody>
                    <ClField label={totp ? 'Authenticator or backup code' : nt('bio.pw.label')} htmlFor={id}>
                        <ClInput
                            ref={input}
                            id={id}
                            type={totp ? 'text' : 'password'}
                            value={value}
                            onChange={(e) => { setValue(e.target.value); setError(null); }}
                            autoFocus
                            autoComplete={totp ? 'one-time-code' : 'current-password'}
                            spellCheck={false}
                            maxLength={totp ? 32 : 256}
                            disabled={busy}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={`${id}-err`}
                            data-testid="near-gate-input"
                            style={{ width: '100%' }}
                        />
                    </ClField>
                    <div id={`${id}-err`} className="dlg-field-error" role="alert" aria-live="assertive" style={{ marginTop: 8 }} data-testid="near-gate-error">
                        {error}
                    </div>
                </DialogBody>
                <DialogFooter hint={busy ? <>Checking…</> : <><Lock size={13} aria-hidden /> Never stored or saved</>}>
                    <ClButton type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>Cancel</ClButton>
                    <ClButton type="submit" size="sm" loading={busy} disabled={busy || value.trim().length === 0}>Confirm</ClButton>
                </DialogFooter>
            </DialogForm>
        </ClModal>
    );
};

export default NearGatePrompt;
