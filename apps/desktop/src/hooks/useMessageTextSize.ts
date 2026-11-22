import { useCallback, useEffect, useState } from 'react';
import { secureLocalStore } from '../utils/secureLocalStore';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import {
    MESSAGE_TEXT_CHANGED_EVENT, MESSAGE_TEXT_DEFAULT, MESSAGE_TEXT_STORE_KEY,
    isMessageTextStep, parseMessageTextSize,
} from '../utils/a11y/messageTextSize';

/**
 * Accessibility → Message text size. Same shape as useAmbientMotion: a global
 * secureLocalStore key, a window event keeping the pane, the live preview and
 * the applier (components/a11y/A11yRuntime) in sync. Reads only; the only
 * write is the user moving the slider (no write-on-mount). The store is cold
 * until the account is ready, so it re-reads then, and after a backup restore.
 */
function read(): number {
    try { return parseMessageTextSize(secureLocalStore.getItem(MESSAGE_TEXT_STORE_KEY)); } catch { return MESSAGE_TEXT_DEFAULT; }
}

export function useMessageTextSize(): [number, (px: number) => void] {
    const [px, setPx] = useState(read);

    useEffect(() => {
        let alive = true;
        const sync = () => { if (alive) setPx(read()); };
        window.addEventListener(MESSAGE_TEXT_CHANGED_EVENT, sync);
        window.addEventListener(BACKUP_RESTORED_EVENT, sync);
        void Promise.resolve(secureLocalStore.whenAccountReady()).catch(() => undefined).then(sync);
        return () => {
            alive = false;
            window.removeEventListener(MESSAGE_TEXT_CHANGED_EVENT, sync);
            window.removeEventListener(BACKUP_RESTORED_EVENT, sync);
        };
    }, []);

    const set = useCallback((next: number) => {
        if (!isMessageTextStep(next)) return;
        try { secureLocalStore.setItem(MESSAGE_TEXT_STORE_KEY, String(next)); } catch { /* applies for this session */ }
        setPx(next);
        window.dispatchEvent(new CustomEvent(MESSAGE_TEXT_CHANGED_EVENT));
    }, []);

    return [px, set];
}
