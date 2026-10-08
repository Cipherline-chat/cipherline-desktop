/**
 * End-to-end through the real useNotificationDispatch: what reaches
 * `electronAPI.notifShow` when the toast may / may not carry the sender's
 * avatar. React is stubbed to plain function calls (the hook only uses
 * useCallback / useEffect / useRef / useState as stable holders), the prefs context and
 * the avatar caches are stubbed, everything else is the production code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('react', () => ({
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void) => { fn(); },
    useRef: (v: unknown) => ({ current: v }),
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
}));

let prefs: Record<string, unknown> = {};
vi.mock('../contexts/NotificationContext', () => ({ useNotificationPrefs: () => ({ prefs }) }));
vi.mock('../utils/notificationSounds', () => ({ playSound: () => {} }));

const memory = new Map<string, string>();
const avatarIds = new Map<string, string>();
vi.mock('./useEncryptedAvatar', () => ({
    peekAvatarUrl: (id: string) => memory.get(id) ?? null,
    warmAvatarsFromDiskCache: async () => 0,
}));
vi.mock('../utils/peerIdentityCache', () => ({
    lookupUserAvatarId: (uid: string) => avatarIds.get(uid) ?? null,
}));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
vi.mock('../utils/notificationAvatar', async (orig) => ({
    ...(await orig<typeof import('../utils/notificationAvatar')>()),
    rasterizeCircleIcon: async () => PNG,
}));

const { useNotificationDispatch } = await import('./useNotificationDispatch');
const { __resetNotificationIconCache } = await import('../utils/notificationAvatar');

const shown: Array<Record<string, unknown>> = [];
const g = globalThis as unknown as { window: { electronAPI?: unknown }; document: { hasFocus?: () => boolean } };

const FRIEND = 'u-friend';
const STRANGER = 'u-stranger';
const gate = (uid: string | null | undefined) => uid === FRIEND;

function payload(over: Record<string, unknown> = {}) {
    return {
        category: 'message' as const,
        conv_id: 'c1',
        sender_name: 'Sam',
        sender_user_id: FRIEND,
        text: 'hello',
        active_conv_id: null,
        ...over,
    };
}
const flush = () => new Promise(r => setTimeout(r, 10));

beforeEach(() => {
    shown.length = 0;
    memory.clear();
    avatarIds.clear();
    __resetNotificationIconCache();
    g.window.electronAPI = { notifShow: (p: Record<string, unknown>) => { shown.push(p); } };
    g.document.hasFocus = () => false;
    prefs = {
        desktop_notifications_enabled: true, sounds_enabled: false, show_preview: 'full',
        show_sender_avatar: true, quick_reply_enabled: true, keywords: [],
        suppress_when_active_conv: true, suppress_when_window_focused: true, flash_taskbar: false,
        dnd_manual: false, dnd_schedule: { enabled: false, start_minute: 0, end_minute: 0, days: [] },
        dnd_auto: {}, dnd_let_mentions_through: false,
    };
    avatarIds.set(FRIEND, 'att-friend');
    avatarIds.set(STRANGER, 'att-stranger');
    memory.set('att-friend', 'blob:friend');
    memory.set('att-stranger', 'blob:stranger');
});

describe('useNotificationDispatch — sender avatar on the toast', () => {
    it('positive control: a friend with a cached avatar → iconDataUrl on the toast', async () => {
        const notify = useNotificationDispatch({ getAvatarGate: () => gate });
        notify(payload());
        await flush();
        expect(shown).toHaveLength(1);
        expect(shown[0]).toMatchObject({ title: 'Sam', body: 'hello', iconDataUrl: PNG });
    });

    it('hidden preview → no avatar (and the toast still goes out)', async () => {
        prefs.show_preview = 'hidden';
        const notify = useNotificationDispatch({ getAvatarGate: () => gate });
        notify(payload());
        await flush();
        expect(shown).toHaveLength(1);
        expect(shown[0].title).toBe('Cipherline');
        expect(shown[0]).not.toHaveProperty('iconDataUrl');
    });

    it('sender-name-only preview → no avatar either (message content off → no picture)', async () => {
        prefs.show_preview = 'sender_only';
        const notify = useNotificationDispatch({ getAvatarGate: () => gate });
        notify(payload());
        await flush();
        expect(shown).toHaveLength(1);
        expect(shown[0]).not.toHaveProperty('iconDataUrl');
    });

    it('the toggle off → no avatar', async () => {
        prefs.show_sender_avatar = false;
        const notify = useNotificationDispatch({ getAvatarGate: () => gate });
        notify(payload());
        await flush();
        expect(shown[0]).not.toHaveProperty('iconDataUrl');
    });

    it('a stranger → no avatar, even though their picture is in the cache', async () => {
        const notify = useNotificationDispatch({ getAvatarGate: () => gate });
        notify(payload({ sender_user_id: STRANGER }));
        await flush();
        expect(shown).toHaveLength(1);
        expect(shown[0]).not.toHaveProperty('iconDataUrl');
    });

    it('no gate wired (fail closed) → no avatar', async () => {
        const notify = useNotificationDispatch();
        notify(payload());
        await flush();
        expect(shown[0]).not.toHaveProperty('iconDataUrl');
    });

    it('avatar not decrypted yet (cache miss) → toast goes out with the app icon', async () => {
        memory.clear();
        const notify = useNotificationDispatch({ getAvatarGate: () => gate });
        notify(payload());
        await flush();
        expect(shown).toHaveLength(1);
        expect(shown[0]).not.toHaveProperty('iconDataUrl');
    });

    it('a call toast carries the caller avatar via the explicit hint', async () => {
        const notify = useNotificationDispatch({ getAvatarGate: () => gate });
        notify(payload({ category: 'call', sender_avatar_id: 'att-friend', text: 'Sam is calling…' }));
        await flush();
        expect(shown[0]).toMatchObject({ iconDataUrl: PNG, hasReply: false });
    });

    it('a toast with no avatar is not overtaken by an earlier one still waiting for its avatar', async () => {
        const notify = useNotificationDispatch({ getAvatarGate: () => gate });
        notify(payload({ text: 'first' }));                          // waits (async avatar)
        notify(payload({ text: 'second', sender_user_id: null }));   // immediate, no avatar
        await flush();
        expect(shown.map(s => s.body)).toEqual(['second']);
    });
});

describe('Dashboard wiring', () => {
    const src = fs.readFileSync(path.join(__dirname, '../components/Dashboard.tsx'), 'utf8');

    it('passes the live friend gate into the dispatcher', () => {
        expect(src).toMatch(/useNotificationDispatch\(\{\s*getAvatarGate: \(\) => notifAvatarGateRef\.current\s*\}\)/);
        expect(src).toMatch(/notifAvatarGateRef\.current = isFriendOrSelf;/);
    });

    it('every notify() call site names the sender', () => {
        const calls = src.split(/(?<![.\w])notify\(\{/).slice(1).map(s => s.slice(0, 900));
        expect(calls.length).toBe(3);
        for (const c of calls) expect(c).toMatch(/sender_user_id:/);
    });
});
