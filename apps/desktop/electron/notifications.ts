/**
 * notifications.ts — Electron main-process OS toast dispatcher.
 *
 * Design choices:
 *   - All sounds are handled in the renderer (per-category, volume-controlled)
 *     so we pass `silent: true` to the OS notification. That way the OS doesn't
 *     also play a generic ping on top of the renderer's sound.
 *   - `hasReply: true` adds an inline reply text field. This is supported on
 *     BOTH macOS and Windows (Electron >= 27; `hasReply`, `replyPlaceholder`
 *     and the 'reply' event are all documented `@platform darwin,win32`) — the
 *     comments here used to say macOS-only, which is why the Windows path went
 *     unexamined for so long.
 *   - Click handler focuses the window and sends a `notification:clicked` IPC
 *     event carrying the conversation/channel ID so the renderer can jump to it.
 *
 * Reply delivery is deliberately NOT fire-and-forget. The reply text is useless
 * in the main process — message encryption keys and session state live in the
 * renderer — so all main can do is hand it over. But `webContents.send()` into
 * a renderer that isn't listening is a silent no-op, and a Windows toast can be
 * replied to from the Action Center long after it was raised, by which time the
 * renderer may have reloaded (Ctrl+R, HMR, crash-recovery) and missed it. So
 * replies queue until the renderer announces it has a listener bound, and are
 * flushed then. A reply that cannot be delivered is reported back rather than
 * dropped.
 *
 * ONCE-ONLY LIVES ON THE TOAST, NOT IN THE PLUMBING. The queue/handshake path
 * below delivers each queued reply exactly once (verified exhaustively), and
 * the renderer binds exactly one listener — so the only place a single reported
 * "reply" could become two sent messages was the toast itself: replace-by-id
 * used to break under `close()`'s asynchrony and leave several live replyable
 * toasts per conversation, and a toast was neither dismissed after a reply nor
 * guarded against firing 'reply' twice. Both are fixed in `showNotification`.
 * This matters because nothing downstream can collapse a duplicate: the
 * renderer mints a fresh `client_msg_id` per reply and neither send endpoint
 * has an idempotency key, so a second delivery is a second real message.
 */

import { Notification, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface NotifShowPayload {
    /** Unique ID for deduplication — same id replaces the previous toast. */
    id: string;
    title: string;
    body: string;
    /** Conversation or channel ID to navigate to on click. */
    conv_id: string;
    /** If true, renders an inline reply field (macOS + Windows). */
    hasReply?: boolean;
    /** Reply placeholder text (macOS + Windows). */
    replyPlaceholder?: string;
}

/** Map of active Notification objects so we can close/replace by ID. */
const active = new Map<string, InstanceType<typeof Notification>>();

/** A reply the user submitted that the renderer hasn't taken delivery of yet. */
interface PendingReply {
    conv_id: string;
    text: string;
    at: number;
}

/**
 * Replies waiting for a renderer with a bound listener.
 *
 * Bounded and TTL'd on purpose: a reply that surfaces half an hour after the
 * user typed it would be a nasty surprise, so a stale one is dropped (and
 * logged) rather than sent. The window is generous enough to cover a renderer
 * reload, which is the case this queue actually exists for.
 */
const pendingReplies: PendingReply[] = [];
const MAX_PENDING_REPLIES = 20;
const PENDING_REPLY_TTL_MS = 5 * 60 * 1000;

/** Set once the renderer confirms it has bound `notification:replied`. */
let rendererReplyListenerReady = false;
let replyWindow: BrowserWindow | null = null;

function canDeliverReplies(): boolean {
    return (
        rendererReplyListenerReady &&
        !!replyWindow &&
        !replyWindow.isDestroyed() &&
        !replyWindow.webContents.isDestroyed()
    );
}

function flushPendingReplies(): void {
    if (!canDeliverReplies()) return;
    const now = Date.now();
    while (pendingReplies.length > 0) {
        const item = pendingReplies.shift()!;
        if (now - item.at > PENDING_REPLY_TTL_MS) {
            // Too old to send without surprising the user.
            console.warn('[notif] dropping stale notification reply (older than TTL)');
            continue;
        }
        replyWindow!.webContents.send('notification:replied', {
            conv_id: item.conv_id,
            text: item.text,
        });
    }
}

/**
 * Deliver without waiting for the handshake.
 *
 * The queue must never make things WORSE than the old fire-and-forget send, and
 * there is one way it could: a renderer that never announces itself. That is not
 * hypothetical in Tier-1 dev, where the Windows test PC compiles `electron/`
 * from its own checkout but loads the renderer from the dev box's Vite server —
 * so a new main process can be paired with an older renderer that has no
 * `notifReplyReady`. After a short grace period we send anyway: an undelivered
 * IPC message is no worse than the drop we used to have, and a delivered one is
 * the whole point.
 */
const REPLY_HANDSHAKE_GRACE_MS = 3000;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFallbackDelivery(): void {
    if (fallbackTimer || pendingReplies.length === 0) return;
    fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (pendingReplies.length === 0) return;
        const win = replyWindow;
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            console.warn('[notif] delivering queued reply without a renderer handshake');
            rendererReplyListenerReady = true;   // assume a listener; best effort
            flushPendingReplies();
        }
    }, REPLY_HANDSHAKE_GRACE_MS);
    // Don't hold the event loop open on this alone.
    (fallbackTimer as any)?.unref?.();
}

function queueReply(conv_id: string, text: string): void {
    pendingReplies.push({ conv_id, text, at: Date.now() });
    // Oldest-first eviction; a flood here means the renderer is wedged.
    while (pendingReplies.length > MAX_PENDING_REPLIES) pendingReplies.shift();
    flushPendingReplies();
    if (pendingReplies.length > 0) scheduleFallbackDelivery();
}

