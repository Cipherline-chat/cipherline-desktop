// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same jsdom guard as PinnedMessagesPanel.contentVariants.test.ts — EncryptedAvatar's
// import graph touches utils/clPhysics.ts, which calls window.matchMedia at module
// load and throws under jsdom otherwise.
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ user: { user_id: 'me-1', username: 'Me', avatar_url: null } }),
}));

// Swap the real ClButton (portal-rendered hover tooltip, physics wiring) for a
// plain host button that exposes its `tooltip` prop as a queryable attribute —
// the only thing these tests need to identify. Same technique used by
// RoleMembersEditor.stability.test.ts for the same reason.
vi.mock('./ClButton', () => ({
    default: (p: {
        onClick?: () => void;
        tooltip?: string;
        className?: string;
        children?: React.ReactNode;
    }) => React.createElement(
        'button',
        { onClick: p.onClick, 'data-tooltip': p.tooltip, className: p.className },
        p.children,
    ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PinnedMessagesPanel: any;

let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(async () => {
    ({ default: PinnedMessagesPanel } = await import('./PinnedMessagesPanel'));
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
    objectUrls: {},
    searchQuery: '',
    onJumpTo: () => {},
    onUnpin: () => {},
    onClose: () => {},
    deviceToUsername: { 'dev-other': 'Alice' },
    userIdToUsername: { 'user-other': 'Alice' },
    myDeviceIds: new Set<string>(),
    token: null,
};

const REAL_MSG = {
    id: 'm-real',
    sender_device_id: 'dev-other',
    sender_user_id: 'user-other',
    timestamp: '2026-01-01T00:00:00.000Z',
    content: { type: 'text', text: 'hello world' },
};

function hasUnpinButton(): boolean {
    return !!host.querySelector('button[data-tooltip="Unpin"]');
}

/**
 * Issue: the pinned-messages panel showed an Unpin button to every viewer,
 * regardless of whether they hold the pin/unpin permission in the channel
 * (MANAGE_MESSAGES) — unlike the hover toolbar and right-click context menu,
 * which already gate their combined Pin/Unpin action on it. `canUnpin` is
 * the prop ChatPane now derives the same way (`!activeChannel ||
 * canManageMessages`) and passes down; this pins the panel's own gating so
 * the two surfaces cannot drift again.
 */
describe('PinnedMessagesPanel — canUnpin gates the Unpin action', () => {
    it('defaults to showing Unpin when the caller omits canUnpin (DM/group bookmark, or a caller that predates the prop)', () => {
        act(() => {
            root!.render(React.createElement(PinnedMessagesPanel, {
                ...BASE_PROPS,
                messages: [REAL_MSG],
                pinnedMsgIds: [REAL_MSG.id],
            }));
        });
        expect(hasUnpinButton()).toBe(true);
    });

    it('shows Unpin on a resolved message row when canUnpin is true', () => {
        act(() => {
            root!.render(React.createElement(PinnedMessagesPanel, {
                ...BASE_PROPS,
                messages: [REAL_MSG],
                pinnedMsgIds: [REAL_MSG.id],
                canUnpin: true,
            }));
        });
        expect(hasUnpinButton()).toBe(true);
    });

    it('hides Unpin on a resolved message row when canUnpin is false — a member without MANAGE_MESSAGES', () => {
        act(() => {
            root!.render(React.createElement(PinnedMessagesPanel, {
                ...BASE_PROPS,
                messages: [REAL_MSG],
                pinnedMsgIds: [REAL_MSG.id],
                canUnpin: false,
            }));
        });
        expect(hasUnpinButton()).toBe(false);
        // The row itself, and its other actions (Jump to message), still render —
        // this is a permission gate on one action, not a hidden row.
        expect(host.textContent).toContain('hello world');
        expect(host.querySelector('button[data-tooltip="Jump to message"]')).toBeTruthy();
    });

    it('hides Unpin on a tombstone row (pin with no locally-resolvable message) when canUnpin is false', () => {
        act(() => {
            root!.render(React.createElement(PinnedMessagesPanel, {
                ...BASE_PROPS,
                messages: [],
                pinnedMsgIds: ['missing-msg'],
                canUnpin: false,
            }));
        });
        expect(host.textContent).toContain('Message no longer in local history');
        expect(hasUnpinButton()).toBe(false);
    });

    it('shows Unpin on a tombstone row when canUnpin is true', () => {
        act(() => {
            root!.render(React.createElement(PinnedMessagesPanel, {
                ...BASE_PROPS,
                messages: [],
                pinnedMsgIds: ['missing-msg'],
                canUnpin: true,
            }));
        });
        expect(hasUnpinButton()).toBe(true);
    });
});
