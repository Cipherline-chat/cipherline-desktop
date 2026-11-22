import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Shown at boot only while the encrypted store is retrying a load that failed
 * for a reason that usually clears in seconds (see utils/storeLoadRetry.ts) —
 * instead of flashing StorageReadFailedScreen on the first refusal. A normal
 * launch never sees it: main.tsx renders it on the first retry, not before.
 */
const StorageOpeningScreen: React.FC = () => (
    <div
        className="font-sans"
        role="status"
        aria-live="polite"
        style={{
            width: '100vw', height: '100vh', background: 'var(--cl-abyss)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        }}
    >
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
            <Loader2
                className="animate-spin"
                aria-hidden
                style={{ width: 28, height: 28, color: 'var(--cl-glow-text)', margin: '0 auto 14px', display: 'block' }}
            />
            <h1 style={{ fontSize: 17, fontWeight: 800, color: 'var(--cl-text)', marginBottom: 6 }}>
                Opening your data…
            </h1>
            <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-faint)' }}>
                This is taking a little longer than usual.
            </p>
        </div>
    </div>
);

export default StorageOpeningScreen;
