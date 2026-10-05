import secureLocalStore from '../utils/secureLocalStore';
import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
// Single source of truth lives in utils/idleThreshold.ts — the continuity
// attention state machine (utils/attentionState.ts, wired into
// useRealtime.ts's presence:heartbeat) imports the SAME constants from
// there rather than inventing a second idle notion that could drift from
// this one. Re-exported here too for existing/local readability.
import { IDLE_THRESHOLD_SECONDS, IDLE_POLL_INTERVAL_MS } from '../utils/idleThreshold';
import { applyPresenceEvent, presenceBus } from '../utils/presenceState';
import { OwnStatusSync, selfPresenceBus, type OwnChoice, type PendingLocalChange } from '../utils/ownStatusSync';
export { IDLE_THRESHOLD_SECONDS, IDLE_POLL_INTERVAL_MS } from '../utils/idleThreshold';

// The status model (types, colours, restore rule) lives in a dependency-free
// module so render code and tests can use it without this hook's imports.
export type { UserStatus, FriendStatusEntry } from '../utils/userStatusModel';
export { STATUS_CONFIG, initialStatusFromSaved } from '../utils/userStatusModel';
import { type UserStatus, type FriendStatusEntry, initialStatusFromSaved } from '../utils/userStatusModel';

/** Idle-poll hysteresis: go idle at the threshold, come back only once input
 *  is this recent, so a single mouse nudge at the boundary doesn't flap. */
const IDLE_RETURN_SECONDS = 30;

interface UseUserStatusOptions {
    token: string | null;
    userId: string | null;
    acceptedFriends: { user_id: string; status?: string; custom_status_text?: string | null; custom_status_emoji?: string | null }[];
    showGameActivity?: boolean;
    /** Increments each time the WS successfully (re)connects. Each one
     *  re-reads the user's chosen status from the server and adopts it (see
     *  utils/ownStatusSync.ts) — it no longer re-sends the local copy, which
     *  overwrote a status picked on another device. */
    wsConnectCount?: number;
    /** Report this connection's idle state to a server that understands it
     *  (`presence:idle`). From useRealtime. */
    sendPresenceIdle?: (idle: boolean) => void;
}

