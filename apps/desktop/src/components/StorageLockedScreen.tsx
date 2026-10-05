import React, { useState } from 'react';
import { ShieldAlert, KeyRound, Loader2 } from 'lucide-react';
import { ClButton } from './ClButton';
import secureLocalStore from '../utils/secureLocalStore';

/**
 * Shown at boot when the device's encrypted storage exists but its master key
 * cannot be unlocked by the OS keystore (e.g. the user reinstalled the OS, reset
 * their login keyring, or moved the profile to a new machine). The data on disk
 * is intact but unreadable until the user supplies their recovery key.
 *
 * Two paths:
 *   1. Enter recovery key — the base64 key they saved in a password manager.
 *      We validate + re-wrap it with this device's keystore, then reload.
 *   2. Start fresh — wipe the local encrypted store + re-key, then sign in
 *      again (and optionally restore a backup during the normal login flow).
 *
 * We deliberately perform NO writes to the encrypted store while locked, so a
 * wrong guess never destroys the still-recoverable ciphertext.
 */
const StorageLockedScreen: React.FC = () => {
    const [key, setKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [confirmingFresh, setConfirmingFresh] = useState(false);

    const unlock = async () => {
        const candidate = key.trim();
        if (!candidate) { setError('Paste your recovery key.'); return; }
        setBusy(true); setError('');
        try {
            const ok = await window.electronAPI?.recoverWithKey?.(candidate);
            if (ok) {
                // Reload so the boot gate re-hydrates with the now-unlocked key.
                window.location.reload();
                return;
            }
            setError('That recovery key is incorrect. Check for missing characters and try again.');
        } catch {
            setError('Could not unlock. Please try again.');
        } finally {
            setBusy(false);
        }
    };

    const startFresh = async () => {
        setBusy(true); setError('');
        try {
            await window.electronAPI?.factoryResetSecureStore?.();
            await secureLocalStore.wipeLocalData();
            window.location.reload();
        } catch {
            setError('Could not reset local data. Please try again.');
            setBusy(false);
        }
    };

    return (
        <div
            className="font-sans"
            style={{
                width: '100vw', height: '100vh', background: 'var(--cl-abyss)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            }}
        >
            <div style={{ width: '100%', maxWidth: 440 }}>
                <div style={{ textAlign: 'center', marginBottom: 22 }}>
                    <div
                        style={{
                            width: 56, height: 56, borderRadius: 18, margin: '0 auto 16px',
                            background: 'rgba(255,176,32,0.12)', border: '1.5px solid rgba(255,176,32,0.32)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                    >
                        <ShieldAlert style={{ width: 28, height: 28, color: 'var(--cl-glow)' }} />
                    </div>
                    <h1 style={{ fontSize: 20, fontWeight: 800, color: 'var(--cl-text)', marginBottom: 8 }}>
                        Storage couldn’t be unlocked
                    </h1>
                    <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-faint)' }}>
                        Your encrypted data is still on this device, but this computer’s secure storage
                        couldn’t open it — this happens after an OS reinstall, a keyring reset, or moving
                        to a new machine. Enter your recovery key to unlock it.
                    </p>
                </div>

                <div
                    style={{
                        background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
                        borderRadius: 20, padding: 22, boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
                    }}
                >
                    {error && (
                        <div
                            style={{
                                marginBottom: 14, padding: '10px 12px', borderRadius: 12, fontSize: 12.5,
                                background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.28)',
                                color: 'var(--cl-flash)',
                            }}
                        >
                            {error}
                        </div>
                    )}

                    <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--cl-muted)', display: 'block', marginBottom: 8 }}>
                        Recovery key
                    </label>
                    <div style={{ position: 'relative', marginBottom: 14 }}>
                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', display: 'flex', color: 'var(--cl-faint)' }}>
                            <KeyRound size={15} />
                        </span>
                        <textarea
                            value={key}
                            onChange={e => setKey(e.target.value)}
                            placeholder="Paste the recovery key you saved"
                            spellCheck={false}
                            rows={2}
                            disabled={busy}
                            style={{
                                width: '100%', resize: 'none',
                                background: 'var(--cl-surface)', border: '1.5px solid var(--cl-border)',
                                borderRadius: 13, padding: '10px 12px 10px 34px',
                                color: 'var(--cl-text)', fontSize: 13,
                                fontFamily: "'JetBrains Mono','SFMono-Regular',Consolas,monospace",
                                outline: 'none', lineHeight: 1.5,
                            }}
                        />
                    </div>

                    <ClButton fullWidth onClick={unlock} disabled={busy || !key.trim()}>
                        {busy ? <Loader2 className="animate-spin" size={16} /> : 'Unlock'}
                    </ClButton>

                    <div style={{ height: 1, background: 'var(--cl-border)', margin: '18px 0 16px' }} />

                    {!confirmingFresh ? (
                        <>
                            <p style={{ fontSize: 12, color: 'var(--cl-faint)', marginBottom: 10, lineHeight: 1.5 }}>
                                No recovery key? You can start fresh — this device’s local data is erased and
                                you sign in again (restore a backup afterward if you have one).
                            </p>
                            <ClButton fullWidth variant="ghost" onClick={() => setConfirmingFresh(true)} disabled={busy}>
                                Start fresh
                            </ClButton>
                        </>
                    ) : (
                        <>
                            <p style={{ fontSize: 12.5, color: 'var(--cl-flash)', marginBottom: 10, lineHeight: 1.5, fontWeight: 600 }}>
                                This permanently erases the encrypted data on this device. This can’t be undone.
                            </p>
                            {/* Intrinsic width, not fullWidth-both: "Erase & start
                                fresh" split to half this card's ~194px would sit
                                within single-digit pixels of its own ellipsis
                                fallback - fine most of the time, not acceptable
                                for the label on an irreversible erase. Same
                                pattern as the "Leave & Join" call popup. */}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                                <ClButton variant="ghost" onClick={() => setConfirmingFresh(false)} disabled={busy}>
                                    Cancel
                                </ClButton>
                                <ClButton variant="danger" onClick={startFresh} disabled={busy}>
                                    {busy ? <Loader2 className="animate-spin" size={16} /> : 'Erase & start fresh'}
                                </ClButton>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default StorageLockedScreen;
