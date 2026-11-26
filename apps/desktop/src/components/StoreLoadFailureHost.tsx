/**
 * Tells the user when this account's stored data failed to load, and offers the
 * way back. Mounted once in the signed-in app; renders nothing itself.
 *
 * The app keeps working in that state, but with less than it looks like it has
 * (secureLocalStore's `unreadAccount` explains what is held back and why), so
 * this stays up until it is acted on or dismissed instead of timing out. A restart
 * is the recovery rather than loading the data in place: it rebuilds every reader
 * from disk, where a late load would leave components holding their empty state.
 */
import { useEffect, useRef } from 'react';
import { useToast } from '../contexts/ToastContext';
import secureLocalStore from '../utils/secureLocalStore';
import { restartApp } from '../utils/restartApp';

export function StoreLoadFailureHost() {
    const { push } = useToast();
    const pushRef = useRef(push);
    useEffect(() => { pushRef.current = push; });
    // A ref, because StrictMode runs the effect twice and the store reports a
    // past failure again on every subscribe.
    const shown = useRef(false);

    useEffect(() => secureLocalStore.onLoadFailure(() => {
        if (shown.current) return;
        shown.current = true;
        pushRef.current({
            kind: 'error',
            title: 'Couldn’t load your data on this device',
            message: 'Nothing was deleted. Until it loads, your history stays hidden, new direct messages wait on the server, and changes on this device aren’t saved.',
            durationMs: 0,
            // A restart, not a page reload: Chromium keeps a failed IndexedDB
            // backend for the life of the process (utils/restartApp.ts).
            action: { label: 'Restart', onClick: () => { void restartApp(); } },
        });
    }), []);

    // Some records could not be read, and the rest loaded (secureLocalStore:
    // UNREADABLE RECORDS). Calmer than the failure above, because the app is
    // working: it says what is missing and that nothing was deleted. Once per
    // session; a launch that still cannot read them says so again.
    const partialShown = useRef(false);
    useEffect(() => secureLocalStore.onUnreadableRecords(() => {
        if (partialShown.current) return;
        partialShown.current = true;
        pushRef.current({
            kind: 'info',
            title: 'Some older history couldn’t be read',
            message: 'Part of what’s stored on this device couldn’t be read this time, so some older messages may be missing. Nothing was deleted, and it’s kept as it is. New messages in those chats wait on the server until it can be read. Your backups still run and keep their copy of it; Settings → Backup can remove the damaged items.',
            durationMs: 0,
        });
    }), []);

    return null;
}

export default StoreLoadFailureHost;
