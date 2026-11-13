import React, { useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import { ClBanner } from './ClBanner';
import {
    dismissVideoEncodeDriverCard, fetchVideoEncodeDriverStatus, isVideoEncodeDriverCardDismissed, requestVideoEncodeDriverInstall,
    shouldShowVideoEncodeDriverCard, videoEncodeDriverOutcomeText, videoEncodeDriverTitle, type VideoEncodeDriverOutcome, type VideoEncodeDriverStatus,
} from '../utils/videoEncodeDriver';

/**
 * Linux + Intel/AMD whose VA-API driver can decode but not encode (Ubuntu/Debian Intel free build, Fedora without RPM Fusion): a one-time,
 * dismissible card offering the encoder driver, with the exact command (and the repository it needs) as the fallback. Same pattern as
 * NvidiaVaapiBanner; main never reports both at once. Self-gating: nothing elsewhere, once dismissed, or with an older preload.
 * See utils/videoEncodeDriver.ts and electron/video-encode-driver.ts.
 */
export const VideoEncodeDriverBanner: React.FC = () => {
    const [status, setStatus] = useState<VideoEncodeDriverStatus | null>(null);
    const [dismissed, setDismissed] = useState<boolean>(() => isVideoEncodeDriverCardDismissed());
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<VideoEncodeDriverOutcome | null>(null);

    useEffect(() => {
        if (window.electronAPI?.platform !== 'linux') return;
        let alive = true;
        void fetchVideoEncodeDriverStatus().then(s => { if (alive) setStatus(s); });
        return () => { alive = false; };
    }, []);

    if (!status || !shouldShowVideoEncodeDriverCard(status, dismissed)) return null;

    const install = () => {
        setBusy(true);
        void requestVideoEncodeDriverInstall().then(r => { setBusy(false); setOutcome(r.outcome); setStatus(r.status); });
    };
    const close = () => { dismissVideoEncodeDriverCard(); setDismissed(true); };
    const copy = () => { try { void navigator.clipboard?.writeText(status.command); } catch { /* no clipboard */ } };

    const showCommand = status.state === 'install' && outcome !== 'installed' && outcome !== 'busy';
    const note = outcome ? videoEncodeDriverOutcomeText(outcome, status)
        : status.state === 'install' ? 'Your graphics driver can play video but not encode it, so shares are encoded by the CPU.' : null;

    return (
        <ClBanner
            id="video-encode-driver"
            tone="info"
            priority={39}
            testId="video-encode-driver-banner"
            icon={<Cpu size={15} />}
            title={videoEncodeDriverTitle(status)}
            description={<>
                {note}
                {showCommand && status.repoHint && outcome !== 'not_found' && <> {status.repoHint}</>}
                {showCommand && <> <code className="sd-mono">{status.command}</code></>}
            </>}
            actions={[
                ...(status.state === 'install' && status.canInstall ? [{ key: 'install', label: 'Install', onClick: install, loading: busy }] : []),
                ...(showCommand ? [{ key: 'copy', label: 'Copy command', onClick: copy, variant: 'ghost' as const }] : []),
                ...(status.state === 'restart' ? [{ key: 'restart', label: 'Restart', onClick: () => { void window.electronAPI?.relaunchApp?.(); } }] : []),
            ]}
            dismissLabel="Not now"
            onDismiss={close}
        />
    );
};

export default VideoEncodeDriverBanner;
