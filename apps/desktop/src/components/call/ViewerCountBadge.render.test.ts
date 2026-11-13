// @vitest-environment jsdom
/**
 * ViewerCountBadge, really rendered (react-dom/client + jsdom): hovering or
 * focusing the eye lists who is watching, through the kit's portal tooltip.
 *
 * The LiveKit room is a tiny fake with the real event names; `useClTooltip`,
 * `useScreenShareViewerList` and the badge are the real code. Only the avatar
 * (network + decrypt) is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EventEmitter } from 'node:events';
import { RoomEvent } from 'livekit-client';

const room = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@livekit/components-react', () => ({ useMaybeRoomContext: () => room.current }));
vi.mock('../EncryptedAvatar', () => ({
    EncryptedAvatar: (p: { attachmentId?: string | null; userId?: string | null }) =>
        React.createElement('i', { 'data-testid': 'avatar', 'data-attachment': p.attachmentId ?? '', 'data-user': p.userId ?? '' }),
}));

import { ViewerCountBadge } from './ViewerCountBadge';
import { WATCHING_META_KEY, VIEWER_LIST_CAP } from '../../utils/screenShareViewers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const PUB = 'publisher-id';
interface P { identity: string; name?: string; metadata?: string }
const meta = (watching: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ ...extra, [WATCHING_META_KEY]: watching });

class FakeRoom extends EventEmitter {
    localParticipant: P = { identity: 'me', name: 'Me Myself', metadata: meta([]) };
    remoteParticipants = new Map<string, P>();
    set(p: P) { this.remoteParticipants.set(p.identity, p); }
}
const watcher = (id: string, name: string | undefined, extra: Record<string, unknown> = {}): P =>
    ({ identity: id, name, metadata: meta([PUB], extra) });

let root: Root;
let host: HTMLDivElement;
let fake: FakeRoom;

beforeEach(() => {
    vi.useFakeTimers();
    fake = new FakeRoom();
    room.current = fake;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

const render = (props: Partial<React.ComponentProps<typeof ViewerCountBadge>> = {}, wrap?: (c: React.ReactElement) => React.ReactElement) => {
    const el = h(ViewerCountBadge, { publisher: PUB, ...props });
    act(() => root.render(wrap ? wrap(el) : el));
};
const eye = () => host.querySelector<HTMLElement>('[data-testid="viewer-count-badge"]');
const tip = () => document.body.querySelector<HTMLElement>('[role="tooltip"]');
const rows = () => Array.from(document.body.querySelectorAll('[data-testid="viewer-row"]')).map(r => r.textContent);
const hover = () => {
    act(() => { eye()!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body })); });
    act(() => { vi.advanceTimersByTime(450); });
};
const tick = () => act(() => { vi.advanceTimersByTime(50); });

describe('ViewerCountBadge: the hover list', () => {
    it('positive control: nothing is listed until the eye is hovered, then the names appear, sorted', () => {
        fake.set(watcher('u-b', 'bea'));
        fake.set(watcher('u-a', 'Ana'));
        render();
        expect(eye()).not.toBeNull();
        expect(tip()).toBeNull();
        hover();
        expect(tip()).not.toBeNull();
        expect(rows()).toEqual(['Ana', 'bea']);
    });

    it('is not a native title (two tooltips would stack), and the aria-label carries the names', () => {
        fake.set(watcher('u-a', 'Ana'));
        fake.set(watcher('u-b', 'Bea'));
        render();
        expect(eye()!.hasAttribute('title')).toBe(false);
        expect(eye()!.getAttribute('aria-label')).toBe('2 viewers: Ana, Bea');
        expect(eye()!.textContent).toBe('2');
    });

    it('a single viewer reads as "1 viewer: name"', () => {
        fake.set(watcher('u-a', 'Ana'));
        render();
        expect(eye()!.getAttribute('aria-label')).toBe('1 viewer: Ana');
    });

    it('keyboard focus opens it too (the eye is a tab stop)', () => {
        fake.set(watcher('u-a', 'Ana'));
        render();
        expect(eye()!.tabIndex).toBe(0);
        // jsdom has no :focus-visible; answer yes for this element, as a keyboard focus would.
        const el = eye()!;
        (el as { matches: (s: string) => boolean }).matches = (s: string) => s === ':focus-visible';
        act(() => { el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
        expect(rows()).toEqual(['Ana']);
        act(() => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
        expect(tip()).toBeNull();
    });

    it('the tooltip goes through the kit portal on <body>, not inside the tile', () => {
        fake.set(watcher('u-a', 'Ana'));
        render();
        hover();
        expect(host.contains(tip())).toBe(false);
        expect(tip()!.parentElement).toBe(document.body);
    });

    it('caps the list: VIEWER_LIST_CAP names, then "+N more"; the aria-label is capped the same way', () => {
        for (let i = 0; i < 11; i++) fake.set(watcher(`u-${String(i).padStart(2, '0')}`, `Person ${String(i).padStart(2, '0')}`));
        render();
        hover();
        expect(VIEWER_LIST_CAP).toBe(8);
        expect(rows()).toHaveLength(8);
        expect(rows()[0]).toBe('Person 00');
        expect(document.body.querySelector('[data-testid="viewer-more"]')!.textContent).toBe('+3 more');
        expect(eye()!.getAttribute('aria-label')).toBe(
            '11 viewers: Person 00, Person 01, Person 02, Person 03, Person 04, Person 05, Person 06, Person 07 and 3 more');
        expect(eye()!.textContent).toBe('11');
    });

    it('exactly the cap shows no "+N more"', () => {
        for (let i = 0; i < 8; i++) fake.set(watcher(`u-${i}`, `P${i}`));
        render();
        hover();
        expect(rows()).toHaveLength(8);
        expect(document.body.querySelector('[data-testid="viewer-more"]')).toBeNull();
    });

    it('zero viewers: hidden by default; with showZero it says so plainly', () => {
        render();
        expect(eye()).toBeNull();
        render({ showZero: true });
        expect(eye()!.textContent).toBe('0');
        expect(eye()!.getAttribute('aria-label')).toBe('No one is watching yet');
        hover();
        expect(tip()!.textContent).toBe('No one is watching yet');
    });

    it('a viewer with no name is "Unknown", never the raw id; a name that IS the id is treated as no name', () => {
        fake.set(watcher('3f2b9c1e-aaaa-bbbb-cccc-123456789abc', undefined));
        fake.set(watcher('plain-id', 'plain-id'));
        fake.set(watcher('blank', '   '));
        render();
        hover();
        expect(rows()).toEqual(['Unknown', 'Unknown', 'Unknown']);
        expect(tip()!.textContent).not.toMatch(/3f2b9c1e|plain-id|blank/);
        expect(eye()!.getAttribute('aria-label')).not.toMatch(/3f2b9c1e|plain-id|blank/);
    });

    it('the local participant is marked "(you)"', () => {
        fake.localParticipant = { identity: 'me', name: 'Me Myself', metadata: meta([PUB]) };
        fake.set(watcher('u-a', 'Ana'));
        render();
        hover();
        expect(rows()).toEqual(['Ana', 'Me Myself (you)']);
    });

    it('the publisher is never listed as watching their own share', () => {
        fake.set({ identity: PUB, name: 'Streamer', metadata: meta([PUB]) });
        fake.set(watcher('u-a', 'Ana'));
        render();
        hover();
        expect(rows()).toEqual(['Ana']);
    });

    it('rows show the viewer\'s avatar when a token is passed, from their own metadata', () => {
        fake.set(watcher('u-a', 'Ana', { avatar_url: 'att-123' }));
        render({ token: 'jwt' });
        hover();
        const av = document.body.querySelector('[data-testid="avatar"]')!;
        expect(av.getAttribute('data-attachment')).toBe('att-123');
        expect(av.getAttribute('data-user')).toBe('u-a');
    });

    it('no token: names only, no avatar', () => {
        fake.set(watcher('u-a', 'Ana', { avatar_url: 'att-123' }));
        render();
        hover();
        expect(document.body.querySelector('[data-testid="avatar"]')).toBeNull();
        expect(rows()).toEqual(['Ana']);
    });
});

describe('ViewerCountBadge: live while open', () => {
    it('a viewer arriving, renaming and leaving updates the open list and the count', () => {
        fake.set(watcher('u-a', 'Ana'));
        render({ showZero: true });
        hover();
        expect(rows()).toEqual(['Ana']);

        // Bea starts watching.
        fake.set(watcher('u-b', 'Bea'));
        act(() => { fake.emit(RoomEvent.ParticipantMetadataChanged); }); tick();
        expect(rows()).toEqual(['Ana', 'Bea']);
        expect(eye()!.textContent).toBe('2');
        expect(eye()!.getAttribute('aria-label')).toBe('2 viewers: Ana, Bea');

        // Bea renames.
        fake.set(watcher('u-b', 'Beatrice'));
        act(() => { fake.emit(RoomEvent.ParticipantNameChanged); }); tick();
        expect(rows()).toEqual(['Ana', 'Beatrice']);

        // Ana stops watching (metadata drops the key).
        fake.set({ identity: 'u-a', name: 'Ana', metadata: meta([]) });
        act(() => { fake.emit(RoomEvent.ParticipantMetadataChanged); }); tick();
        expect(rows()).toEqual(['Beatrice']);

        // Beatrice leaves the call entirely.
        fake.remoteParticipants.delete('u-b');
        act(() => { fake.emit(RoomEvent.ParticipantDisconnected); }); tick();
        expect(tip()).not.toBeNull();
        expect(tip()!.textContent).toBe('No one is watching yet');
    });

    it('on a tile without showZero the badge, and its open tooltip, go away with the last viewer', () => {
        fake.set(watcher('u-a', 'Ana'));
        render();
        hover();
        expect(rows()).toEqual(['Ana']);
        fake.remoteParticipants.delete('u-a');
        act(() => { fake.emit(RoomEvent.ParticipantDisconnected); }); tick();
        expect(eye()).toBeNull();
        expect(tip()).toBeNull();
    });

    it('unsubscribes from the room when it unmounts', () => {
        fake.set(watcher('u-a', 'Ana'));
        render();
        expect(fake.listenerCount(RoomEvent.ParticipantMetadataChanged)).toBe(1);
        act(() => root.render(null));
        expect(fake.listenerCount(RoomEvent.ParticipantMetadataChanged)).toBe(0);
        expect(fake.listenerCount(RoomEvent.ParticipantNameChanged)).toBe(0);
    });
});

describe('ViewerCountBadge: the host tile keeps working', () => {
    it('it is hit-testable inside a pointer-events-none pill, so it can be hovered', () => {
        fake.set(watcher('u-a', 'Ana'));
        render();
        expect(eye()!.className).toContain('pointer-events-auto');
    });

    it('a left click bubbles to the tile\'s own onClick (focus toggle) exactly as before', () => {
        fake.set(watcher('u-a', 'Ana'));
        const tile = vi.fn();
        render({}, c => h('div', { onClick: tile, 'data-testid': 'tile' }, c));
        act(() => { eye()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(tile).toHaveBeenCalledTimes(1);
    });

    it('a click also closes nothing on the tile and does not stack a title tooltip', () => {
        fake.set(watcher('u-a', 'Ana'));
        render();
        hover();
        expect(tip()).not.toBeNull();
        act(() => { eye()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
        expect(tip()).toBeNull();
    });

    it('onActivate (a host whose click handler is not an ancestor) runs on click', () => {
        fake.set(watcher('u-a', 'Ana'));
        const onActivate = vi.fn();
        render({ onActivate });
        act(() => { eye()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it('a right click is handed to the tile\'s context-menu handler (contextmenu and secondary pointerdown)', () => {
        fake.set(watcher('u-a', 'Ana'));
        const onContextMenu = vi.fn();
        render({ onContextMenu });
        act(() => { eye()!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })); });
        expect(onContextMenu).toHaveBeenCalledTimes(1);
        // A primary press must NOT open the menu.
        act(() => { eye()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
        expect(onContextMenu).toHaveBeenCalledTimes(1);
    });
});
