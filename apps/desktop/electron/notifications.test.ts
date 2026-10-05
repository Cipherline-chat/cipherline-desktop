/**
 * notifications.test.ts — the toast reply path's once-only contract.
 *
 * vitest.config.ts says modules that import `electron` don't get a suite. This
 * one is the exception, deliberately: the "reply from a notification sends the
 * message twice" bug lived entirely in this file's toast lifecycle, and the
 * reason it survived review is that nothing here was executable. `electron` is
 * mocked rather than stubbed away, and the mock models the ONE property that
 * made the bug invisible to reasoning — `Notification.close()` is
 * ASYNCHRONOUS, so 'close' lands a turn after the replacement toast has been
 * registered.
 *
 * Every assertion below was first observed failing against the pre-fix module
 * in a real Electron process (real ipcMain/ipcRenderer/contextBridge, real
 * BrowserWindow, real preload); this suite is the cheap, permanent restatement
 * of that reproduction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

interface ReplyEvent { reply?: unknown }
type NotifListener = (...args: unknown[]) => void;
type ReadyHandler = (event: { sender: { id: number } }) => { pending: number };

const h = vi.hoisted(() => {
    /**
     * Minimal emitter + Notification stand-in. `close()` resolves on a later
     * turn, exactly as Electron's does — that asynchrony IS the bug surface.
     */
    class TestNotification {
        static isSupported(): boolean { return true; }
        shown = false;
        private listeners = new Map<string, NotifListener[]>();
        constructor(public opts: Record<string, unknown>) { created.push(this); }
        on(event: string, fn: NotifListener): this {
            const list = this.listeners.get(event) ?? [];
            list.push(fn);
            this.listeners.set(event, list);
            return this;
        }
        emit(event: string, ...args: unknown[]): void {
            for (const fn of this.listeners.get(event) ?? []) fn(...args);
        }
        show(): void { this.shown = true; }
        close(): void {
            queueMicrotask(() => { this.shown = false; this.emit('close'); });
        }
    }
    const created: TestNotification[] = [];
    const sends: { channel: string; data: { conv_id: string; text: string } }[] = [];
    const invokeHandlers = new Map<string, ReadyHandler>();
    const webContents = {
        id: 1,
        isDestroyed: () => false,
        send: (channel: string, data: { conv_id: string; text: string }) => { sends.push({ channel, data }); },
    };
    const win = {
        isDestroyed: () => false,
        isMinimized: () => false,
        show() { /* no-op */ },
        focus() { /* no-op */ },
        restore() { /* no-op */ },
        webContents,
    } as unknown as BrowserWindow;
    return { TestNotification, created, sends, invokeHandlers, win };
});

vi.mock('electron', () => ({
    Notification: h.TestNotification,
    BrowserWindow: class { },
    ipcMain: {
        handle: (channel: string, fn: ReadyHandler) => { h.invokeHandlers.set(channel, fn); },
    },
}));

/** A module instance with its own queue/handshake state. */
async function freshNotifications() {
    vi.resetModules();
    h.created.length = 0;
    h.sends.length = 0;
    h.invokeHandlers.clear();
    const mod = await import('./notifications');
    mod.registerNotificationReplyBridge(() => h.win);
    return mod;
}

/** Drive the renderer's `notifReplyReady()` handshake. */
function rendererReady(): void {
    h.invokeHandlers.get('notif:reply-ready')!({ sender: { id: 1 } });
}

function show(mod: typeof import('./notifications'), convId: string, body = 'hi') {
    mod.showNotification(h.win, {
        id: `notif_${convId}`, title: 'Alice', body, conv_id: convId, hasReply: true,
    });
    return h.created[h.created.length - 1];
}

function fireReply(
    toast: InstanceType<typeof h.TestNotification>,
    event: ReplyEvent,
    positional?: string,
): void {
    toast.emit('reply', event, positional);
}

const replied = () => h.sends.filter(s => s.channel === 'notification:replied').map(s => s.data.text);
const flushMicrotasks = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

let mod: typeof import('./notifications');
beforeEach(async () => { mod = await freshNotifications(); });

