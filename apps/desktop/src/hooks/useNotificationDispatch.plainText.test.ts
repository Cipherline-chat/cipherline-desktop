/**
 * End-to-end through the real useNotificationDispatch: what an OS toast SHOWS
 * for a formatted message. Owner: "I don't want to see a notification come
 * through with **testing** etc, I just want it to have the plain text."
 *   `**testing**`  -> "testing"
 *   `||secret||`   -> "[spoiler]", never "secret"
 *   a code fence   -> its code (the code IS the message; "[code]" would hide it)
 * The decision (mention / keyword) still reads the raw text.
 * React is stubbed to plain function calls as in useNotificationDispatch.avatar.test.ts.
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
vi.mock('../utils/notificationSounds', () => ({ playSound: () => {} }));
vi.mock('./useEncryptedAvatar', () => ({ peekAvatarUrl: () => null, warmAvatarsFromDiskCache: async () => 0 }));
vi.mock('../utils/peerIdentityCache', () => ({ lookupUserAvatarId: () => null }));

const { useNotificationDispatch } = await import('./useNotificationDispatch');

const shown: Array<Record<string, unknown>> = [];
const g = globalThis as unknown as { window: { electronAPI?: unknown }; document: { hasFocus?: () => boolean } };

beforeEach(() => {
    shown.length = 0;
    g.window.electronAPI = { notifShow: (p: Record<string, unknown>) => { shown.push(p); } };
    g.document.hasFocus = () => false;
    prefs = {
        desktop_notifications_enabled: true, sounds_enabled: false, show_preview: 'full',
        show_sender_avatar: false, quick_reply_enabled: true, keywords: ['deploy'],
        suppress_when_active_conv: true, suppress_when_window_focused: true, flash_taskbar: false,
        dnd_manual: false, dnd_schedule: { enabled: false, start_minute: 0, end_minute: 0, days: [] },
        dnd_auto: {}, dnd_let_mentions_through: false,
    };
});

const flush = () => new Promise(r => setTimeout(r, 10));

async function bodyFor(text: string, over: Record<string, unknown> = {}): Promise<string> {
    // React is stubbed to plain calls above, so the hook is an ordinary function here.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const notify = useNotificationDispatch() as unknown as (p: unknown) => void;
    notify({ category: 'message', conv_id: `c-${Math.random()}`, sender_name: 'Sam', sender_user_id: 'u1', text, active_conv_id: null, ...over });
    await flush();
    return String(shown[shown.length - 1]?.body ?? '');
}

describe('an OS notification shows plain text', () => {
    it('**testing** -> testing', async () => {
        expect(await bodyFor('**testing**')).toBe('testing');
    });
    it('every marker is stripped', async () => {
        expect(await bodyFor('# Big __news__: ~~old~~ *new* `v2` [notes](https://x.y/n) <https://a.b> \\*ok\\*'))
            .toBe('Big news: old new v2 notes https://a.b *ok*');
        expect(await bodyFor('> quoted\n- one\n- two\n-# small')).toBe('quoted\n• one\n• two\nsmall');
    });
    it('a spoiler is NEVER shown in clear', async () => {
        const body = await bodyFor('the ending: ||he was a ghost||');
        expect(body).toBe('the ending: [spoiler]');
        expect(body).not.toContain('ghost');
    });
    it('a code fence shows its code, without the fence', async () => {
        expect(await bodyFor('try this:\n```bash\nnpm run deploy\n```')).toBe('try this:\nnpm run deploy');
    });
    it('mentions read as names', async () => {
        expect(await bodyFor('**hey <@u:u9:dawson>**')).toBe('hey @dawson');
    });
});
