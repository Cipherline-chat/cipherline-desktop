import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ClButton } from '../cl';
import { APP_VERSION } from '../../constants';
import { SeaBackdrop } from './SeaBackdrop';
import { DepthGauge, ZONES, zoneOf } from './DepthGauge';
import { ProfilePane } from './panes/ProfilePane';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { useEscape } from '../../hooks/useEscape';
import { setOccluded } from '../../utils/idleMotion';
import { AppearancePane } from './panes/AppearancePane';
import { DevicesPane } from './panes/DevicesPane';
import { DangerPane } from './panes/DangerPane';
import AdvancedSettings from '../AdvancedSettings';
import { StorageSettings } from '../StorageSettings';
import { KeybindSettings } from '../KeybindSettings';
import { VoiceVideoSettings } from '../VoiceVideoSettings';
import GameActivitySettings from '../GameActivitySettings';
import PrivacySettings from '../PrivacySettings';
import { BillingTab } from '../billing/BillingTab';
import { BackupSection } from '../BackupSection';
import { TransferQrPanel } from '../link/TransferQrPanel';
import { NotificationsTab } from '../NotificationsTab';
import type { RetentionHook, MessageRetention, AttachmentRetention } from '../../hooks/useRetentionPolicy';
import type { KeybindHook } from '../../hooks/useKeybinds';
import type { VoiceSettingsHook } from '../../hooks/useVoiceSettings';
import type { GameSettingsHook } from '../../hooks/useGameSettings';
import type { PrivacySettingsHook } from '../../hooks/usePrivacySettings';
import type { ScreenLockHook } from '../../hooks/useScreenLock';
import type { GifSettingsHook } from '../../hooks/useGifSettings';

/**
 * “The Descent” — the settings experience.
 *
 * Settings organized as a dive through four depth zones (Surface → Twilight →
 * Midnight → Abyss), ordered by how careful the section deserves to be. The
 * nav is a working depth gauge (DepthGauge), the water darkens as you descend
 * (SeaBackdrop), and the danger zone sits at the literal bottom of the sea.
 *
 * Renders as a centered floating window over a dimmed veil when the viewport
 * comfortably fits it; below the threshold it falls back to the original
 * fullscreen takeover. The mode is live — resizing across the threshold
 * reflows in place without remounting the pane.
 *
 * Motion follows the locked doctrine: one spring, translateY-only entrances,
 * exits fast and plain, reduced-motion strips everything (CSS layer).
 */
export type PaneId =
    | 'profile' | 'appearance'
    | 'devices' | 'voice' | 'notifications' | 'keybinds' | 'activity'
    | 'privacy' | 'storage' | 'billing'
    | 'advanced' | 'danger';

const PANE_META: Record<PaneId, { title: string; desc: string }> = {
    profile:       { title: 'Profile',          desc: 'How you show up to the people who can actually see you.' },
    appearance:    { title: 'Appearance',       desc: 'The window, the tray, and how the app behaves around your OS.' },
    devices:       { title: 'Devices',          desc: 'Every device carries its own keys. This is the list, and the axe.' },
    voice:         { title: 'Voice & Video',    desc: 'Tuned on-device. Encrypted per frame on the way out.' },
    notifications: { title: 'Notifications',    desc: 'What’s allowed to glow, and when.' },
    keybinds:      { title: 'Keybinds',         desc: 'Muscle memory, formalized.' },
    activity:      { title: 'Game Activity',    desc: 'Rich presence, detected locally, shared only if you say so.' },
    privacy:       { title: 'Privacy & Safety', desc: 'Who can reach you, and what your devices admit to.' },
    storage:       { title: 'Storage',          desc: 'Your history: encrypted, backed up, and disposable on your schedule.' },
    billing:       { title: 'Subscription',     desc: 'One plan. Encryption was never the paid part.' },
    advanced:      { title: 'Advanced',         desc: 'The machinery. Mind the pressure at this depth.' },
    danger:        { title: 'Danger Zone',      desc: 'Everything below this line is permanent. Read twice, click once.' },
};

