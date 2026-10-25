import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import secureLocalStore from '../utils/secureLocalStore';
import { ANTI_ENTROPY_MIN_GAP_MS } from '../utils/ownSlotSync';
import { bindNotes, getNotes, mergeRemoteNotes } from '../utils/profileNotes';
import { notesRepublishReason, publishNotes, pullNotes } from '../services/profileNotesSync';
import { createNotesSyncEnv, getNotesView, setNotesView } from '../services/profileNotesSyncEnv';

const PUBLISH_DEBOUNCE_MS = 3_000;
const FOCUS_MIN_GAP_MS = 60_000;

/**
 * Mounted once in the signed-in app, renders nothing. Binds the per-account
 * private-notes store (utils/profileNotes.ts) and keeps it in step across this
 * account's own devices through the `profile_notes` own-device slot (E2EE; the
 * server holds one opaque blob). Triggered by intent only - once when ready,
 * on window focus (at most once a minute) and after an edit - and best-effort:
 * a failure is logged and swallowed, local notes are always already saved.
 */
export const ProfileNotesHost: React.FC = () => {
    const { token, userId, deviceId } = useAuth();
    const tokenRef = useRef(token);
    useEffect(() => { tokenRef.current = token; });

    useEffect(() => {
        if (!userId || !deviceId) return;
        let cancelled = false;
        let inFlight = false;
        let again = false;
        let dirty = false;
        let lastRunAt = 0;
        let lastAntiEntropyAt = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const run = async () => {
            if (cancelled || !tokenRef.current) return;
            if (inFlight) { again = true; return; }
            inFlight = true;
            try {
                do {
                    again = false;
                    lastRunAt = Date.now();
                    const env = createNotesSyncEnv(
                        { userId, deviceId, token: tokenRef.current! },
                        { load: getNotes, merge: mergeRemoteNotes },
                    );
                    let pulled = false;
                    try {
                        const res = await pullNotes(env, getNotesView(userId));
                        setNotesView(userId, res.view);
                        pulled = true;
                    } catch (e) { console.warn('[notesSync] pull failed', e); }

                    let publish = dirty;
                    if (!publish && pulled && Date.now() - lastAntiEntropyAt >= ANTI_ENTROPY_MIN_GAP_MS) {
                        try {
                            const reason = notesRepublishReason(getNotesView(userId), getNotes(), await env.listOwnDeviceIds(), deviceId);
                            if (reason !== 'none') { publish = true; lastAntiEntropyAt = Date.now(); }
                        } catch (e) { console.warn('[notesSync] anti-entropy check failed', e); }
                    }
                    if (publish) {
                        try {
                            dirty = false;
                            const view = await publishNotes(env, deviceId);
                            if (view) setNotesView(userId, view);
                        } catch (e) { dirty = true; console.warn('[notesSync] publish failed', e); }
                    }
                } while (again && !cancelled);
            } finally {
                inFlight = false;
            }
        };
        const markDirty = () => {
            dirty = true;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { void run(); }, PUBLISH_DEBOUNCE_MS);
        };
        const onFocus = () => { if (Date.now() - lastRunAt >= FOCUS_MIN_GAP_MS) void run(); };

        void secureLocalStore.whenAccountReady().catch(() => undefined).then(() => {
            if (cancelled) return;
            bindNotes(userId, markDirty);
            void run();
            window.addEventListener('focus', onFocus);
        });
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            window.removeEventListener('focus', onFocus);
            bindNotes(null);
        };
    }, [userId, deviceId]);

    return null;
};

export default ProfileNotesHost;
