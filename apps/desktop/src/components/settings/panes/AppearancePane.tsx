import React, { useState, useEffect } from 'react';
import { Monitor, Rocket, PanelBottomClose, Image as ImageIcon, Snowflake, Sparkles } from 'lucide-react';
import { ClToggle } from '../../cl';
import type { GifSettingsHook } from '../../../hooks/useGifSettings';
import { useSeasonalEffects } from '../../../hooks/useSeasonalEffects';
import { useAmbientMotion } from '../../../hooks/useAmbientMotion';

/**
 * Surface · Appearance — Descent redesign (phase 4): sd-card sections with
 * icon-tile rows that dim when off. Same three OS toggles + GIF playback.
 */
interface AppearancePaneProps {
    gif: GifSettingsHook;
}

export const AppearancePane: React.FC<AppearancePaneProps> = ({ gif }) => {
    const [seasonalEffects, setSeasonalEffects] = useSeasonalEffects();
    const [ambientMotion, setAmbientMotion] = useAmbientMotion();

    const [startWithWindows, setStartWithWindowsState] = useState(false);
    // Default true — matches the main process's default ("minimized at login"
    // is on unless explicitly disabled), so the toggle doesn't flash off→on.
    const [startMinimized, setStartMinimizedState] = useState(true);
    const [minimizeToTray, setMinimizeToTrayState] = useState(false);

    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;
        api.getStartWithWindows?.().then(v => setStartWithWindowsState(v)).catch(() => {});
        api.getStartMinimized?.().then(v => setStartMinimizedState(v)).catch(() => {});
        api.getMinimizeToTray?.().then(v => setMinimizeToTrayState(v)).catch(() => {});
    }, []);

    const handleStartWithWindows = async (enabled: boolean) => {
        setStartWithWindowsState(enabled);
        await window.electronAPI?.setStartWithWindows?.(enabled);
    };
    const handleStartMinimized = async (enabled: boolean) => {
        setStartMinimizedState(enabled);
        await window.electronAPI?.setStartMinimized?.(enabled);
    };
    const handleMinimizeToTray = async (enabled: boolean) => {
        setMinimizeToTrayState(enabled);
        await window.electronAPI?.setMinimizeToTray?.(enabled);
    };

    const rows = [
        { icon: <Rocket size={16} />, label: 'Start with Windows', desc: 'Launch Cipherline automatically when you sign in to Windows.', checked: startWithWindows, onChange: handleStartWithWindows },
        { icon: <PanelBottomClose size={16} />, label: 'Start minimized', desc: 'When Cipherline starts with Windows, open to the taskbar instead of the window. Opening it yourself always shows the window.', checked: startMinimized, onChange: handleStartMinimized },
        { icon: <Monitor size={16} />, label: 'Minimize to tray', desc: 'Closing the window hides Cipherline to the system tray. Double-click the tray icon to reopen.', checked: minimizeToTray, onChange: handleMinimizeToTray },
    ];

    return (
        <>
            {window.electronAPI && (
                <div className="sd-card">
                    <h3>Around your OS</h3>
                    <p className="sd-sub">How the window behaves at startup and close.</p>
                    {rows.map((row, i) => (
                        <div key={row.label} className="sd-row" style={i === 0 ? { borderTop: 'none' } : undefined}>
                            <span className={`sd-tile${row.checked ? '' : ' sd-tile--dim'}`}>{row.icon}</span>
                            <div className="sd-rl">
                                <b>{row.label}</b>
                                <span>{row.desc}</span>
                            </div>
                            <div className="sd-rc">
                                <ClToggle checked={row.checked} onChange={row.onChange} />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Seasonal ambience */}
            <div className="sd-card">
                <h3>Seasonal ambience</h3>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className={`sd-tile${seasonalEffects ? '' : ' sd-tile--dim'}`}><Snowflake size={16} /></span>
                    <div className="sd-rl">
                        <b>Marine snow</b>
                        <span>Through December and the first week of January, the detritus that always drifts down here becomes visible. Off has no effect the rest of the year, and it never shows if your system asks for reduced motion.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={seasonalEffects} onChange={setSeasonalEffects} />
                    </div>
                </div>
                <div className="sd-row">
                    <span className={`sd-tile${ambientMotion ? '' : ' sd-tile--dim'}`}><Sparkles size={16} /></span>
                    <div className="sd-rl">
                        <b>Home ambience</b>
                        <span>Bioluminescent motes rise through the home screen, and small things breathe. Purely decorative — off freezes all of it, and it never shows if your system asks for reduced motion.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={ambientMotion} onChange={setAmbientMotion} />
                    </div>
                </div>
            </div>

            {/* GIF Playback */}
            <div className="sd-card">
                <h3>GIF playback</h3>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className={`sd-tile${gif.settings.autoPlayGifs ? '' : ' sd-tile--dim'}`}><ImageIcon size={16} /></span>
                    <div className="sd-rl">
                        <b>Automatically play GIFs</b>
                        <span>When off, GIFs freeze until you hover them — a play icon marks a paused GIF. They always pause when Cipherline loses focus.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={gif.settings.autoPlayGifs} onChange={v => gif.setAutoPlayGifs(v)} />
                    </div>
                </div>
            </div>
        </>
    );
};
