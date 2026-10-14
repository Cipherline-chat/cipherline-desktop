import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MonitorX } from 'lucide-react';
import { ClButton } from '../cl';
import { useEscape } from '../../hooks/useEscape';
import { dismissGpuRestartPrompt, useGpuRestartPrompt } from '../../utils/gpuRecovery';
import './reportProblem.css';

/**
 * "Video stopped after a graphics driver reset — Restart Cipherline to fix."
 *
 * Shown by utils/gpuRecovery.ts when a call's video is still frozen ~10 s
 * after every in-app recovery step following a GPU process restart. Same
 * floating card as CrashPrompt (never a modal over the call). "Restart
 * Cipherline" goes through the normal relaunch (main's `app:relaunch`: a
 * real quit — the unclean-exit marker is cleared, nothing is recorded as a
 * crash — then Electron's relauncher), after `onBeforeRelaunch` has put the
 * call's rejoin record on disk, so the relaunched app OFFERS the call back
 * ("Rejoin call?" — one click). It never rejoins on its own: an automatic
 * re-entry would open the mic in a room (callRejoinWiring.test.ts).
 */
export const GpuRestartPrompt: React.FC<{
    /** Still in the call right now (the copy promises a rejoin only then). */
    inCall: boolean;
    /** Persist what the relaunched app needs to rejoin. Must not throw. */
    onBeforeRelaunch: () => Promise<void>;
}> = ({ inCall, onBeforeRelaunch }) => {
    const prompt = useGpuRestartPrompt();
    const [busy, setBusy] = useState(false);
    const primaryRef = useRef<HTMLDivElement>(null);
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    const canRelaunch = typeof api?.relaunchApp === 'function';

    useEffect(() => {
        if (!prompt) return;
        const t = setTimeout(() => primaryRef.current?.querySelector<HTMLButtonElement>('button')?.focus(), 350);
        return () => clearTimeout(t);
    }, [prompt]);

    useEscape(() => dismissGpuRestartPrompt(), !!prompt && !busy);

    if (!prompt) return null;
    const rejoin = inCall && prompt.inCall;

    const restart = async () => {
        if (busy || !api?.relaunchApp) return;
        setBusy(true);
        try {
            if (rejoin) await onBeforeRelaunch().catch(() => {});
            await api.relaunchApp();
        } catch (e) {
            console.warn('[GPU] relaunch failed:', e);
            setBusy(false);
        }
    };

    return createPortal(
        <div className="cl-kit" style={{ display: 'contents' }}>
            <div className="rp-prompt" role="alertdialog" aria-labelledby="gpu-restart-title" aria-describedby="gpu-restart-desc">
                <div className="rp-prompt-head">
                    <div className="rp-tile rp-tile--flash" style={{ width: 38, height: 38, borderRadius: 12 }} aria-hidden><MonitorX size={18} /></div>
                    <div style={{ minWidth: 0 }}>
                        <h3 id="gpu-restart-title">Video stopped after a graphics driver reset</h3>
                        <p id="gpu-restart-desc">
                            {canRelaunch ? 'Restart Cipherline to fix it.' : 'Quit and reopen Cipherline to fix it.'}
                            {rejoin && canRelaunch ? ' You’ll be able to rejoin this call right after.' : ''}
                        </p>
                    </div>
                </div>
                <div className="rp-prompt-actions">
                    <ClButton variant="ghost" onClick={dismissGpuRestartPrompt} disabled={busy}>Not now</ClButton>
                    {canRelaunch && (
                        <div ref={primaryRef} style={{ display: 'contents' }}>
                            <ClButton onClick={() => { void restart(); }} disabled={busy}>
                                {busy ? 'Restarting…' : 'Restart Cipherline'}
                            </ClButton>
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default GpuRestartPrompt;
