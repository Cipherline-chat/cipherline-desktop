/**
 * useFirstWeekNudges — the runtime for the first-week, in-app-only nudges and
 * the "ask at the moment of need" notification prompt.
 *
 * Every DECISION is in utils/firstWeekNudges.ts / utils/notificationAsk.ts
 * (pure, tested). This hook only feeds them a snapshot and shows the result.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 * Nothing runs while the window is hidden or unfocused. While it IS focused:
 *   - three passive listeners (keydown / pointerdown / wheel) that write one
 *     number each — that is the whole "is the person here" signal;
 *   - one evaluation when something relevant changes (friend / server counts,
 *     friends-in-voice, call, DND, a modal opening, a bus event) and on focus;
 *   - one 60-second tick to catch "became active" / "session grace ended".
 * An evaluation is a handful of comparisons. There is no timer faster than
 * 60 s, except two one-shot timeouts: the card's own auto-hide and (at most
 * three) short retries when a pending permission ask lands mid-sentence.
 *
 * ── What never happens ──────────────────────────────────────────────────────
 * No OS notification, no email, no network call, no streak, no count that
 * isn't real. See firstWeekNudges.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import { useNotificationPrefs } from '../contexts/NotificationContext';
import { computeDnd } from './useDndState';
import {
    ASK_MAX_AGE_MS, NUDGE_AUTO_HIDE_MS, SELF_MESSAGE_AFTER_DAYS, accountAgeDays, deriveFriendsInVoice, evaluateNudge,
    gateReason, isWithinFirstWeek, nudgeStillTrue, parseCreatedAt, recordRetired, recordShown,
    type FriendJoinedEvent, type FriendsInVoiceInput, type Nudge, type NudgeSnapshot, type NudgeState,
} from '../utils/firstWeekNudges';
import {
    nudges, readNudgeState, subscribeNudgeState, updateNudgeState,
} from '../utils/firstWeekNudgeStore';
import {
    ASK_CONFIRMATION_TOAST, decideNotificationAsk, hasAskedNotifications, markNotificationsAsked,
    type AskTrigger, type AskVariant,
} from '../utils/notificationAsk';

/** What is on screen right now. */
export type ActiveCard =
    | { type: 'nudge'; id: number; nudge: Nudge }
    | { type: 'ask'; id: number; variant: AskVariant; trigger: AskTrigger };

/** Omit that keeps a union a union (plain Omit collapses it to the shared keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface NudgeEngineInput {
    userId: string | null;
    /** `user.created_at` from GET /auth/me. */
    accountCreatedAt: string | null | undefined;

    friendsLoaded: boolean;
    friendCount: number;
    serversLoaded: boolean;
    serverCount: number;
    /** Raw voice state — reduced to "friends are in X" here. Omit to disable that nudge. */
    voice?: Omit<FriendsInVoiceInput, 'myUserId'>;

    // Suppression
    userStatus: string;
    activeCall: boolean;
    screensharing: boolean;
    gameActive: boolean;
    /** A modal / first-run prompt / celebration / settings is open. */
    uiBusy: boolean;

    /** Is any message of the user's own known locally? Read lazily, at evaluation. */
    hasOwnMessage: () => boolean;
}

export interface NudgeEngine {
    card: ActiveCard | null;
    /** Primary button. */
    accept: () => void;
    /** Not now / X. */
    dismiss: () => void;
    /** "Don't show these". */
    turnOff: () => void;
}

export interface NudgeActions {
    /** Run the primary action of a nudge. */
    run: (nudge: Nudge) => void;
    /** Tell the user "No more tips" etc. */
    onTurnedOff?: () => void;
    /** Raised after the ask was accepted (the OS toast is sent by the engine). */
    onAskAccepted?: () => void;
}

const TICK_MS = 60_000;
const ASK_RETRY_MS = 5_000;
const ASK_MAX_RETRIES = 3;

