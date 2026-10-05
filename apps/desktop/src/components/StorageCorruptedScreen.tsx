import React, { useState } from 'react';
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react';
import { ClButton } from './ClButton';
import secureLocalStore from '../utils/secureLocalStore';

interface Props {
    /** The name of the moved-aside corrupt file, e.g. secure-store.json.corrupt-1717000000000. */
    backupFileName: string;
}

/**
 * Phase 7 / device sprawl. Shown at boot when this device's local
 * Signal-identity store (electron/storage.ts's SecureStore) had an
 * unparseable secure-store.json — an interrupted write, disk error, or
 * manual tampering. Distinct from StorageLockedScreen: the master key
 * unwrapped FINE here, only the data envelope was unreadable. Before this
 * screen existed, the app just silently treated this as a first launch and
 * minted a brand-new device identity — every existing conversation partner
 * would see this device as an unfamiliar one with no explanation, and if the
 * user had synced a recovery key from another device there was no chance to
 * use it before that happened.
 *
 * The corrupt file itself is preserved on disk under `backupFileName` (never
 * deleted) in case the user wants to hand it to support, but its content
 * can't be parsed as JSON, so there's nothing left to validate a recovery
 * key against — entering one here re-keys this device going forward
 * (keeping it consistent with other devices sharing the same recovery key)
 * rather than restoring lost data, which is genuinely gone.
 */
const StorageCorruptedScreen: React.FC<Props> = ({ backupFileName }) => {
    const [key, setKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [confirmingFresh, setConfirmingFresh] = useState(false);

    const recover = async () => {
        const candidate = key.trim();
        if (!candidate) { setError('Paste your recovery key.'); return; }
        setBusy(true); setError('');
        try {
            const ok = await window.electronAPI?.recoverWithKey?.(candidate);
            if (ok) {
                window.location.reload();
                return;
            }
            setError('That recovery key doesn’t look right. Check for missing characters and try again.');
        } catch {
            setError('Could not apply that key. Please try again.');
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
                        <AlertTriangle style={{ width: 28, height: 28, color: 'var(--cl-glow)' }} />
                    </div>
                    <h1 style={{ fontSize: 20, fontWeight: 800, color: 'var(--cl-text)', marginBottom: 8 }}>
                        Local storage looks corrupted
                    </h1>
                    <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-faint)' }}>
                        This device's encrypted identity file couldn't be read — usually caused by an
                        interrupted write or a disk issue. We saved a copy as{' '}
                        <span style={{ fontFamily: "'JetBrains Mono','SFMono-Regular',Consolas,monospace" }}>{backupFileName}</span>.
                        If you have a recovery key from another device, enter it now to keep this device in sync.
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
                        Recovery key (optional)
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

                    <ClButton fullWidth onClick={recover} disabled={busy || !key.trim()}>
                        {busy ? <Loader2 className="animate-spin" size={16} /> : 'Use recovery key'}
                    </ClButton>

                    <div style={{ height: 1, background: 'var(--cl-border)', margin: '18px 0 16px' }} />

                    {!confirmingFresh ? (
                        <>
                            <p style={{ fontSize: 12, color: 'var(--cl-faint)', marginBottom: 10, lineHeight: 1.5 }}>
                                No recovery key? Continue and this device will register as new — your
                                other devices and contacts are unaffected.
                            </p>
                            <ClButton fullWidth variant="ghost" onClick={() => setConfirmingFresh(true)} disabled={busy}>
                                Continue without a recovery key
                            </ClButton>
                        </>
                    ) : (
                        <>
                            <p style={{ fontSize: 12.5, color: 'var(--cl-flash)', marginBottom: 10, lineHeight: 1.5, fontWeight: 600 }}>
                                This device will start over with a fresh identity. Message history stored ONLY
                                on this device is not recoverable this way — restore a backup afterward if you have one.
                            </p>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <ClButton fullWidth variant="ghost" onClick={() => setConfirmingFresh(false)} disabled={busy}>
                                    Cancel
                                </ClButton>
                                <ClButton fullWidth variant="danger" onClick={startFresh} disabled={busy}>
                                    {busy ? <Loader2 className="animate-spin" size={16} /> : 'Continue'}
                                </ClButton>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default StorageCorruptedScreen;
