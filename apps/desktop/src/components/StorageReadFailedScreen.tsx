import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { ClButton } from './ClButton';

interface Props {
    /** Carry on without this device's stored data for this session. */
    onContinue: () => void;
}

/**
 * Shown at boot when the encrypted store could not be read at all: the master key
 * is fine (or StorageLockedScreen would be showing), but the read or the decrypt
 * failed, so the app cannot tell whether anyone is signed in.
 *
 * Deliberately has no recovery key and no reset, unlike its two neighbours:
 * nothing here is known to be damaged, and offering to start fresh over data that
 * is probably fine would be the one way to actually lose it. Continuing is always
 * available, so a failure that survives a retry cannot lock anyone out, and
 * secureLocalStore keeps what is on disk safe from that session.
 */
const StorageReadFailedScreen: React.FC<Props> = ({ onContinue }) => (
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
                    Couldn’t read your data on this device
                </h1>
                <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-faint)' }}>
                    Nothing was deleted. Trying again is usually all it takes.
                </p>
            </div>

            <div
                style={{
                    background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
                    borderRadius: 20, padding: 22, boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
                }}
            >
                <ClButton fullWidth onClick={() => window.location.reload()}>
                    Try again
                </ClButton>

                <div style={{ height: 1, background: 'var(--cl-border)', margin: '18px 0 16px' }} />

                <p style={{ fontSize: 12, color: 'var(--cl-faint)', marginBottom: 10, lineHeight: 1.5 }}>
                    If you continue, you’ll need to sign in, your history won’t show, and nothing you
                    change will be saved on this device. Your stored data stays as it is for next time.
                </p>
                <ClButton fullWidth variant="ghost" onClick={onContinue}>
                    Continue anyway
                </ClButton>
            </div>
        </div>
    </div>
);

export default StorageReadFailedScreen;
