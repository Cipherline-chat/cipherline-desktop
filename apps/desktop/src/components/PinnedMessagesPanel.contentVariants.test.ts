// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Must exist BEFORE PinnedMessagesPanel's import graph is evaluated:
// EncryptedAvatar's transitive imports touch utils/clPhysics.ts, which calls
// window.matchMedia at module load and throws under jsdom otherwise (see the
// identical guard in ReactionPill.anim.test.ts).
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// PinnedMessagesPanel calls useAuth() unconditionally (just to resolve "you"
// for own-message rows) — mock it so this test doesn't need a full
// AuthProvider tree. Every test message here belongs to a device NOT in
// myDeviceIds, so `user` itself is never read for isMe/avatar resolution.
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ user: { user_id: 'me-1', username: 'Me', avatar_url: null } }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PinnedMessagesPanel: any;

let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(async () => {
    ({ default: PinnedMessagesPanel } = await import('./PinnedMessagesPanel'));
    // 60s: pulls in the full component's import graph (icons, EncryptedAvatar,
    // hooks) — same heavy-import allowance as ChatPane-adjacent specs.
}, 60000);

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    vi.restoreAllMocks();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BASE_PROPS: any = {
    pinnedMsgIds: [],
    objectUrls: {},
    searchQuery: '',
    onJumpTo: () => {},
    onUnpin: () => {},
    onClose: () => {},
    deviceToUsername: { 'dev-other': 'Alice' },
    userIdToUsername: { 'user-other': 'Alice' },
    myDeviceIds: new Set<string>(), // empty — nobody in these fixtures is "me"
    token: null,
};

/** Mounts the panel with exactly one pinned message and returns the
 *  message row's content box — everything BELOW the sender-name/timestamp
 *  header line, which renders unconditionally regardless of content type
 *  and therefore can't be used to prove the content itself rendered. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderOne(msgId: string, content: any): Element[] {
    const msg = {
        id: msgId,
        sender_device_id: 'dev-other',
        sender_user_id: 'user-other',
        timestamp: '2026-01-01T00:00:00.000Z',
        content,
    };
    act(() => {
        root!.render(React.createElement(PinnedMessagesPanel, {
            ...BASE_PROPS,
            messages: [msg],
            pinnedMsgIds: [msgId],
        }));
    });
    const contentBox = host.querySelector('.flex-1.min-w-0');
    if (!contentBox) return [];
    // First child is always the sender-name/timestamp header row (see
    // PinnedMessagesPanel's `flex items-baseline gap-2 mb-1` div) —
    // everything after it is the content-type-specific branch.
    return Array.from(contentBox.children).slice(1);
}

/** True if at least one of the row's post-header children carries visible
 *  content — non-whitespace text, or a media element (img/video) whose
 *  content is conveyed by the element itself rather than textContent. */
function hasVisibleContent(children: Element[]): boolean {
    return children.some(el =>
        (el.textContent ?? '').trim().length > 0 ||
        el.tagName === 'IMG' || el.tagName === 'VIDEO' ||
        !!el.querySelector('img, video'),
    );
}

describe('PinnedMessagesPanel — every ClientContent variant renders non-empty', () => {
    // The three variants ChatPane's Pin action actually allows pinning today
    // (see the isTextLike checks around its Pin button) — these must keep
    // rendering their real content, not just fall into the generic fallback.
    it('text', () => {
        const children = renderOne('m-text', { type: 'text', text: 'hello world' });
        expect(hasVisibleContent(children)).toBe(true);
        expect(host.textContent).toContain('hello world');
    });

    it('attachment (non-image, no thumbnail)', () => {
        const children = renderOne('m-att', {
            type: 'attachment', attachment_id: 'a1', filename: 'report.pdf',
            byte_size: 10, mime: 'application/pdf', file_key_b64: 'k',
            file_nonce_b64: 'n', enc_alg: 'aes256gcm', chunk_size: 1,
        });
        expect(hasVisibleContent(children)).toBe(true);
        expect(host.textContent).toContain('report.pdf');
    });

    it('server_invite — was rendering blank before this fix', () => {
        const children = renderOne('m-invite', { type: 'server_invite', code: 'ABC123' });
        expect(hasVisibleContent(children)).toBe(true);
        expect(host.textContent).toContain('Server invite');
        expect(host.textContent).toContain('ABC123');
    });

    // Every other ClientContent union member (packages/shared/content.ts).
    // None of these are reachable through the app's own Pin button today —
    // ChatPane gates Pin to text/attachment/server_invite only — but nothing
    // enforces that at THIS layer, so each must still hit the generic
    // fallback rather than silently rendering nothing.
    const otherVariants: Record<string, unknown> = {
        call_key: {
            type: 'call_key', call_id: 'c1', epoch: 1, e2ee_key_b64: 'k',
            key_id: 'k1', rotates_at: '2026-01-01T00:00:00.000Z',
        },
        call_event: { type: 'call_event', call_id: 'c1', event: 'started' },
        edit: { type: 'edit', target_id: 'x', text: 'y' },
        delete: { type: 'delete', target_id: 'x' },
        reaction: { type: 'reaction', target_id: 'x', emoji: '👍', action: 'add' },
        pin: { type: 'pin', conversation_id: 'c1', target_id: 'x', action: 'add', at: 0 },
        profile_update: { type: 'profile_update', user_id: 'u1' },
        group_update: { type: 'group_update', conversation_id: 'c1' },
        system: { type: 'system', kind: 'x', data: {} },
        channel_key: {
            type: 'channel_key', channel_id: 'ch1', epoch: 1, key_b64: 'k',
            rotates_at: '2026-01-01T00:00:00.000Z', rotation_reason: 'initial',
        },
        channel_message: {
            type: 'channel_message', channel_id: 'ch1', epoch: 1, nonce_b64: 'n',
            ciphertext_b64: 'c', sender_device_id: 'dev-other', signature_b64: 's',
            created_at: '2026-01-01T00:00:00.000Z',
        },
        safety_number: {
            type: 'safety_number', user_id: 'u1',
            code: '0123456789ABCDEFGHJKMNPQRSTVWXYZ01234567', device_count: 2,
        },
        // Not a real union member — guards against a message with a content
        // shape the client has never seen (e.g. sent by a newer version).
        unknown_future_type: { type: 'something_added_later' },
    };

    for (const [name, content] of Object.entries(otherVariants)) {
        it(`${name} (not pinnable via the app's own UI, but must not render blank)`, () => {
            const children = renderOne(`m-${name}`, content);
            expect(hasVisibleContent(children)).toBe(true);
        });
    }

    it('tombstone (pinned id with no matching local message) still renders a row', () => {
        act(() => {
            root!.render(React.createElement(PinnedMessagesPanel, {
                ...BASE_PROPS,
                messages: [],
                pinnedMsgIds: ['missing-msg'],
            }));
        });
        expect(host.textContent).toContain('Message no longer in local history');
    });
});