/**
 * Wire the renderer-ready handshake. Called once from main during IPC setup.
 *
 * The renderer calls `notifReplyReady()` when it binds its reply listener (and
 * again on every rebind after a reload); that both marks the channel live and
 * drains anything the user typed while it wasn't.
 */
export function registerNotificationReplyBridge(getWindow: () => BrowserWindow | null): void {
    ipcMain.handle('notif:reply-ready', (e) => {
        const win = getWindow();
        replyWindow = win;
        // Only trust the handshake from the window we actually notify into.
        if (win && !win.isDestroyed() && win.webContents.id === e.sender.id) {
            rendererReplyListenerReady = true;
            flushPendingReplies();
        }
        return { pending: pendingReplies.length };
    });
}

/**
 * Forget the renderer's listener. A reloading renderer drops its ipcRenderer
 * handlers, so anything sent between the unload and the next `notif:reply-ready`
 * would fall on the floor — queue instead until it re-announces.
 */
export function markRendererReplyListenerLost(): void {
    rendererReplyListenerReady = false;
}

function getIconPath(): string {
    const devPath = path.join(__dirname, '../build-assets/icon.png');
    if (fs.existsSync(devPath)) return devPath;
    return path.join(process.resourcesPath, 'icon.png');
}

export function showNotification(
    win: BrowserWindow,
    payload: NotifShowPayload,
): void {
    if (!Notification.isSupported()) return;

    // Close any existing toast with the same ID (dedup / replace)
    const prev = active.get(payload.id);
    if (prev) {
        try { prev.close(); } catch {}
        active.delete(payload.id);
    }

    const notif = new Notification({
        title: payload.title,
        body: payload.body,
        silent: true,                          // renderer handles sound
        icon: getIconPath(),
        hasReply: !!payload.hasReply,
        replyPlaceholder: payload.replyPlaceholder ?? 'Reply…',
        timeoutType: 'default',
        urgency: 'normal',
    });

    /**
     * Stop tracking this toast — but ONLY if it is still the tracked one.
     *
     * `close()` is asynchronous: Electron dismisses the OS toast and emits
     * 'close' on a later turn. An unconditional `active.delete(payload.id)`
     * from the PREVIOUS toast's 'close' therefore lands AFTER the replacement
     * has already been registered and evicts the replacement's entry. The next
     * `showNotification` for this conversation then finds no `prev`, doesn't
     * close anything, and leaves a second live toast behind — measured: six
     * messages in one conversation left THREE live, individually replyable
     * toasts instead of one. Comparing identity makes the delete idempotent
     * and order-independent.
     */
    const forgetIfCurrent = () => {
        if (active.get(payload.id) === notif) active.delete(payload.id);
    };

    notif.on('click', () => {
        // P2-ELEC-15: guard both the focus calls and the IPC send.
        if (!win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            win.webContents.send('notification:clicked', payload.conv_id);
        }
        forgetIfCurrent();
    });

    /**
     * ONE TOAST, ONE REPLY.
     *
     * This is the once-only point of the whole reply path, and it has to be
     * here rather than downstream: the queue/handshake machinery below is
     * already provably single-delivery, and the renderer holds exactly one
     * listener, but nothing stopped a single toast from producing a second
     * reply — and a second reply is a second message, because `sendQuickReply`
     * mints a fresh `client_msg_id` per call and neither send endpoint has an
     * idempotency key, so no layer downstream can collapse it.
     *
     * Two ways that happened. The toast was never dismissed after a reply
     * (`active.delete` forgot it, but the OS toast stayed live and interactive
     * in the Action Center, so it could simply be submitted again), and the
     * handler had no guard against the 'reply' event arriving twice for one
     * submission. The flag is per-Notification-object, so a genuine second
     * reply — which needs a new toast, hence a new object — is unaffected.
     *
     * Note the granularity: NOT `payload.id`. That is `notif_<conv_id>`, stable
     * for the life of the conversation, so keying idempotence on it would
     * silently swallow a user's legitimate second reply to the same person.
     */
    let replied = false;
    notif.on('reply', (event: unknown, replyText?: string) => {
        if (replied) return;

        // Electron moved the reply text onto the event object; the positional
        // arg still works but is deprecated. Read the event first and fall back,
        // so this keeps working across that deprecation in either direction.
        const fromEvent = (event as { reply?: unknown } | undefined)?.reply;
        const text = typeof fromEvent === 'string' ? fromEvent
            : typeof replyText === 'string' ? replyText
            : '';

        if (!text.trim()) {          // user submitted an empty reply
            forgetIfCurrent();
            return;                  // not a reply — don't burn the toast
        }

        replied = true;
        forgetIfCurrent();
        // Dismiss the toast we just consumed. Without this the Action Center
        // entry survives its own reply and can be replied to again.
        try { notif.close(); } catch { /* already gone */ }

        // Prefer the window this toast belongs to, but fall back to whatever
        // window the bridge currently knows about: `win` is captured at show
        // time and a Windows Action Center reply can outlive it.
        if (!win.isDestroyed()) replyWindow = win;
        queueReply(payload.conv_id, text);
    });

    notif.on('close', forgetIfCurrent);

    notif.show();
    active.set(payload.id, notif);
}

/** Close all active notifications (e.g. on sign-out or DND enabled). */
export function closeAllNotifications(): void {
    for (const [id, notif] of active) {
        try { notif.close(); } catch {}
    }
    active.clear();
}
