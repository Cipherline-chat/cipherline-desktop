import React, { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ClButton } from './ClButton';
import { restartApp } from '../utils/restartApp';

interface Props {
    /** Carry on without this device's stored data for this session. */
    onContinue: () => void;
    /**
     * What failed, as `<stage>/<ErrorName>` (utils/storeHealthReport.ts
     * storeFailureCode): labels only, so a user can screenshot it instead of
     * sending a report. Not shown when absent.
     */
    code?: string | null;
}

type HostPlatform = 'windows' | 'mac' | 'linux';

/** Where Electron keeps this app's data (app.getPath('userData'), app name "Cipherline"). */
const DATA_FOLDER: Record<HostPlatform, string> = {
    windows: '%APPDATA%\\Cipherline',
    mac: '~/Library/Application Support/Cipherline',
    linux: '~/.config/Cipherline',
};

/**
 * "If it keeps happening" steps, per platform. Short, calm, and nothing destructive.
 *
 * The quarantine step is for a failure that survives every restart: Chromium
 * keeps large records as separate files in the data folder, and one of those
 * files going missing or unreadable (an antivirus quarantine is the usual way,
 * on Windows) fails the read on every launch until the file is back.
 */
function readFailedTips(platform: HostPlatform): string[] {
    const quit = platform === 'mac'
        ? 'Quit Cipherline fully (⌘Q), then open it again.'
        : 'Quit Cipherline fully from its tray icon (right-click, Quit), then open it again.';
    const watcher = platform === 'windows'
        ? 'If antivirus or OneDrive scans your files, allow Cipherline’s data folder:'
        : platform === 'mac'
            ? 'If antivirus or a sync app scans your files, allow Cipherline’s data folder:'
            : 'If a sync or backup tool scans your files, allow Cipherline’s data folder:';
    const quarantine = platform === 'windows'
        ? 'Still happening? Check your antivirus’s quarantine (Windows Security: Protection history) for files from that folder, and restore them.'
        : platform === 'mac'
            ? 'Still happening? Check your antivirus or cleaner app for files it quarantined or removed from that folder, and restore them.'
            : 'Still happening? Check whether a cleaner, sync or backup tool moved or removed files in that folder, and restore them.';
    return [
        quit,
        'Make sure your disk has free space.',
        `${watcher} ${DATA_FOLDER[platform]}`,
        quarantine,
        'Don’t delete the app’s data or reinstall: your history is stored there.',
    ];
}

function hostPlatform(): HostPlatform {
    const p = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
    return p === 'mac' || p === 'linux' ? p : 'windows';
}

/**
 * Shown at boot when the encrypted store could not be read at all: the master key
 * is fine (or StorageLockedScreen would be showing), but the read or the decrypt
 * failed — after the store's own retries (utils/storeLoadRetry.ts) — so the app
 * cannot tell whether anyone is signed in.
 *
 * Deliberately has no recovery key and no reset, unlike its two neighbours:
 * nothing here is known to be damaged, and offering to start fresh over data that
 * is probably fine would be the one way to actually lose it. Continuing is always
 * available, so a failure that survives a retry cannot lock anyone out, and
 * secureLocalStore keeps what is on disk safe from that session.
 *
 * "Try again" RESTARTS the app rather than reloading the page: Chromium keeps
 * its IndexedDB backend for the life of the process, so a reload meets the same
 * failed backing store (see utils/restartApp.ts).
 */
const StorageReadFailedScreen: React.FC<Props> = ({ onContinue, code }) => {
    const [restarting, setRestarting] = useState(false);
    const tips = readFailedTips(hostPlatform());
    const retry = () => {
        if (restarting) return;
        setRestarting(true);
        void restartApp();
    };
    return (
        <div
            className="font-sans"
            style={{
                width: '100vw', height: '100vh', background: 'var(--cl-abyss)', overflowY: 'auto',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box',
            }}
        >
            <div style={{ width: '100%', maxWidth: 460, margin: 'auto' }}>
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                    <div
                        style={{
                            width: 56, height: 56, borderRadius: 18, margin: '0 auto 16px',
                            background: 'rgba(255,176,32,0.12)', border: '1.5px solid rgba(255,176,32,0.32)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                    >
                        <AlertTriangle style={{ width: 28, height: 28, color: 'var(--cl-glow-text)' }} />
                    </div>
                    <h1 style={{ fontSize: 20, fontWeight: 800, color: 'var(--cl-text)', marginBottom: 8 }}>
                        Couldn’t read your data on this device
                    </h1>
                    <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cl-faint)' }}>
                        Nothing was deleted. Restarting Cipherline is usually all it takes.
                    </p>
                    {code && (
                        <p
                            className="font-mono"
                            style={{ fontSize: 11, color: 'var(--cl-faint)', marginTop: 8, userSelect: 'text', overflowWrap: 'anywhere' }}
                        >
                            Code: {code}
                        </p>
                    )}
                </div>

                <div
                    style={{
                        background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
                        borderRadius: 20, padding: 22, boxShadow: '0 24px 60px rgb(var(--cl-shade-rgb) / 0.4)',
                    }}
                >
                    <ClButton fullWidth onClick={retry} disabled={restarting}>
                        {restarting ? <Loader2 className="animate-spin" style={{ width: 16, height: 16 }} aria-label="Restarting" /> : 'Restart and try again'}
                    </ClButton>
                    <p style={{ fontSize: 12, color: 'var(--cl-faint)', marginTop: 8, textAlign: 'center' }}>
                        Cipherline closes and opens again to read your data afresh.
                    </p>

                    <div style={{ marginTop: 16 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--cl-muted)', marginBottom: 6 }}>
                            If it keeps happening
                        </div>
                        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.5, color: 'var(--cl-faint)', listStyle: 'decimal' }}>
                            {tips.map(t => (
                                <li key={t} style={{ marginBottom: 4, overflowWrap: 'anywhere' }}>{t}</li>
                            ))}
                        </ol>
                    </div>

                    <div style={{ height: 1, background: 'var(--cl-border)', margin: '16px 0 14px' }} />

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
};

export default StorageReadFailedScreen;