describe('toast replacement survives the asynchronous close', () => {
    it('leaves exactly one live toast per conversation across a burst', async () => {
        const toasts: InstanceType<typeof h.TestNotification>[] = [];
        for (let i = 1; i <= 6; i++) {
            toasts.push(show(mod, 'convA', `msg ${i}`));
            await flushMicrotasks();   // let the previous close() land
        }
        await flushMicrotasks();
        // Pre-fix this was 3: every other replacement was orphaned because the
        // outgoing toast's 'close' deleted the INCOMING toast's map entry.
        expect(toasts.filter(t => t.shown)).toHaveLength(1);
        expect(toasts[5].shown).toBe(true);
    });
});

describe('one toast, one reply', () => {
    it('delivers a single reply once', () => {
        rendererReady();
        fireReply(show(mod, 'convB'), { reply: 'sure' });
        expect(replied()).toEqual(['sure']);
    });

    it('ignores a second reply event from the same toast', () => {
        rendererReady();
        const toast = show(mod, 'convB');
        fireReply(toast, { reply: 'sure' });
        fireReply(toast, { reply: 'sure' });
        fireReply(toast, { reply: 'and again' });
        expect(replied()).toEqual(['sure']);
    });

    it('dismisses the toast it just consumed', async () => {
        rendererReady();
        const toast = show(mod, 'convB');
        expect(toast.shown).toBe(true);
        fireReply(toast, { reply: 'sure' });
        await flushMicrotasks();
        // A toast left live in the Action Center can simply be replied to again.
        expect(toast.shown).toBe(false);
    });

    it('reads the reply off the positional arg too', () => {
        rendererReady();
        fireReply(show(mod, 'convB'), {}, 'positional');
        expect(replied()).toEqual(['positional']);
    });
});

describe('what must NOT be deduplicated', () => {
    it('lets a second toast for the same conversation reply again', async () => {
        rendererReady();
        fireReply(show(mod, 'convC', 'msg 1'), { reply: 'one' });
        await flushMicrotasks();
        fireReply(show(mod, 'convC', 'msg 2'), { reply: 'two' });
        // The toast id is `notif_<conv_id>` — stable per conversation. Keying
        // idempotence on it would swallow this perfectly legitimate reply.
        expect(replied()).toEqual(['one', 'two']);
    });

    it('does not burn the toast on an empty submission', () => {
        rendererReady();
        const toast = show(mod, 'convC');
        fireReply(toast, { reply: '   ' });
        expect(replied()).toEqual([]);
        fireReply(toast, { reply: 'real one' });
        expect(replied()).toEqual(['real one']);
    });
});

describe('the reload queue still delivers exactly once', () => {
    it('holds a reply while the renderer is down and drains it on the handshake', () => {
        mod.markRendererReplyListenerLost();
        fireReply(show(mod, 'convD'), { reply: 'queued' });
        expect(replied()).toEqual([]);          // nothing sent into a dead renderer
        rendererReady();
        expect(replied()).toEqual(['queued']);  // exactly once, not zero and not twice
    });

    it('does not re-deliver on a repeated readiness announcement', () => {
        mod.markRendererReplyListenerLost();
        fireReply(show(mod, 'convD'), { reply: 'queued' });
        rendererReady();
        rendererReady();
        rendererReady();
        expect(replied()).toEqual(['queued']);
    });

    it('does not re-deliver when the grace-period fallback fires after the handshake', () => {
        vi.useFakeTimers();
        try {
            mod.markRendererReplyListenerLost();
            fireReply(show(mod, 'convD'), { reply: 'queued' });
            rendererReady();
            vi.advanceTimersByTime(30_000);
            expect(replied()).toEqual(['queued']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('delivers via the grace-period fallback when no handshake ever arrives', () => {
        vi.useFakeTimers();
        try {
            mod.markRendererReplyListenerLost();
            fireReply(show(mod, 'convD'), { reply: 'no handshake' });
            expect(replied()).toEqual([]);
            vi.advanceTimersByTime(5_000);
            expect(replied()).toEqual(['no handshake']);
        } finally {
            vi.useRealTimers();
        }
    });
});
