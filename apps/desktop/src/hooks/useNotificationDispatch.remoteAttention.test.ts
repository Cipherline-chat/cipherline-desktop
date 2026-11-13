/**
 * Owner rule R6, end to end through the real useNotificationDispatch: while one
 * of the user's PHONES is attentive (the mobile app is open in their hand) this
 * PC raises no OS toast, plays no notification sound and does not flash the
 * taskbar. Badges and in-app unread keep updating (the caller's decision object
 * is never touched). When the phone goes back to the background the desktop
 * notifies again, and an unknown answer (older server, dropped ack, closed
 * socket) means "notify as before".
 *
 * React is stubbed to plain function calls (the hook only uses useCallback /
 * useEffect / useRef / useState as stable holders), the prefs context is stubbed;
 * the decision, the gate, remoteAttention and the toast path are production code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react', () => ({
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void) => { fn(); },
    useRef: (v: unknown) => ({ current: v }),
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
}));

let prefs: Record<string, unknown> = {};
vi.mock('../contexts/NotificationContext', () => ({ useNotificationPrefs: () => ({ prefs }) }));
const played = vi.hoisted(() => [] as string[]);
vi.mock('../utils/notificationSounds', () => ({ playSound: (cat: string) => { played.push(cat); } }));
vi.mock('./useEncryptedAvatar', () => ({
    peekAvatarUrl: () => null,
    warmAvatarsFromDiskCache: async () => 0,
}));
vi.mock('../utils/peerIdentityCache', () => ({ lookupUserAvatarId: () => null }));

const { useNotificationDispatch } = await import('./useNotificationDispatch');
const { applyRemoteAttention, resetRemoteAttention, REMOTE_ATTENTION_FRESH_MS } = await import('../utils/remoteAttention');
const { resolveNotification } = await import('../utils/notificationDecision');

const shown: Array<Record<string, unknown>> = [];
let flashes = 0;
const g = globalThis as unknown as { window: { electronAPI?: unknown }; document: { hasFocus?: () => boolean } };

function payload(over: Record<string, unknown> = {}) {
    return {
        category: 'message' as const,
        conv_id: 'c1',
        sender_name: 'Sam',
        sender_user_id: null,
        text: 'hello',
        active_conv_id: null,
        ...over,
    };
}
const flush = () => new Promise(r => setTimeout(r, 10));

beforeEach(() => {
    shown.length = 0;
    played.length = 0;
    flashes = 0;
    resetRemoteAttention();
    g.window.electronAPI = {
        notifShow: (p: Record<string, unknown>) => { shown.push(p); },
        notifFlashTaskbar: () => { flashes++; },
    };
    g.document.hasFocus = () => false;
    prefs = {
        desktop_notifications_enabled: true, sounds_enabled: true, show_preview: 'full',
        show_sender_avatar: false, quick_reply_enabled: true, keywords: [],
        suppress_when_active_conv: true, suppress_when_window_focused: true, flash_taskbar: true,
        dnd_manual: false, dnd_schedule: { enabled: false, start_minute: 0, end_minute: 0, days: [] },
        dnd_auto: {}, dnd_let_mentions_through: false,
    };
});

describe('useNotificationDispatch — a phone is attentive (R6)', () => {
    it('positive control: with no phone attentive, the PC toasts, sounds and flashes', async () => {
        const notify = useNotificationDispatch();
        notify(payload());
        await flush();
        expect(shown).toHaveLength(1);
        expect(played).toEqual(['message']);
        expect(flashes).toBe(1);
    });

    it('mobile attentive → silent: no toast, no sound, no taskbar flash', async () => {
        applyRemoteAttention({ mobile_attentive: true });
        const notify = useNotificationDispatch();
        notify(payload());
        await flush();
        expect(shown).toHaveLength(0);
        expect(played).toEqual([]);
        expect(flashes).toBe(0);
    });

    it('a mention is silenced too (R6 says no notification at all)', async () => {
        applyRemoteAttention({ mobile_attentive: true });
        const notify = useNotificationDispatch();
        notify(payload({ category: 'mention', is_mention: true }));
        await flush();
        expect(shown).toHaveLength(0);
        expect(played).toEqual([]);
        expect(flashes).toBe(0);
    });

    it('flips back → notifies again', async () => {
        const notify = useNotificationDispatch();
        applyRemoteAttention({ mobile_attentive: true });
        notify(payload());
        await flush();
        expect(shown).toHaveLength(0);

        // the phone went to the background; the server pushed presence:attention
        applyRemoteAttention({ mobile_attentive: false });
        notify(payload());
        await flush();
        expect(shown).toHaveLength(1);
        expect(played).toEqual(['message']);
        expect(flashes).toBe(1);
    });

    it('the caller\'s decision (which feeds the badge counters) is not mutated', async () => {
        applyRemoteAttention({ mobile_attentive: true });
        const decision = resolveNotification({
            text: 'hello', directMention: false, keywords: [], mode: 'all', windowFocused: false,
            isActiveConversation: false, suppressWhenActiveConv: true, dndActive: false, dndLetMentionsThrough: false,
        });
        const before = { ...decision };
        const notify = useNotificationDispatch();
        notify(payload({ decision }));
        await flush();
        expect(shown).toHaveLength(0);
        expect(decision).toEqual(before);
        // …and it still says "count this as unread": the badge still updates.
        expect(decision.countsUnread).toBe(true);
    });

    describe('unknown means notify as before', () => {
        it('no answer received yet', async () => {
            const notify = useNotificationDispatch();
            notify(payload());
            await flush();
            expect(shown).toHaveLength(1);
        });

        it.each([
            ['an ack without the field (older server)', undefined],
            ['an empty data object', {}],
            ['a non-boolean field', { mobile_attentive: 'true' }],
            ['null data', null],
        ])('%s clears a previous "attentive"', async (_label, data) => {
            applyRemoteAttention({ mobile_attentive: true });
            applyRemoteAttention(data);
            const notify = useNotificationDispatch();
            notify(payload());
            await flush();
            expect(shown).toHaveLength(1);
            expect(played).toEqual(['message']);
        });

        it('an answer older than the freshness window is not believed (dead socket)', async () => {
            applyRemoteAttention({ mobile_attentive: true }, Date.now() - REMOTE_ATTENTION_FRESH_MS - 1_000);
            const notify = useNotificationDispatch();
            notify(payload());
            await flush();
            expect(shown).toHaveLength(1);
        });

        it('a closed socket forgets the answer', async () => {
            applyRemoteAttention({ mobile_attentive: true });
            resetRemoteAttention();
            const notify = useNotificationDispatch();
            notify(payload());
            await flush();
            expect(shown).toHaveLength(1);
        });
    });

    it('a ringing call is never silenced by this rule', async () => {
        applyRemoteAttention({ mobile_attentive: true });
        const notify = useNotificationDispatch();
        notify(payload({ category: 'call', is_mention: true, text: 'Sam is calling…' }));
        await flush();
        expect(shown).toHaveLength(1);
    });
});