export function useUserStatus({ token, userId, acceptedFriends, showGameActivity = true, wsConnectCount = 0, sendPresenceIdle }: UseUserStatusOptions) {
    const [myStatus, setMyStatusState] = useState<UserStatus>(() =>
        initialStatusFromSaved(secureLocalStore.getItem(`cipherline_status_${userId}`)),
    );
    const [myCustomText, setMyCustomText] = useState<string>(() =>
        secureLocalStore.getItem(`cipherline_status_text_${userId}`) || ''
    );
    const [myCustomEmoji, setMyCustomEmoji] = useState<string>(() =>
        secureLocalStore.getItem(`cipherline_status_emoji_${userId}`) || ''
    );
    const [myCurrentGame, setMyCurrentGame] = useState<string | null>(null);
    // The matched executable name behind myCurrentGame — kept alongside the
    // display name so Settings ▸ Game Activity can offer "ignore this game"
    // for whatever's currently detected without a second IPC round-trip.
    const [myCurrentGameProcess, setMyCurrentGameProcess] = useState<string | null>(null);

    // Map of friend user_id → their live status
    const [friendStatuses, setFriendStatuses] = useState<Record<string, FriendStatusEntry>>(() => {
        const init: Record<string, FriendStatusEntry> = {};
        for (const f of acceptedFriends) {
            init[f.user_id] = {
                status: (f.status as UserStatus) || 'offline',
                custom_status_text: f.custom_status_text ?? null,
                custom_status_emoji: f.custom_status_emoji ?? null,
                current_game: null,
            };
        }
        return init;
    });

    // Whether the current away state was triggered automatically (so we can auto-restore)
    const autoAwayRef = useRef(false);
    // What the user CHOSE — differs from the displayed `myStatus` only while
    // auto-away is showing 'away' on top of a chosen 'online'. This, not the
    // display, is what gets (re-)announced to a server that does auto-away
    // itself.
    const chosenStatusRef = useRef<UserStatus>(myStatus);
    // Whether the server does auto-away per connection (`presence:idle`) —
    // learnt from its first `presence:snapshot`, which only such servers
    // send. Until then the old behaviour (PATCH 'away') applies, so a new
    // client against an old server loses nothing.
    const [serverAutoAway, setServerAutoAway] = useState(false);
    const serverAutoAwayRef = useRef(false);
    // The last idle verdict (hysteresis applied), so a reconnect can re-report
    // it — a new connection starts out "not idle" on the server.
    const idleRef = useRef(false);
    // True once a complete presence snapshot has been applied: from then on
    // an unknown member of our audience is offline, not "whatever the roster
    // said when it was fetched".
    const [presenceAuthoritative, setPresenceAuthoritative] = useState(false);
    const sendIdleRef = useRef(sendPresenceIdle);
    useEffect(() => { sendIdleRef.current = sendPresenceIdle; }, [sendPresenceIdle]);
    const myStatusRef = useRef(myStatus);
    const myCurrentGameRef = useRef(myCurrentGame);
    useEffect(() => { myStatusRef.current = myStatus; }, [myStatus]);
    useEffect(() => { myCurrentGameRef.current = myCurrentGame; }, [myCurrentGame]);
    // The custom status as the sync controller reads it — updated
    // synchronously wherever it changes, since the controller may send right
    // after an adopt, before React has re-rendered.
    const myCustomTextRef = useRef(myCustomText);
    const myCustomEmojiRef = useRef(myCustomEmoji);
    useEffect(() => { myCustomTextRef.current = myCustomText; }, [myCustomText]);
    useEffect(() => { myCustomEmojiRef.current = myCustomEmoji; }, [myCustomEmoji]);

    // Persist and push status to server
    const pushStatus = useCallback(async (
        status: UserStatus,
        text: string = myCustomText,
        emoji: string = myCustomEmoji,
        game_name: string | null = myCurrentGameRef.current,
    ) => {
        if (!token) return false;
        secureLocalStore.setItem(`cipherline_status_${userId}`, status);
        secureLocalStore.setItem(`cipherline_status_text_${userId}`, text);
        secureLocalStore.setItem(`cipherline_status_emoji_${userId}`, emoji);
        try {
            await axios.patch(`${API_BASE}/auth/status`, {
                status,
                custom_status_text: text || null,
                custom_status_emoji: emoji || null,
                game_name: game_name,
            }, { headers: { Authorization: `Bearer ${token}` } });
            return true;
        } catch (e) {
            console.error('[useUserStatus] Failed to push status:', e);
            return false;
        }
    }, [token, userId, myCustomText, myCustomEmoji]);
    const pushStatusRef = useRef(pushStatus);
    useEffect(() => { pushStatusRef.current = pushStatus; }, [pushStatus]);

    // The status to (re-)announce: the CHOICE when the server does auto-away
    // itself, else whatever is displayed (the old protocol, where auto-away
    // was itself announced as 'away').
    const announceable = (): UserStatus =>
        serverAutoAwayRef.current ? chosenStatusRef.current : myStatusRef.current;

    // ── Own status across devices: the server's choice is the truth ──────
    // See utils/ownStatusSync.ts for the rules (adopt on connect, send only
    // real changes, the offline-change merge, older servers).
    const syncRef = useRef<OwnStatusSync | null>(null);
    useEffect(() => {
        if (!token) return;
        const sync = new OwnStatusSync({
            fetchMe: async () => (await axios.get(`${API_BASE}/auth/me`, {
                headers: { Authorization: `Bearer ${token}` },
            })).data,
            patchStatus: (c: OwnChoice, game: string | null) => pushStatusRef.current(c.status, c.text, c.emoji, game),
            apply: (c: OwnChoice) => {
                autoAwayRef.current = false;
                chosenStatusRef.current = c.status;
                myStatusRef.current = c.status;
                myCustomTextRef.current = c.text;
                myCustomEmojiRef.current = c.emoji;
                setMyStatusState(c.status);
                setMyCustomText(c.text);
                setMyCustomEmoji(c.emoji);
                secureLocalStore.setItem(`cipherline_status_${userId}`, c.status);
                secureLocalStore.setItem(`cipherline_status_text_${userId}`, c.text);
                secureLocalStore.setItem(`cipherline_status_emoji_${userId}`, c.emoji);
            },
            getLocal: () => ({ status: announceable(), text: myCustomTextRef.current, emoji: myCustomEmojiRef.current }),
            getGame: () => myCurrentGameRef.current,
            loadPending: () => {
                try {
                    const raw = secureLocalStore.getItem(`cipherline_status_pending_${userId}`);
                    return raw ? JSON.parse(raw) as PendingLocalChange : null;
                } catch { return null; }
            },
            savePending: (p: PendingLocalChange | null) => {
                if (p) secureLocalStore.setItem(`cipherline_status_pending_${userId}`, JSON.stringify(p));
                else secureLocalStore.removeItem(`cipherline_status_pending_${userId}`);
            },
        });
        syncRef.current = sync;
        return () => { sync.dispose(); if (syncRef.current === sync) syncRef.current = null; };
    }, [token, userId]);

    // Public setter — a real change on THIS device: the only thing that
    // sends a status. Resets the auto-away flag.
    const setStatus = useCallback((status: UserStatus, text?: string, emoji?: string) => {
        autoAwayRef.current = false;
        chosenStatusRef.current = status;
        myStatusRef.current = status;
        const newText  = text  !== undefined ? text  : myCustomTextRef.current;
        const newEmoji = emoji !== undefined ? emoji : myCustomEmojiRef.current;
        myCustomTextRef.current = newText;
        myCustomEmojiRef.current = newEmoji;
        setMyStatusState(status);
        setMyCustomText(newText);
        setMyCustomEmoji(newEmoji);
        if (syncRef.current) void syncRef.current.changeLocally({ status, text: newText, emoji: newEmoji });
        else void pushStatus(status, newText, newEmoji, myCurrentGameRef.current);
    }, [pushStatus]);

    /** A game started/stopped: tell the server (the PATCH carries the status
     *  this device already shows), but not before the server's choice has
     *  been adopted on this connection. */
    const pushAmbient = useCallback(() => {
        if (syncRef.current) void syncRef.current.ambientChange();
        else void pushStatus(myStatusRef.current, undefined, undefined, myCurrentGameRef.current);
    }, [pushStatus]);

    // On sign-in / account switch: show what this device last chose until the
    // server's answer arrives on connect. Nothing is SENT from here any more.
    useEffect(() => {
        if (!token) return;
        const initialStatus = initialStatusFromSaved(secureLocalStore.getItem(`cipherline_status_${userId}`));
        chosenStatusRef.current = initialStatus;
        myStatusRef.current = initialStatus;
        autoAwayRef.current = false;
        setMyStatusState(initialStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    // Every WS (re)connect: read the chosen status and adopt it (or, against
    // an older server, re-announce as before).
    useEffect(() => {
        if (wsConnectCount < 1) return; // 0 = not yet connected
        void syncRef.current?.onConnected();
    }, [wsConnectCount, token]);

    // `presence:self`: the choice changed — possibly on another device.
    useEffect(() => selfPresenceBus.subscribe(data => { syncRef.current?.onSelfEvent(data); }), []);

    // Idle detection — polls the OS idle time (Electron powerMonitor, which
    // reads GetLastInputInfo on Windows) every 30 s.
    //
    // Against a server that does auto-away per connection, idle is only
    // REPORTED (`presence:idle`) and the server decides: 'away' only when
    // every device is idle, so an idle desktop no longer marks someone away
    // while they're chatting on their phone — and it never overwrites the
    // chosen status. The picker keeps showing the choice. Against an older
    // server, the old behaviour: PATCH 'away', restore on return.
    useEffect(() => {
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.getSystemIdleTime) return;

        const poll = setInterval(async () => {
            const idleSecs: number = await electronAPI.getSystemIdleTime();
            const wasIdle = idleRef.current;
            const idle = wasIdle ? idleSecs >= IDLE_RETURN_SECONDS : idleSecs >= IDLE_THRESHOLD_SECONDS;
            idleRef.current = idle;
            if (serverAutoAwayRef.current) {
                if (idle !== wasIdle) sendIdleRef.current?.(idle);
                return;
            }

            const current = myStatusRef.current;
            if (current === 'dnd' || current === 'offline') return; // respect manual override

            if (idle && current === 'online') {
                autoAwayRef.current = true;
                setMyStatusState('away');
                pushStatus('away', undefined, undefined, myCurrentGameRef.current);
            } else if (!idle && current === 'away' && autoAwayRef.current) {
                autoAwayRef.current = false;
                setMyStatusState('online');
                pushStatus('online', undefined, undefined, myCurrentGameRef.current);
            }
        }, IDLE_POLL_INTERVAL_MS);

        return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pushStatus]);

    // Other people's presence — every event, in order (see presenceState.ts
    // for why this is a bus and not a state slot).
    useEffect(() => presenceBus.subscribe(ev => {
        setFriendStatuses(prev => applyPresenceEvent(prev, ev));
        if (ev.kind !== 'snapshot') return;
        if (ev.complete) setPresenceAuthoritative(true);
        // A snapshot means this server does per-connection auto-away, and a
        // new connection starts "not idle" there: re-report idleness.
        if (!serverAutoAwayRef.current) {
            serverAutoAwayRef.current = true;
            setServerAutoAway(true);
        }
        if (idleRef.current) sendIdleRef.current?.(true);
    }), []);

    // Switching protocols mid-session (the server was upgraded under us):
    // an auto-away that was PATCHed the old way must not stay behind as a
    // chosen 'away' — put the choice back.
    useEffect(() => {
        if (!serverAutoAway || !autoAwayRef.current) return;
        autoAwayRef.current = false;
        setMyStatusState(chosenStatusRef.current);
        pushStatus(chosenStatusRef.current, undefined, undefined, myCurrentGameRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverAutoAway]);

    // Game detection from Electron IPC — gated by showGameActivity toggle
    useEffect(() => {
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.onGameDetected) return;

        // Game changes set the ref synchronously so the PATCH (which reads it)
        // carries the new value; see pushAmbient.
        const setGame = (name: string | null, processName: string | null) => {
            myCurrentGameRef.current = name;
            setMyCurrentGame(name);
            setMyCurrentGameProcess(processName);
            pushAmbient();
        };

        // Main scans running processes in the background only while someone
        // wants the answer — off here means no scan at all (getCurrentGame()
        // still works on demand, e.g. for the screen-share picker).
        electronAPI.setGameDetectionEnabled?.(showGameActivity);

        if (!showGameActivity) {
            // Toggle turned off — clear game state and notify server
            if (myCurrentGameRef.current) setGame(null, null);
            return;
        }

        // Query current game on mount (in case a game was already running when app launched)
        electronAPI.getCurrentGame().then((game: { name: string; processName: string } | null) => {
            if (game) setGame(game.name, game.processName);
        }).catch(() => {});

        const unsubDetected = electronAPI.onGameDetected(({ name, processName }: { name: string; processName: string }) => {
            setGame(name, processName);
        });
        const unsubStopped = electronAPI.onGameStopped(() => {
            setGame(null, null);
        });

        return () => {
            unsubDetected?.();
            unsubStopped?.();
        };
    }, [pushAmbient, showGameActivity]);

    // Seed friend statuses from the accepted friends list when it loads.
    // IMPORTANT: must return `prev` (not a spread copy) when nothing is new —
    // otherwise every render triggers a state update → infinite loop.
    useEffect(() => {
        if (!acceptedFriends.length) return;
        setFriendStatuses(prev => {
            const newEntries = acceptedFriends.filter(f => !prev[f.user_id]);
            if (newEntries.length === 0) return prev; // nothing new — skip re-render
            const next = { ...prev };
            for (const f of newEntries) {
                next[f.user_id] = {
                    status: (f.status as UserStatus) || 'offline',
                    custom_status_text: f.custom_status_text ?? null,
                    custom_status_emoji: f.custom_status_emoji ?? null,
                    current_game: null,
                };
            }
            return next;
        });
    }, [acceptedFriends]);

    // Manually dismiss the detected game for THIS session only (e.g. false
    // positive) — doesn't touch the ignore list, so it can be re-detected on
    // the next poll if the same process is still running. Settings ▸ Game
    // Activity's "ignore this game" additionally adds it to ignoredProcesses
    // (permanent) and calls this to clear the live status immediately too.
    const clearGame = useCallback(() => {
        myCurrentGameRef.current = null;
        setMyCurrentGame(null);
        setMyCurrentGameProcess(null);
        pushAmbient();
    }, [pushAmbient]);

    return {
        myStatus,
        myCustomText,
        myCustomEmoji,
        myCurrentGame,
        myCurrentGameProcess,
        setStatus,
        setMyCustomText,
        setMyCustomEmoji,
        pushStatus,
        clearGame,
        friendStatuses,
        presenceAuthoritative,
    };
}
