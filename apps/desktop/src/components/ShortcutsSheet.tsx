/**
 * The keyboard shortcuts cheat sheet. `?` (when you are not typing) opens it;
 * Settings -> Keybinds has a button that opens the same sheet. Esc closes it
 * (ClModal's shared Escape stack), and so does `?` again.
 *
 * It lists the LIVE keybinds (a rebound key shows its new combo, a cleared one
 * shows "Not bound") grouped as Settings groups them, then the fixed keys. The
 * rules for when `?` opens and what is listed are in utils/shortcutsSheet.ts.
 *
 * Client-only; reads nothing but the keybind map.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Settings as SettingsIcon } from 'lucide-react';
import { ClButton, ClModal } from './cl';
import { DialogBody, DialogFooter, DialogHeader, useInitialFocus } from './dialog/DialogFrame';
import { Keys } from './mascot/Keys';
import { useModalExit } from '../hooks/useModalExit';
import { formatCombo, type KeybindHook } from '../hooks/useKeybinds';
import { isScreenLockEngaged } from '../utils/screenLockEngaged';
import { requestOpenSettings } from '../utils/openSettingsRequest';
import {
    OPEN_SHORTCUTS_EVENT, buildShortcutGroups, comboCaps, shouldOpenShortcutsSheet,
} from '../utils/shortcutsSheet';
import '../styles/shortcuts-sheet.css';

const Caps: React.FC<{ keys: string[] }> = ({ keys }) => (
    keys.length === 0
        ? <span className="ss-unbound">Not bound</span>
        : <span className="ss-caps">{keys.map((k, i) => <kbd key={i} className="ss-cap">{k}</kbd>)}</span>
);

interface SheetProps {
    binds: KeybindHook['binds'];
    pushToTalkKey?: string | null;
    onClose: () => void;
    onOpenSettings?: () => void;
}

export const ShortcutsSheet: React.FC<SheetProps> = ({ binds, pushToTalkKey, onClose, onOpenSettings }) => {
    const { closing, handleClose } = useModalExit(onClose, 200);
    const doneSlot = useRef<HTMLDivElement>(null);
    useInitialFocus(doneSlot, !closing);
    const groups = useMemo(() => buildShortcutGroups(binds, formatCombo, pushToTalkKey), [binds, pushToTalkKey]);
    // Keys points at the one shortcut worth knowing even when the window is in the background.
    const muteCaps = comboCaps(binds['toggle-mute'], formatCombo);

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={660}
            label="Keyboard shortcuts"
            cardClassName="dlg-card shortcuts-card"
            overlayStyle={{ zIndex: 10001 }}
        >
            <DialogHeader
                icon={<Keyboard size={18} strokeWidth={2.2} />}
                title="Keyboard shortcuts"
                subtitle="Press ? any time you are not typing. Esc closes this."
            />
            <DialogBody>
                <div className="ss-scroll" tabIndex={0} role="region" aria-label="Shortcut list">
                    {muteCaps.length > 0 && (
                        <div className="ss-keys">
                            <span className="ss-keys-art">
                                <Keys size={60} interactive={false} waveOnMount={false} ariaLabel="Keys, pointing at a shortcut" />
                            </span>
                            <span className="ss-keys-arrow" aria-hidden="true">←</span>
                            <span className="ss-keys-note">
                                <Caps keys={muteCaps} />
                                <span>mutes you, even from another window.</span>
                            </span>
                        </div>
                    )}
                    {groups.map(g => (
                        <section key={g.id} className="ss-group" aria-labelledby={`ss-g-${g.id}`}>
                            <h3 className="ss-gtitle" id={`ss-g-${g.id}`}>{g.title}</h3>
                            <div className="ss-ghint">{g.hint}</div>
                            <ul className="ss-rows">
                                {g.rows.map(r => (
                                    <li key={r.id} className="ss-row">
                                        <span className="ss-label">
                                            {r.label}
                                            {r.note && <span className="ss-note">{r.note}</span>}
                                        </span>
                                        <Caps keys={r.keys} />
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            </DialogBody>
            <DialogFooter hint="Call controls work in the background.">
                {onOpenSettings && (
                    <ClButton variant="ghost" size="sm" onClick={() => { handleClose(); onOpenSettings(); }}>
                        <SettingsIcon size={13} /> Change shortcuts
                    </ClButton>
                )}
                <div className="dlg-focus-slot" ref={doneSlot}>
                    <ClButton size="sm" onClick={handleClose}>Done</ClButton>
                </div>
            </DialogFooter>
        </ClModal>
    );
};

interface HostProps {
    keybinds: KeybindHook;
    pushToTalkKey?: string | null;
    /** Opens Settings on the Keybinds pane (default: the shared open-settings request). */
    onOpenKeybindSettings?: () => void;
}

/** Mounted once in the signed-in app. Renders nothing until the sheet is asked for. */
export const ShortcutsSheetHost: React.FC<HostProps> = ({ keybinds, pushToTalkKey, onOpenKeybindSettings }) => {
    const [open, setOpen] = useState(false);

    const toggle = useCallback(() => setOpen(o => !o), []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isScreenLockEngaged()) return;
            if (!shouldOpenShortcutsSheet(e, e.target)) return;
            e.preventDefault();
            toggle();
        };
        const onOpen = () => { if (!isScreenLockEngaged()) setOpen(true); };
        window.addEventListener('keydown', onKey);
        window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
        };
    }, [toggle]);

    if (!open) return null;
    return (
        <ShortcutsSheet
            binds={keybinds.binds}
            pushToTalkKey={pushToTalkKey}
            onClose={() => setOpen(false)}
            onOpenSettings={onOpenKeybindSettings ?? (() => requestOpenSettings('keybinds'))}
        />
    );
};

export default ShortcutsSheetHost;
