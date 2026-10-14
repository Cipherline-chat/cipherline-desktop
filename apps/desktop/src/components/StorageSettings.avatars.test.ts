// @vitest-environment jsdom
/**
 * Settings -> Storage -> "Conversation storage": each row leads with the same
 * avatar the sidebar conversation list shows (EncryptedAvatar), so a DM shows
 * the other person, a group shows its own icon, and a conversation that is
 * gone gets the archive placeholder (like a left server). The avatar component
 * is spied on - no decrypt or fetch happens in this test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

const avatarProps: Array<Record<string, unknown>> = [];
vi.mock('./EncryptedAvatar', () => ({
    EncryptedAvatar: (props: Record<string, unknown>) => {
        avatarProps.push(props);
        return React.createElement('span', { 'data-avatar': String(props.attachmentId ?? 'none') });
    },
}));
vi.mock('./server/ServerIcon', () => ({
    ServerIcon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }),
}));

import { StorageSettings } from './StorageSettings';

const msg = (id: string) => ({ id, timestamp: Date.now(), content: { type: 'text', text: id } });

const retention = {
    policy: {
        attachmentRetention: 'never', messageRetention: 'never',
        savedAttachmentIds: [], unsavedAttachmentIds: [], savedMessageIds: [], unsavedMessageIds: [],
        unsavedMessageTimestamps: {}, unsavedAttachmentTimestamps: {},
    },
} as never;

const conversations = [
    { conversation_id: 'dm1', type: 'dm', title: 'Alice', other_user_id: 'u-alice', avatar_url: 'att-alice' },
    { conversation_id: 'g1', type: 'group', title: 'Weekend crew', avatar_url: 'att-group' },
    { conversation_id: 'self1', type: 'dm', title: 'Notes to self', other_user_id: 'u-me', avatar_url: null, is_self: true },
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    avatarProps.length = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root.render(React.createElement(StorageSettings, {
            retention,
            messagesState: {
                dm1: [msg('a'), msg('b'), msg('c')],
                g1: [msg('d'), msg('e')],
                self1: [msg('f')],
                gone: [msg('g')],
            },
            conversations,
            onClearAllMessages: () => {},
            onPurgeConversation: () => {},
            onPurgeTypeNow: () => {},
            serverStorage: { servers: [], serverChannels: {}, channelMessages: {}, token: 'tok-1', onPurge: () => {} } as never,
        }));
    });
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

describe('Conversation storage rows lead with the sidebar avatar', () => {
    it('a DM shows the other person: userId + avatar attachment, not a group', () => {
        const p = avatarProps.find(a => a.attachmentId === 'att-alice');
        expect(p).toBeDefined();
        expect(p).toMatchObject({ userId: 'u-alice', isGroup: false, token: 'tok-1' });
    });

    it('a group shows its own icon through the group fallback, no user id', () => {
        const p = avatarProps.find(a => a.attachmentId === 'att-group');
        expect(p).toBeDefined();
        expect(p).toMatchObject({ userId: null, isGroup: true, token: 'tok-1' });
    });

    it('the notes-to-self chat renders like any DM (user colour fallback, no attachment)', () => {
        const p = avatarProps.find(a => a.userId === 'u-me');
        expect(p).toBeDefined();
        expect(p).toMatchObject({ attachmentId: null, isGroup: false });
    });

    it('a conversation no longer in the list gets the archive placeholder, not an avatar', () => {
        const rows = Array.from(host.querySelectorAll('span.truncate')).map(e => e.textContent);
        expect(rows).toContain('Unknown Chat');
        // 3 known conversations -> exactly 3 avatars; the 4th (orphan) row has none.
        expect(avatarProps.filter(a => a.disableClickProfile === true).length).toBeGreaterThanOrEqual(3);
        const distinct = new Set(avatarProps.map(a => `${a.userId}|${a.attachmentId}|${a.isGroup}`));
        expect(distinct.size).toBe(3);
    });

    it('uses the very component the sidebar uses, with the same props shape', () => {
        const dash = readFileSync(resolve(__dirname, 'Dashboard.tsx'), 'utf8');
        expect(dash).toMatch(/import \{ EncryptedAvatar \} from '\.\/EncryptedAvatar'/);
        const src = readFileSync(resolve(__dirname, 'StorageConvAvatar.tsx'), 'utf8');
        expect(src).toMatch(/import \{ EncryptedAvatar \} from '\.\/EncryptedAvatar'/);
        // No avatar fetch/decrypt code of its own.
        expect(src).not.toMatch(/useEncryptedAvatar|axios|fetch\(/);
    });
});