function formatDepth(m: number): string {
    return (m === 0 ? '0' : '−' + m.toLocaleString('en-US')) + ' m';
}

/* Windowed below these viewport dimensions would pinch the gauge + content
   column, so the Descent takes the whole screen instead. At the minimum the
   floating window still gets ~1008×700 inside the veil padding. */
const WINDOWED_MIN_W = 1080;
const WINDOWED_MIN_H = 780;
const fitsWindowed = () => window.innerWidth >= WINDOWED_MIN_W && window.innerHeight >= WINDOWED_MIN_H;

/** Counts the mono depth readout between zone depths (instant under reduced motion). */
function useDepthCounter(target: number) {
    const [shown, setShown] = useState(target);
    const shownRef = useRef(target);
    shownRef.current = shown;
    useEffect(() => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            setShown(target);
            return;
        }
        const from = shownRef.current;
        if (from === target) return;
        const t0 = performance.now();
        const dur = 620;
        const ease = (t: number) => 1 - Math.pow(1 - t, 3);
        let raf = 0;
        const step = (now: number) => {
            const k = Math.min(1, (now - t0) / dur);
            setShown(Math.round(from + (target - from) * ease(k)));
            if (k < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [target]);
    return shown;
}

export interface SettingsScreenProps {
    onClose: () => void;
    initialTab?: PaneId;
    onLogout: () => void;
    onViewProfile?: () => void;
    retention: RetentionHook;
    messagesState: Record<string, any[]>;
    onClearAllMessages: () => void;
    conversations: any[];
    onPurgeConversation: (convId: string, olderThanMs: number) => void;
    onPurgeTypeNow: (type: 'dm' | 'group' | 'server') => void;
    /** Dry-run count for the "Remove N now" prompt - see StorageSettings. */
    countExpiringForType?: (type: 'dm' | 'group' | 'server', kind: 'msg' | 'att', newVal: MessageRetention | AttachmentRetention) => number;
    keybinds: KeybindHook;
    voice: VoiceSettingsHook;
    gameSettings: GameSettingsHook;
    /** Display name of whatever's currently detected as running, or null. */
    currentGame: string | null;
    /** Executable behind `currentGame` — shown next to it, since a wrong
     *  match is only diagnosable from the exe name. */
    currentGameProcess?: string | null;
    /** Permanently ignores the currently-detected game and clears the live status. No-op if nothing's currently detected. */
    onIgnoreCurrentGame: () => void;
    privacy: PrivacySettingsHook;
    screenLock: ScreenLockHook;
    gif: GifSettingsHook;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
    onClose, initialTab,
    retention, messagesState, onClearAllMessages,
    conversations, onPurgeConversation, onPurgeTypeNow, countExpiringForType,
    keybinds, voice, gameSettings, currentGame, currentGameProcess, onIgnoreCurrentGame, privacy, screenLock, gif, onLogout,
}) => {
    const [pane, setPane] = useState<PaneId>(initialTab ?? 'profile');
    const [arrived, setArrived] = useState(false);
    const [closing, setClosing] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [windowed, setWindowed] = useState(fitsWindowed);
    const mainRef = useRef<HTMLDivElement>(null);
    const switchTimer = useRef(0);

    const zone = Math.max(0, zoneOf(pane));
    const isAbyss = ZONES[zone]?.abyss === true;
    const depth = useDepthCounter(ZONES[zone]?.depth ?? 0);

    // Entrance: flip .sd-arrived one frame after mount so the gauge rail
    // draws in, nav items stagger, and the first pane's cards spring up.
    useEffect(() => {
        const raf = requestAnimationFrame(() => setArrived(true));
        return () => cancelAnimationFrame(raf);
    }, []);

    // Windowed ↔ fullscreen tracks the live viewport size.
    useEffect(() => {
        const onResize = () => setWindowed(fitsWindowed());
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // The Descent covers the app for as long as it is mounted (fullscreen, or
    // windowed behind its own dimmed+blurred veil). Stop the decorative loops
    // underneath for that whole time — see setOccluded's note for the measured
    // cost. Cleared on unmount, including the close animation's unmount, so a
    // crash-free exit can never leave the dashboard permanently frozen.
    useEffect(() => {
        setOccluded(true);
        return () => setOccluded(false);
    }, []);

    // Exit: sink-away (translateY + fade, see .sd-closing), then unmount.
    const closingRef = useRef(false);
    const handleClose = useCallback(() => {
        if (closingRef.current) return;   // Esc keydown + close-panel keybind both land here
        closingRef.current = true;
        setClosing(true);
        window.setTimeout(onClose, 260);
    }, [onClose]);

    // Unsaved profile edits: every way out (Esc, veil click, X, pane switch)
    // asks first. DangerPane's post-logout/delete close bypasses this on purpose.
    const unsaved = useUnsavedChangesGuard('Your profile changes');
    const requestClose = useCallback(() => unsaved.guard(handleClose), [unsaved.guard, handleClose]); // eslint-disable-line react-hooks/exhaustive-deps

    // Escape goes through the shared stack, calling the GUARDED close path so
    // an unsaved profile edit still asks first. No manual "is a kit modal or
    // the confirm prompt open" check needed here any more — ClModal and
    // ConfirmDialog each push their own layer only while mounted, and since
    // either opens ON TOP of Settings (after this layer already exists),
    // theirs sits above on the stack and is what a press reaches first.
    useEscape(requestClose);

    // Dashboard's `close-panel` keybind is separate from Escape: it forwards
    // here so a REBOUND key (not necessarily Escape) still closes Settings —
    // through the guard. That path bypasses the capture-phase stack entirely,
    // so it still needs its own "don't close out from under an open modal or
    // the unsaved-changes prompt" check.
    useEffect(() => {
        const onKeybind = () => {
            if (unsaved.confirmOpen) return;
            if (document.querySelector('.cl-kit .mod')) return;
            requestClose();
        };
        window.addEventListener('keybind:close-panel', onKeybind);
        return () => window.removeEventListener('keybind:close-panel', onKeybind);
    }, [requestClose, unsaved.confirmOpen]);

    // Pane switch: outgoing content fades ~100ms (fast, plain), then the new
    // pane mounts and its cards restagger (the pane container is keyed).
    // The entrance direction mirrors travel through the gauge: descend = rise
    // from below (plunge when jumping 2+ zones), ascend = drop from above,
    // same-zone = lateral drift toward the item you moved to.
    const [entryFx, setEntryFx] = useState<{ pane: string; title: string }>({ pane: '', title: '' });
    const go = useCallback((next: PaneId) => {
        if (next === pane || leaving) return;
        const from = zoneOf(pane), to = zoneOf(next);
        let fx: { pane: string; title: string };
        if (to > from) {
            fx = { pane: to - from >= 2 ? ' sd-pane--plunge' : '', title: '' };
        } else if (to < from) {
            fx = { pane: from - to >= 2 ? ' sd-pane--surface' : ' sd-pane--up', title: ' sd-pop--up' };
        } else {
            const order = ZONES[to].items.map(i => i.id);
            const fwd = order.indexOf(next) > order.indexOf(pane);
            fx = fwd
                ? { pane: ' sd-pane--right', title: ' sd-pop--right' }
                : { pane: ' sd-pane--left', title: ' sd-pop--left' };
        }
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        setLeaving(true);
        window.clearTimeout(switchTimer.current);
        switchTimer.current = window.setTimeout(() => {
            setEntryFx(fx);
            setPane(next);
            setLeaving(false);
            if (mainRef.current) mainRef.current.scrollTop = 0;
        }, reduced ? 0 : 100);
    }, [pane, leaving]);
    useEffect(() => () => window.clearTimeout(switchTimer.current), []);
    const goGuarded = useCallback((next: PaneId) => {
        if (next === pane) return;
        unsaved.guard(() => go(next));
    }, [pane, go, unsaved.guard]); // eslint-disable-line react-hooks/exhaustive-deps

    const meta = PANE_META[pane];

    return (
        // The wrapper is always in the DOM so crossing the threshold mid-session
        // only swaps classes — the pane tree (and its state) never remounts.
        // In fullscreen mode it's an unstyled div around the fixed root.
        <div
            className={windowed ? `sd-veil${closing ? ' sd-closing' : ''}` : undefined}
            onClick={windowed ? (e) => { if (e.target === e.currentTarget) requestClose(); } : undefined}
        >
            <div className={`sd-root${windowed ? ' sd-win' : ''}${arrived ? ' sd-arrived' : ''}${closing ? ' sd-closing' : ''}${isAbyss ? ' sd-z-abyss' : ''}`}>
                <SeaBackdrop zone={zone} />

                {/* Fullscreen only — see the CSS comment on .sd-topbar. */}
                {!windowed && <div className="sd-topbar drag-region" />}

                <div className="sd-deck">
                    <DepthGauge active={pane} onSelect={goGuarded} appVersion={APP_VERSION} />

                    <main className={`sd-main${leaving ? ' sd-leaving' : ''}`} ref={mainRef}>
                        <div className="sd-col">
                            <header className="sd-chead">
                                <div className="sd-eyebrow">
                                    <b>{ZONES[zone]?.name}</b>
                                    <span className="sd-depth">{formatDepth(depth)}</span>
                                </div>
                                <h1 key={pane} className={`sd-pop${entryFx.title}`}>{meta.title}</h1>
                                <p>{meta.desc}</p>
                            </header>

                            <section key={`pane-${pane}`} className={`sd-pane${entryFx.pane}`}>
                                {pane === 'profile' && <ProfilePane onDirtyChange={unsaved.setDirty} />}
                                {pane === 'appearance' && <AppearancePane gif={gif} />}
                                {pane === 'devices' && <DevicesPane />}
                                {pane === 'voice' && <VoiceVideoSettings voice={voice} />}
                                {pane === 'notifications' && <NotificationsTab />}
                                {pane === 'keybinds' && <KeybindSettings keybinds={keybinds} />}
                                {pane === 'activity' && <GameActivitySettings gameSettings={gameSettings} currentGame={currentGame} currentGameProcess={currentGameProcess} onIgnoreCurrentGame={onIgnoreCurrentGame} />}
                                {pane === 'privacy' && <PrivacySettings privacy={privacy} screenLock={screenLock} keybinds={keybinds} />}
                                {pane === 'storage' && (
                                    <>
                                        <BackupSection />
                                        <TransferQrPanel />
                                        <StorageSettings
                                            retention={retention}
                                            messagesState={messagesState}
                                            conversations={conversations}
                                            onClearAllMessages={onClearAllMessages}
                                            onPurgeConversation={onPurgeConversation}
                                            onPurgeTypeNow={onPurgeTypeNow}
                                            countExpiringForType={countExpiringForType}
                                        />
                                    </>
                                )}
                                {pane === 'billing' && <BillingTab />}
                                {pane === 'advanced' && <AdvancedSettings />}
                                {pane === 'danger' && (
                                    <DangerPane onLogout={onLogout} onCloseSettings={handleClose} />
                                )}
                            </section>
                        </div>
                    </main>
                </div>

                <div className="sd-exit">
                    <ClButton icon variant="ghost" onClick={requestClose} tooltip="Return to surface">
                        <X size={16} />
                    </ClButton>
                    <small>ESC</small>
                </div>
                {unsaved.dialog}
            </div>
        </div>
    );
};
