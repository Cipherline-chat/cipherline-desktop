import React, { useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import { ClBanner } from './ClBanner';
import {
    dismissNvidiaVaapiCard, fetchNvidiaVaapiStatus, isNvidiaVaapiCardDismissed, nvidiaVaapiOutcomeText,
    requestNvidiaVaapiInstall, shouldShowNvidiaVaapiCard, type NvidiaVaapiOutcome, type NvidiaVaapiStatus,
} from '../utils/nvidiaVaapi';

/**
 * Linux + NVIDIA (proprietary driver) with the VA-API video driver missing: a one-time, dismissible card offering to
 * install it (PackageKit asks the system for a password; we never run a package manager) with the exact command as the
 * fallback. Self-gating: renders nothing elsewhere, for AMD/Intel, when the driver is present, once dismissed, or with a
 * preload that predates the bridge. See utils/nvidiaVaapi.ts and electron/nvidia-vaapi-install.ts.
 */
export const NvidiaVaapiBanner: React.FC = () => {
    const [status, setStatus] = useState<NvidiaVaapiStatus | null>(null);
    const [dismissed, setDismissed] = useState<boolean>(() => isNvidiaVaapiCardDismissed());
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<NvidiaVaapiOutcome | null>(null);

    useEffect(() => {
        if (window.electronAPI?.platform !== 'linux') return;
        let alive = true;
        void fetchNvidiaVaapiStatus().then(s => { if (alive) setStatus(s); });
        return () => { alive = false; };
    }, []);

    if (!status || !shouldShowNvidiaVaapiCard(status, dismissed)) return null;

    const install = () => {
        setBusy(true);
        void requestNvidiaVaapiInstall().then(r => { setBusy(false); setOutcome(r.outcome); setStatus(r.status); });
    };
    const close = () => { dismissNvidiaVaapiCard(); setDismissed(true); };
    const copy = () => { try { void navigator.clipboard?.writeText(status.command); } catch { /* no clipboard */ } };

    const title = status.state === 'restart' ? 'Restart Cipherline to use the NVIDIA video driver' : 'Install the NVIDIA video driver for smoother viewing of shares and cameras';
    const note = outcome ? nvidiaVaapiOutcomeText(outcome, status) : (status.state === 'modeset' ? status.modesetNote : null);
    const showCommand = status.state === 'install' && (outcome === null || outcome === 'not_found' || outcome === 'unavailable' || outcome === 'failed' || outcome === 'denied');

    return (
        <ClBanner
            id="nvidia-vaapi-driver"
            tone="info"
            priority={40}
            testId="nvidia-vaapi-banner"
            icon={<Cpu size={15} />}
            title={title}
            description={<>
                {note ?? (status.state === 'install' ? 'Your NVIDIA card can decode other people’s video, but the driver for it isn’t installed.' : null)}
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

export default NvidiaVaapiBanner;
