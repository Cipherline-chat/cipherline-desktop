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
import { activeCustom, nextCustomExpiry } from '../utils/customStatus';
import { OwnStatusSync, selfPresenceBus, type OwnChoice, type PendingLocalChange } from '../utils/ownStatusSync';
import { GameActivityReporter } from '../utils/gameActivityReporter';
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
    acceptedFriends: { user_id: string; status?: string; custom_status_text?: string | null; custom_status_emoji?: string | null; custom_status_expires_at?: string | null }[];
    showGameActivity?: boolean;
    /** Increments each time the WS successfully (re)connects. Each one
     *  re-reads the user's chosen status from the server and adopts it (see
     *  utils/ownStatusSync.ts) — it no longer re-sends the local copy, which
     *  overwrote a status picked on another device. */
    wsConnectCount?: number;
    /** Report this connection's idle state to a server that understands it
     *  (`presence:idle`). From useRealtime. */
    sendPresenceIdle?: (idle: boolean) => void;
    /** Report this connection's game (`presence:game`). From useRealtime. */
    sendPresenceGame?: (game: string | null) => void;
}

export function useUserStatus({ token, userId, acceptedFriends, showGameActivity = true, wsConnectCount = 0, sendPresenceIdle, sendPresenceGame }: UseUserStatusOptions) {
    const [myStatus, setMyStatusState] = useState<UserStatus>(() =>
        initialStatusFromSaved(secureLocalStore.getItem(`cipherline_status_${userId}`)),
    );
    const [myCustomText, setMyCustomText] = useState<string>(() =>
        secureLocalStore.getItem(`cipherline_status_text_${userId}`) || ''
    );
    const [myCustomEmoji, setMyCustomEmoji] = useState<string>(() =>
        secureLocalStore.getItem(`cipherline_status_emoji_${userId}`) || ''
    );
    // When the custom status clears (ISO), or null. Persisted next to the text
    // so an expired status does not flash back at boot; the server decides.
    const [myCustomExpiresAt, setMyCustomExpiresAt] = useState<string | null>(() =>
        secureLocalStore.getItem(`cipherline_status_expires_${userId}`) || null
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
                custom_status_expires_at: f.custom_status_expires_at ?? null,
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
    // The game over the socket, per connection, refreshed while it runs — so
    // the server drops it on its own once this machine stops saying so
    // (utils/gameActivityReporter.ts). The REST PATCH still carries it for
    // older servers.
    const sendGameRef = useRef(sendPresenceGame);
    useEffect(() => { sendGameRef.current = sendPresenceGame; }, [sendPresenceGame]);
    const gameReporterRef = useRef<GameActivityReporter | null>(null);
    if (!gameReporterRef.current) gameReporterRef.current = new GameActivityReporter(g => sendGameRef.current?.(g));
    useEffect(() => () => gameReporterRef.current?.dispose(), []);
    const myStatusRef = useRef(myStatus);
    const myCurrentGameRef = useRef(myCurrentGame);
    useEffect(() => { myStatusRef.current = myStatus; }, [myStatus]);
    useEffect(() => { myCurrentGameRef.current = myCurrentGame; }, [myCurrentGame]);
    // The custom status as the sync controller reads it — updated
    // synchronously wherever it changes, since the controller may send right
    // after an adopt, before React has re-rendered.
    const myCustomTextRef = useRef(myCustomText);
    const myCustomEmojiRef = useRef(myCustomEmoji);
    const myCustomExpiresRef = useRef(myCustomExpiresAt);
    useEffect(() => { myCustomExpiresRef.current = myCustomExpiresAt; }, [myCustomExpiresAt]);
    useEffect(() => { myCustomTextRef.current = myCustomText; }, [myCustomText]);
    useEffect(() => { myCustomEmojiRef.current = myCustomEmoji; }, [myCustomEmoji]);

    // Persist and push status to server
    const pushStatus = useCallback(async (
        status: UserStatus,
        text: string = myCustomText,
        emoji: string = myCustomEmoji,
        game_name: string | null = myCurrentGameRef.current,
        // undefined = do not mention it (the server keeps an unchanged
        // status's expiry); null = don't clear; ISO = clear then.
        expiresAt?: string | null,
    ) => {
        if (!token) return false;
        // An expiry already behind us (a replayed offline change) means the
        // status is over: send it cleared rather than a request the server
        // would refuse.
        if (typeof expiresAt === 'string' && Date.parse(expiresAt) <= Date.now()) {
            text = ''; emoji = ''; expiresAt = null;
        }
        secureLocalStore.setItem(`cipherline_status_${userId}`, status);
        secureLocalStore.setItem(`cipherline_status_text_${userId}`, text);
        secureLocalStore.setItem(`cipherline_status_emoji_${userId}`, emoji);
        try {
            // A My Emojis status sends only its `cl:p_<id>` reference: the image
            // stays on devices and reaches friends end to end encrypted
            // (utils/personalEmoji/statusEmoji.ts, driven from Dashboard).
            await axios.patch(`${API_BASE}/auth/status`, {
                status,
                custom_status_text: text || null,
                custom_status_emoji: emoji || null,
                ...(expiresAt !== undefined ? { custom_status_expires_at: expiresAt } : {}),
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
            patchStatus: (c: OwnChoice, game: string | null) => pushStatusRef.current(c.status, c.text, c.emoji, game, c.expiresAt),
            apply: (c: OwnChoice) => {
                autoAwayRef.current = false;
                chosenStatusRef.current = c.status;
                myStatusRef.current = c.status;
                myCustomTextRef.current = c.text;
                myCustomEmojiRef.current = c.emoji;
                myCustomExpiresRef.current = c.expiresAt ?? null;
                setMyStatusState(c.status);
                setMyCustomText(c.text);
                setMyCustomEmoji(c.emoji);
                setMyCustomExpiresAt(c.expiresAt ?? null);
                secureLocalStore.setItem(`cipherline_status_${userId}`, c.status);
                secureLocalStore.setItem(`cipherline_status_text_${userId}`, c.text);
                secureLocalStore.setItem(`cipherline_status_emoji_${userId}`, c.emoji);
                secureLocalStore.setItem(`cipherline_status_expires_${userId}`, c.expiresAt ?? '');
            },
            getLocal: () => ({ status: announceable(), text: myCustomTextRef.current, emoji: myCustomEmojiRef.current, expiresAt: myCustomExpiresRef.current }),
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
    //
    // `expiresAt` is for the custom-status dialog: an ISO instant, or null for
    // "don't clear". Left out, an unchanged custom status keeps its expiry and
    // a changed one has none (the same rule the server applies).
    const setStatus = useCallback((status: UserStatus, text?: string, emoji?: string, expiresAt?: string | null) => {
        autoAwayRef.current = false;
        chosenStatusRef.current = status;
        myStatusRef.current = status;
        const newText  = text  !== undefined ? text  : myCustomTextRef.current;
        const newEmoji = emoji !== undefined ? emoji : myCustomEmojiRef.current;
        const contentChanged = newText !== myCustomTextRef.current || newEmoji !== myCustomEmojiRef.current;
        const newExpires = newText === '' && newEmoji === ''
            ? null
            : expiresAt !== undefined ? expiresAt : (contentChanged ? null : myCustomExpiresRef.current);
        myCustomTextRef.current = newText;
        myCustomEmojiRef.current = newEmoji;
        myCustomExpiresRef.current = newExpires;
        setMyStatusState(status);
        setMyCustomText(newText);
        setMyCustomEmoji(newEmoji);
        setMyCustomExpiresAt(newExpires);
        secureLocalStore.setItem(`cipherline_status_expires_${userId}`, newExpires ?? '');
        // Only an explicit expiry is sent; otherwise the server keeps/derives it.
        const choice: OwnChoice = { status, text: newText, emoji: newEmoji, ...(expiresAt !== undefined ? { expiresAt } : {}) };
        if (syncRef.current) void syncRef.current.changeLocally(choice);
        else void pushStatus(status, newText, newEmoji, myCurrentGameRef.current, expiresAt);
    }, [pushStatus, userId]);

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
        gameReporterRef.current?.onConnected();
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.electronAPI members are optional/version-dependent and not all declared on the typed bridge
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.electronAPI members are optional/version-dependent and not all declared on the typed bridge
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.onGameDetected) return;

        // Game changes set the ref synchronously so the PATCH (which reads it)
        // carries the new value; see pushAmbient.
        const setGame = (name: string | null, processName: string | null) => {
            myCurrentGameRef.current = name;
            setMyCurrentGame(name);
            setMyCurrentGameProcess(processName);
            gameReporterRef.current?.setGame(name);
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

    // Custom statuses clear on their own: one timer for the nearest expiry,
    // for the user's own status and everyone else's. The server publishes the
    // same change (and this is idempotent with it); this only covers a missed
    // or late event, so an expired status never lingers on screen.
    const nearestExpiry = (() => {
        const own = myCustomExpiresAt ? [{ custom_status_expires_at: myCustomExpiresAt }] : [];
        return nextCustomExpiry([...own, ...Object.values(friendStatuses)]);
    })();
    useEffect(() => {
        if (nearestExpiry === null) return;
        const t = setTimeout(() => {
            const now = Date.now();
            if (myCustomExpiresRef.current && Date.parse(myCustomExpiresRef.current) <= now) {
                myCustomTextRef.current = '';
                myCustomEmojiRef.current = '';
                myCustomExpiresRef.current = null;
                setMyCustomText('');
                setMyCustomEmoji('');
                setMyCustomExpiresAt(null);
                secureLocalStore.setItem(`cipherline_status_text_${userId}`, '');
                secureLocalStore.setItem(`cipherline_status_emoji_${userId}`, '');
                secureLocalStore.setItem(`cipherline_status_expires_${userId}`, '');
            }
            setFriendStatuses(prev => {
                let next: typeof prev | null = null;
                for (const [id, e] of Object.entries(prev)) {
                    if (!e.custom_status_expires_at || activeCustom(e.custom_status_text, e.custom_status_emoji, e.custom_status_expires_at, now)) continue;
                    next = next ?? { ...prev };
                    next[id] = { ...e, custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null };
                }
                return next ?? prev;
            });
        }, Math.max(nearestExpiry - Date.now(), 0) + 50);
        return () => clearTimeout(t);
    }, [nearestExpiry, userId]);

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
                    custom_status_expires_at: f.custom_status_expires_at ?? null,
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
        gameReporterRef.current?.setGame(null);
        pushAmbient();
    }, [pushAmbient]);

    return {
        myStatus,
        myCustomText,
        myCustomEmoji,
        myCustomExpiresAt,
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
