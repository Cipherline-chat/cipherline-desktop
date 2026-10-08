/**
 * Settings → Voice & Video → While gaming → "Prioritize call video while
 * gaming". OFF by default. The setting lives in main (startup-flags.json —
 * see utils/gamingVideoMode.ts for why and for what each layer does); this
 * card reads and writes it through that store, so the in-call offer and this
 * toggle can never disagree.
 *
 * Part of it applies at once (process priority during calls, the camera's
 * frame-rate preference) and part on the next launch (Chromium switches), so
 * the card says which, and offers the restart. Renders nothing outside
 * Electron or against a main process that predates the setting.
 */
import React, { useEffect, useState } from 'react';
import { Gamepad2, RefreshCw } from 'lucide-react';
import { ClButton, ClToggle } from '../cl';
import {
    useGamingVideoMode, loadGamingVideoMode, setGamingVideoMode,
    GAMING_VIDEO_LABEL, gamingVideoDescription, gamingVideoRestartCopy,
} from '../../utils/gamingVideoMode';

export const GamingVideoSetting: React.FC = () => {
    const mode = useGamingVideoMode();
    const [saving, setSaving] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { void loadGamingVideoMode(true); }, []);

    if (!mode.available) return null;

    const toggle = async (on: boolean) => {
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
            await setGamingVideoMode(on);
        } catch (err) {
            console.warn('[GamingVideoSetting] save failed:', err);
            setError('Could not save this setting.');
        } finally {
            setSaving(false);
        }
    };

    const restart = async () => {
        const api = window.electronAPI;
        if (!api?.relaunchApp) {
            setError('Restart isn’t available in this build — quit and reopen Cipherline.');
            return;
        }
        setRestarting(true);
        setError(null);
        try {
            await api.relaunchApp();
        } catch (err) {
            console.warn('[GamingVideoSetting] relaunch failed:', err);
            setRestarting(false);
            setError('Could not restart automatically — quit and reopen Cipherline.');
        }
    };

    const restartCopy = gamingVideoRestartCopy(mode.enabled, mode.restartPending);

    return (
        <div className="sd-card">
            <h3>While gaming</h3>
            <div className="sd-row" style={{ borderTop: 'none' }}>
                <div className="sd-rl">
                    <b className="flex items-center gap-2"><Gamepad2 size={14} style={{ color: 'var(--cl-faint)' }} /> {GAMING_VIDEO_LABEL}</b>
                    <span>{gamingVideoDescription(mode.platform)}</span>
                </div>
                <div className="sd-rc">
                    <ClToggle
                        checked={mode.enabled}
                        disabled={saving}
                        onChange={v => { void toggle(v); }}
                        aria-label={GAMING_VIDEO_LABEL}
                    />
                </div>
            </div>
            {restartCopy && (
                <div className="mt-3 flex items-center gap-2.5 px-3 py-2.5 rounded-xl" role="status" style={{ background: 'rgba(255,201,77,.08)', border: '1px solid rgba(255,201,77,.2)' }}>
                    <RefreshCw size={14} className="shrink-0" style={{ color: 'var(--cl-glow)' }} aria-hidden />
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--cl-glow)', flex: 1, margin: 0 }}>
                        {restartCopy} Restarting ends any call you’re in.
                    </p>
                    <ClButton size="sm" variant="primary" loading={restarting} disabled={restarting} onClick={restart}>
                        Restart now
                    </ClButton>
                </div>
            )}
            {error && (
                <p className="text-xs mt-2" role="alert" style={{ color: 'var(--cl-danger)', margin: 0 }}>{error}</p>
            )}
        </div>
    );
};

export default GamingVideoSetting;
