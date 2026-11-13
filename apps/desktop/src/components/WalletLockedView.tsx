import React, { useState } from 'react';
import { KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { ClButton } from './ClButton';
import { walletScreenCopy, type KeyringStatus } from '../utils/walletPrompt';

/**
 * Shown (by StorageLockedScreen) when the encrypted storage is locked because
 * the user did not unlock their system wallet (KDE Wallet / GNOME Keyring) at
 * startup. It says what happened in plain words and offers the one thing that
 * fixes it: "Try again", which relaunches Cipherline so the OS asks for the
 * wallet password again.
 *
 * Deliberately NOT here: "Start fresh". The data is intact and only the wallet
 * is closed, so erasing it would be destroying something recoverable; the main
 * process refuses a reset while the wallet is refused anyway. The recovery-key
 * path stays (secondary): it keeps this session going without the wallet, and
 * the "Unlock wallet" banner stays up until the wallet is unlocked.
 *
 * Zero writes to the store from this screen, same as the generic locked screen.
 */
export const WalletLockedView: React.FC<{ status: KeyringStatus }> = ({ status }) => {
    const copy = walletScreenCopy(status);
    const [retrying, setRetrying] = useState(false);
    const [retryFailed, setRetryFailed] = useState(false);
    const [showRecovery, setShowRecovery] = useState(false);
    const [key, setKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const tryAgain = () => {
        setRetrying(true); setRetryFailed(false);
        void (window.electronAPI?.retryKeyringUnlock?.() ?? Promise.resolve(false))
            .then(ok => { if (!ok) { setRetrying(false); setRetryFailed(true); } })
            .catch(() => { setRetrying(false); setRetryFailed(true); });
    };

    const useRecoveryKey = async () => {
        const candidate = key.trim();
        if (!candidate) { setError('Paste your recovery key.'); return; }
        setBusy(true); setError('');
        try {
            const ok = await window.electronAPI?.recoverWithKey?.(candidate);
            if (ok) { window.location.reload(); return; }
            setError('That recovery key didn’t work. Check for missing characters, or unlock your wallet instead.');
        } catch {
            setError('Could not use that key. Please try again.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="font-sans"
            data-testid="wallet-locked-screen"
            style={{
                width: '100vw', height: '100vh', background: 'var(--cl-abyss)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            }}
        >
            <div style={{ width: '100%', maxWidth: 460 }}>
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
                    <h1 style={{ fontSize: 20, fontWeight: 800, color: 'var(--cl-text)', marginBottom: 8 }}>{copy.title}</h1>
                    <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-faint)', marginBottom: 8 }}>{copy.body}</p>
                    <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-muted)' }}>{copy.consequence}</p>
                    {copy.autoRetryNote && (
                        <p data-testid="wallet-auto-retry-note" style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-muted)', marginTop: 8 }}>{copy.autoRetryNote}</p>
                    )}
                </div>

                <div
                    style={{
                        background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
                        borderRadius: 20, padding: 22, boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
                    }}
                >
                    {retryFailed && (
                        <div
                            role="alert"
                            style={{
                                marginBottom: 14, padding: '10px 12px', borderRadius: 12, fontSize: 12.5,
                                background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.28)',
                                color: 'var(--cl-flash)',
                            }}
                        >
                            Couldn{'’'}t restart Cipherline. Close it and open it again to be asked for your password.
                        </div>
                    )}
                    <ClButton fullWidth onClick={tryAgain} disabled={retrying || busy}>
                        {retrying ? <Loader2 className="animate-spin" size={16} /> : copy.tryAgain}
                    </ClButton>

                    <div style={{ height: 1, background: 'var(--cl-border)', margin: '18px 0 16px' }} />

                    {!showRecovery ? (
                        <ClButton fullWidth variant="ghost" onClick={() => setShowRecovery(true)} disabled={retrying}>
                            {copy.useRecoveryKey}
                        </ClButton>
                    ) : (
                        <>
                            <p style={{ fontSize: 12, color: 'var(--cl-faint)', marginBottom: 10, lineHeight: 1.5 }}>
                                Paste the recovery key you saved. Cipherline will open this session with it; your wallet stays locked until you unlock it.
                            </p>
                            {error && (
                                <div
                                    role="alert"
                                    style={{
                                        marginBottom: 12, padding: '10px 12px', borderRadius: 12, fontSize: 12.5,
                                        background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.28)',
                                        color: 'var(--cl-flash)',
                                    }}
                                >
                                    {error}
                                </div>
                            )}
                            <div style={{ position: 'relative', marginBottom: 12 }}>
                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', display: 'flex', color: 'var(--cl-faint)' }}>
                                    <KeyRound size={15} />
                                </span>
                                <textarea
                                    value={key}
                                    onChange={e => setKey(e.target.value)}
                                    placeholder="Paste the recovery key you saved"
                                    aria-label="Recovery key"
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
                            <ClButton fullWidth variant="ghost" onClick={useRecoveryKey} disabled={busy || !key.trim()}>
                                {busy ? <Loader2 className="animate-spin" size={16} /> : 'Continue with this key'}
                            </ClButton>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default WalletLockedView;
