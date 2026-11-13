/**
 * Tells the user when this account's stored data failed to load, and offers the
 * way back. Mounted once in the signed-in app; renders nothing itself.
 *
 * The app keeps working in that state, but with less than it looks like it has
 * (secureLocalStore's `unreadAccount` explains what is held back and why), so
 * this stays up until it is acted on or dismissed instead of timing out. A reload
 * is the recovery rather than loading the data in place: it rebuilds every reader
 * from disk, where a late load would leave components holding their empty state.
 */
import { useEffect, useRef } from 'react';
import { useToast } from '../contexts/ToastContext';
import secureLocalStore from '../utils/secureLocalStore';

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
            action: { label: 'Reload', onClick: () => window.location.reload() },
        });
    }), []);

    return null;
}

export default StoreLoadFailureHost;
