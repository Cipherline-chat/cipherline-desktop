import React from 'react';
import { FlaskConical } from 'lucide-react';
import { StagingPasswordForm } from './StagingPasswordForm';
import { STAGING_NON_TESTER_NOTE } from '../utils/stagingLock';

/**
 * Full-screen gate shown by main.tsx on a STAGING build (a packaged build
 * whose version carries `-staging`) until this device has been unlocked.
 *
 * Rendered INSTEAD of the app: main.tsx mounts this before AuthProvider and
 * everything under it, so nothing that talks to the server (auth refresh,
 * the WebSocket, subscription/notification fetches) exists until unlock.
 * The password check and the remembered unlock live in the main process
 * (electron/staging-lock.ts) — this is the UX on top.
 */
const StagingLockScreen: React.FC<{
    onUnlocked: () => void;
    initialRetryAfterMs?: number;
}> = ({ onUnlocked, initialRetryAfterMs }) => (
    <div
        className="font-sans"
        style={{
            width: '100vw', height: '100vh', background: 'var(--cl-abyss)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            position: 'relative',
        }}
    >
        {/* Frameless window: keep it draggable, as the app's own top bar does. */}
        <div
            aria-hidden
            style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 32, WebkitAppRegion: 'drag' } as React.CSSProperties}
        />
        <div style={{ width: '100%', maxWidth: 400 }}>
            <div style={{ textAlign: 'center', marginBottom: 22 }}>
                <div
                    style={{
                        width: 56, height: 56, borderRadius: 18, margin: '0 auto 16px',
                        background: 'rgba(255,201,77,0.10)', border: '1.5px solid rgba(255,201,77,0.28)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                >
                    <FlaskConical style={{ width: 26, height: 26, color: 'var(--cl-glow)' }} />
                </div>
                <h1 style={{ fontSize: 20, fontWeight: 800, color: 'var(--cl-text)', marginBottom: 8 }}>
                    Staging build
                </h1>
                <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-faint)' }}>
                    Enter the staging password to use this build. You’ll only need to do this once on this device.
                </p>
            </div>

            <div
                style={{
                    background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
                    borderRadius: 20, padding: 22, boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
                }}
            >
                <StagingPasswordForm onUnlocked={onUnlocked} initialRetryAfterMs={initialRetryAfterMs} />
            </div>

            <p style={{ marginTop: 18, fontSize: 12, lineHeight: 1.5, color: 'var(--cl-faint)', textAlign: 'center' }}>
                {STAGING_NON_TESTER_NOTE}
            </p>
        </div>
    </div>
);

export default StagingLockScreen;