export function useFirstWeekNudges(input: NudgeEngineInput, actions: NudgeActions): NudgeEngine {
    const { prefs, updatePrefs } = useNotificationPrefs();
    const [card, setCard] = useState<ActiveCard | null>(null);
    // Bumped when stored state changes so the evaluation effect re-runs.
    const [stateTick, setStateTick] = useState(0);

    // Latest props/prefs for the timers and listeners below. Synced in an effect
    // (declared first, so it runs before the effects that read them in the same
    // commit) rather than during render.
    const inputRef = useRef(input);
    const actionsRef = useRef(actions);
    const prefsRef = useRef(prefs);
    const updatePrefsRef = useRef(updatePrefs);
    useEffect(() => {
        inputRef.current = input;
        actionsRef.current = actions;
        prefsRef.current = prefs;
        updatePrefsRef.current = updatePrefs;
    });

    const cardRef = useRef<ActiveCard | null>(null);
    const stateRef = useRef<NudgeState | null>(null);
    const askedRef = useRef(true); // "asked" until the marker is read: never ask before we know
    const queueRef = useRef<FriendJoinedEvent[]>([]);
    const pendingAskRef = useRef<{ trigger: AskTrigger; at: number; tries: number } | null>(null);
    const sessionStartRef = useRef(0); // set when the account's state loads
    const shownThisSessionRef = useRef(false);
    const lastInputRef = useRef(0);
    const lastKeyRef = useRef(0);
    const cardIdRef = useRef(0);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // evaluate() re-schedules itself through this (declared first so the
    // callbacks below can use it without referring to themselves).
    const evaluateRef = useRef<() => void>(() => {});

    const setCardBoth = useCallback((c: ActiveCard | null) => {
        cardRef.current = c;
        setCard(c);
    }, []);

    const clearHideTimer = useCallback(() => {
        if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    }, []);

    const persist = useCallback((fn: (s: NudgeState) => NudgeState) => {
        const uid = inputRef.current.userId;
        if (!uid || !stateRef.current) return;
        stateRef.current = updateNudgeState(uid, () => fn(stateRef.current as NudgeState));
    }, []);

    const buildSnapshot = useCallback((): NudgeSnapshot | null => {
        const i = inputRef.current;
        const state = stateRef.current;
        if (!state) return null;
        const now = Date.now();
        const dnd = i.userStatus === 'dnd' || computeDnd(prefsRef.current, {
            userStatus: i.userStatus, activeCall: i.activeCall, screensharing: i.screensharing, gameActive: i.gameActive,
        }).active;
        const doc = typeof document !== 'undefined' ? document : null;
        const createdAtMs = parseCreatedAt(i.accountCreatedAt);
        // Friends-in-voice is derived HERE, at evaluation time, and only while
        // nudges can still show — not on every render, and not for old accounts.
        const friendsInVoice = i.voice && i.userId && isWithinFirstWeek(createdAtMs, now)
            ? deriveFriendsInVoice({ ...i.voice, myUserId: i.userId })
            : null;
        return {
            now,
            userId: i.userId,
            accountCreatedAt: createdAtMs,
            state,
            sessionStartedAt: sessionStartRef.current,
            shownThisSession: shownThisSessionRef.current,
            activity: {
                focused: !!doc && doc.hasFocus(),
                visible: !!doc && !doc.hidden,
                lastInputAt: lastInputRef.current,
                lastKeyAt: lastKeyRef.current,
            },
            suppress: { dnd, inCall: i.activeCall, screensharing: i.screensharing, uiBusy: i.uiBusy },
            friends: { loaded: i.friendsLoaded, count: i.friendCount },
            servers: { loaded: i.serversLoaded, count: i.serverCount },
            friendsInVoice,
            pendingFriendJoined: queueRef.current,
            // The scan is only worth doing when "message yourself" could actually be
            // offered (it needs an account at least SELF_MESSAGE_AFTER_DAYS old and
            // no recorded send). Cheap short-circuits first.
            hasOwnMessage: state.sentMessage ? true
                : accountAgeDays(createdAtMs, now) < SELF_MESSAGE_AFTER_DAYS ? false
                : (() => { try { return i.hasOwnMessage(); } catch { return false; } })(),
        };
    }, []);

    const hideCard = useCallback(() => {
        clearHideTimer();
        setCardBoth(null);
    }, [clearHideTimer, setCardBoth]);

    const finishAsk = useCallback((outcome: 'accepted' | 'declined') => {
        const uid = inputRef.current.userId;
        askedRef.current = true;
        if (uid) markNotificationsAsked(uid, outcome);
    }, []);

    const show = useCallback((next: DistributiveOmit<ActiveCard, 'id'>) => {
        clearHideTimer();
        const c = { ...next, id: ++cardIdRef.current } as ActiveCard;
        setCardBoth(c);
        if (c.type === 'nudge') {
            shownThisSessionRef.current = true;
            if (c.nudge.kind === 'friend_joined') queueRef.current = queueRef.current.slice(1);
            persist(s => recordShown(s, c.nudge.kind, Date.now()));
            // Ignored cards leave on their own. Not "dismissed": a nudge nobody
            // touched may come back later (subject to its own caps and gap).
            hideTimerRef.current = setTimeout(() => {
                if (cardRef.current?.id === c.id) hideCard();
            }, NUDGE_AUTO_HIDE_MS);
        } else {
            // One card per session, asks included: no nudge piles on behind it.
            shownThisSessionRef.current = true;
            // An unanswered ask is a "no": we never nag about permissions.
            hideTimerRef.current = setTimeout(() => {
                if (cardRef.current?.id === c.id) { finishAsk('declined'); hideCard(); }
            }, NUDGE_AUTO_HIDE_MS * 2);
        }
    }, [clearHideTimer, hideCard, persist, setCardBoth, finishAsk]);

    const scheduleRetry = useCallback((fn: () => void) => {
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => { retryTimerRef.current = null; fn(); }, ASK_RETRY_MS);
    }, []);

    const evaluate = useCallback(() => {
        const snap = buildSnapshot();
        if (!snap) return;

        // A card is up: keep it only while it is still true and nothing
        // suppressive has started (a call, DND, a modal).
        const cur = cardRef.current;
        if (cur) {
            const blocked = gateReason(snap, { enforceLimits: false });
            // A call / DND / screen share withdraws ANY card. A modal opening
            // withdraws a nudge but leaves a permission ask alone: the person
            // just did the thing it is about, and a withdrawn ask must not be
            // recorded as an answer.
            const hardBlocked = blocked === 'in-call' || blocked === 'screensharing' || blocked === 'dnd'
                || blocked === 'off' || blocked === 'no-account'
                || (cur.type === 'nudge' && blocked === 'ui-busy');
            if (hardBlocked || (cur.type === 'nudge' && !nudgeStillTrue(snap, cur.nudge))) {
                hideCard();
            }
            return;
        }

        // The permission ask takes the moment it was waiting for.
        const ask = pendingAskRef.current;
        if (ask) {
            if (snap.now - ask.at > ASK_MAX_AGE_MS) {
                pendingAskRef.current = null;
            } else {
                const blocked = gateReason(snap, { enforceLimits: false });
                if (!blocked) {
                    pendingAskRef.current = null;
                    const variant = decideNotificationAsk({
                        prefEnabled: prefsRef.current.desktop_notifications_enabled,
                        platform: typeof window !== 'undefined' ? window.electronAPI?.platform : undefined,
                        alreadyAsked: askedRef.current,
                    });
                    if (variant) { show({ type: 'ask', variant, trigger: ask.trigger }); return; }
                } else if (blocked === 'typing' && ask.tries < ASK_MAX_RETRIES) {
                    // Right moment, mid-sentence: one short, bounded retry. A modal
                    // opening/closing or the window regaining focus re-evaluates on
                    // its own (see the change effect and the focus tick), so nothing
                    // else needs a timer.
                    ask.tries += 1;
                    scheduleRetry(() => evaluateRef.current());
                }
            }
        }

        const ev = evaluateNudge(snap);
        if (ev.nudge) show({ type: 'nudge', nudge: ev.nudge });
    }, [buildSnapshot, hideCard, scheduleRetry, show]);
    useEffect(() => { evaluateRef.current = evaluate; }, [evaluate]);

    // ── Load the account's state; reset per-session memory on account change ──
    const userId = input.userId;
    useEffect(() => {
        stateRef.current = null;
        askedRef.current = true;
        queueRef.current = [];
        pendingAskRef.current = null;
        shownThisSessionRef.current = false;
        sessionStartRef.current = Date.now();
        if (!userId) return;
        let cancelled = false;
        void (async () => {
            // Per-account records are cold right after an explicit sign-in
            // (secureLocalStore.whenAccountReady); reading earlier sees nothing
            // and would look like "fresh account, nothing shown yet".
            for (let i = 0; i < 5 && !cancelled && !secureLocalStore.isAccountReady(userId); i++) {
                try { await secureLocalStore.whenAccountReady(); } catch { /* re-checked below */ }
            }
            if (cancelled || !secureLocalStore.isAccountReady(userId)) return;
            stateRef.current = readNudgeState(userId);
            askedRef.current = hasAskedNotifications(userId);
            setStateTick(t => t + 1);
        })();
        return () => {
            cancelled = true;
            // Whatever was on screen belonged to the previous account / this mount.
            clearHideTimer();
            setCardBoth(null);
        };
    }, [userId, setCardBoth, clearHideTimer]);

    // ── Activity signal: three passive listeners, one number each ─────────────
    useEffect(() => {
        const onKey = () => { const n = Date.now(); lastInputRef.current = n; lastKeyRef.current = n; };
        const onPoint = () => { lastInputRef.current = Date.now(); };
        document.addEventListener('keydown', onKey, { capture: true, passive: true });
        document.addEventListener('pointerdown', onPoint, { capture: true, passive: true });
        document.addEventListener('wheel', onPoint, { capture: true, passive: true });
        return () => {
            document.removeEventListener('keydown', onKey, { capture: true });
            document.removeEventListener('pointerdown', onPoint, { capture: true });
            document.removeEventListener('wheel', onPoint, { capture: true });
        };
    }, []);

    // ── The tick lives only while the window is focused AND visible ───────────
    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
        const sync = () => {
            const here = document.hasFocus() && !document.hidden;
            if (here && !timer) {
                timer = setInterval(() => evaluateRef.current(), TICK_MS);
                evaluateRef.current();
            } else if (!here) {
                stop();
            }
        };
        sync();
        window.addEventListener('focus', sync);
        window.addEventListener('blur', sync);
        document.addEventListener('visibilitychange', sync);
        return () => {
            stop();
            window.removeEventListener('focus', sync);
            window.removeEventListener('blur', sync);
            document.removeEventListener('visibilitychange', sync);
        };
    }, []);

    // ── Events other features report ──────────────────────────────────────────
    useEffect(() => nudges.subscribe((e) => {
        if (!inputRef.current.userId) return;
        switch (e.kind) {
            case 'friend_joined': {
                const q = queueRef.current;
                const dup = q.some(x => (e.userId && x.userId === e.userId) || x.username === e.username);
                if (!dup && e.username) queueRef.current = [...q, { username: e.username, userId: e.userId }].slice(-5);
                evaluateRef.current();
                break;
            }
            case 'friend_request_sent':
            case 'invite_sent':
                // Only worth waiting for if there is something to ask.
                if (!askedRef.current) {
                    pendingAskRef.current = { trigger: e.kind, at: Date.now(), tries: 0 };
                    evaluateRef.current();
                }
                break;
            case 'message_sent':
                if (stateRef.current && !stateRef.current.sentMessage) persist(s => ({ ...s, sentMessage: true }));
                break;
        }
    }), [persist]);

    // ── Settings → Notifications flips the off switch from elsewhere ──────────
    useEffect(() => subscribeNudgeState(() => {
        const uid = inputRef.current.userId;
        if (!uid || !stateRef.current) return;
        stateRef.current = readNudgeState(uid);
        if (stateRef.current.off && cardRef.current?.type === 'nudge') hideCard();
        setStateTick(t => t + 1);
    }), [hideCard]);

    // ── Re-evaluate when something relevant CHANGES ───────────────────────────
    useEffect(() => { evaluateRef.current(); }, [
        stateTick, input.friendsLoaded, input.friendCount, input.serversLoaded, input.serverCount, input.voice,
        input.activeCall, input.screensharing, input.userStatus, input.uiBusy, input.gameActive,
        prefs.dnd_manual, prefs.desktop_notifications_enabled,
    ]);

    useEffect(() => () => {
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    }, []);

    // ── Card actions ──────────────────────────────────────────────────────────
    const accept = useCallback(() => {
        const cur = cardRef.current;
        if (!cur) return;
        hideCard();
        if (cur.type === 'nudge') {
            persist(s => recordRetired(s, cur.nudge.kind));
            try { actionsRef.current.run(cur.nudge); } catch { /* the action reports its own errors */ }
            return;
        }
        // The ask: turn the setting on (a no-op if it already is) and raise one
        // OS toast. On macOS that toast is what makes the system sheet appear —
        // here, in context. Windows / Linux simply see it confirm.
        updatePrefsRef.current({ desktop_notifications_enabled: true });
        try { void window.electronAPI?.notifShow?.({ ...ASK_CONFIRMATION_TOAST }); } catch { /* older main */ }
        finishAsk('accepted');
        actionsRef.current.onAskAccepted?.();
    }, [finishAsk, hideCard, persist]);

    const dismiss = useCallback(() => {
        const cur = cardRef.current;
        if (!cur) return;
        hideCard();
        if (cur.type === 'nudge') persist(s => recordRetired(s, cur.nudge.kind));
        else finishAsk('declined');
    }, [finishAsk, hideCard, persist]);

    const turnOff = useCallback(() => {
        const cur = cardRef.current;
        hideCard();
        if (cur?.type === 'ask') finishAsk('declined');
        persist(s => ({ ...s, off: true }));
        actionsRef.current.onTurnedOff?.();
    }, [finishAsk, hideCard, persist]);

    return { card, accept, dismiss, turnOff };
}
