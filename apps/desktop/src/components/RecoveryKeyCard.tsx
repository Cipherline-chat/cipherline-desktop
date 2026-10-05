import React, { useState } from 'react';
import { KeyRound, Copy, Check, Eye, AlertTriangle } from 'lucide-react';
import { ClButton } from './ClButton';

/**
 * Lets the user reveal and copy their device storage recovery key so they can
 * stash it in a password manager. That key is the ONLY way to unlock this
 * device's encrypted data (message history, settings, identity) if the OS
 * secure storage is ever reset — see StorageLockedScreen for the unlock flow.
 */
const RecoveryKeyCard: React.FC = () => {
    const [revealed, setRevealed] = useState('');
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');

    // The main process asks for confirmation before it parts with the key —
    // see electron/recovery-key-gate.ts. A `declined` result is the user
    // answering that dialog, not a failure: say nothing and leave the button
    // where they can try again.
    const reveal = async () => {
        setBusy(true); setError('');
        try {
            const res = await window.electronAPI?.revealRecoveryKey?.();
            if (!res) setError('Recovery key is unavailable on this device.');
            else if (res.ok) setRevealed(res.keyB64);
            else if (res.reason === 'locked') setError('Recovery key is unavailable on this device.');
            // 'declined' / 'busy' — no error state; the dialog already spoke.
        } catch {
            setError('Could not read the recovery key.');
        } finally {
            setBusy(false);
        }
    };

    const copy = async () => {
        try {
            await (window.electronAPI?.writeClipboard?.(revealed) ?? navigator.clipboard.writeText(revealed));
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch { /* clipboard blocked — user can select manually */ }
    };

    return (
        <div className="rounded-xl p-4 border" style={{ background: 'rgba(37,224,200,.03)', borderColor: 'var(--cl-border)' }}>
            <div className="flex items-start gap-3">
                <div
                    className="flex items-center justify-center flex-shrink-0"
                    style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(37,224,200,0.1)', border: '1px solid rgba(37,224,200,0.2)' }}
                >
                    <KeyRound size={17} style={{ color: 'var(--cl-lume)' }} />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold" style={{ color: 'var(--cl-text)' }}>Storage Recovery Key</p>
                    <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--cl-faint)' }}>
                        Save this in your password manager. It’s the only way to unlock your data on this
                        device if your computer’s secure storage is ever reset (OS reinstall, keyring reset,
                        new machine) and you have no other device or backup.
                    </p>

                    {!revealed ? (
                        <div className="mt-3">
                            <ClButton size="sm" variant="ghost" onClick={reveal} disabled={busy}>
                                <Eye size={14} /> {busy ? 'Revealing…' : 'Reveal recovery key'}
                            </ClButton>
                            {error && <p className="text-xs mt-2" style={{ color: 'var(--cl-flash)' }}>{error}</p>}
                        </div>
                    ) : (
                        <div className="mt-3">
                            <div
                                className="flex items-center gap-2 rounded-lg px-3 py-2"
                                style={{ background: 'var(--cl-surface)', border: '1px solid var(--cl-border)' }}
                            >
                                <code
                                    className="flex-1 min-w-0 text-xs break-all"
                                    style={{ color: 'var(--cl-text)', fontFamily: "'JetBrains Mono','SFMono-Regular',Consolas,monospace" }}
                                >
                                    {revealed}
                                </code>
                                <ClButton size="sm" variant="ghost" onClick={copy}>
                                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                                </ClButton>
                            </div>
                            <div className="flex items-start gap-1.5 mt-2">
                                <AlertTriangle size={13} style={{ color: 'var(--cl-glow)', marginTop: 1, flexShrink: 0 }} />
                                <p className="text-xs leading-relaxed" style={{ color: 'var(--cl-glow)' }}>
                                    Anyone with this key can decrypt your local data. Store it somewhere only you control.
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default RecoveryKeyCard;
