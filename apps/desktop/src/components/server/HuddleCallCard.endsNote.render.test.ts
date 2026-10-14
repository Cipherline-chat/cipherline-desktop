// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The call card's "ends when the starter leaves" line is driven by the CHANNEL
 * setting (`channel.end_call_when_starter_leaves`) - rendered for real, with the
 * same pure rule the server panel and the floating card call. There is no
 * per-call switch any more: the card has no gear and no settings popover, for
 * the starter or anyone else.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

vi.mock('../EncryptedAvatar', () => ({
    EncryptedAvatar: () => React.createElement('span', { 'data-avatar': '1' }),
}));

import { HuddleCallCard } from './HuddleCallCard';
import { endsWhenNotice } from '../../utils/endCallOnLeave';

const STARTER = 'u-starter';
const GUEST = 'u-guest';
const CALL = { spawner_user_id: STARTER };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const note = () => document.querySelector('[data-testid="call-ends-when-note"]');

/** The card as the server panel builds it for `viewer`, in a channel with `channel` settings. */
function renderCard(viewer: string, channel: { end_call_when_starter_leaves?: boolean } | null, isMine = true) {
    act(() => root.render(React.createElement(HuddleCallCard, {
        callId: 'c1', name: 'General', participants: [{ user_id: STARTER }, { user_id: GUEST }],
        isMine, canRename: viewer === STARTER, startedByMe: viewer === STARTER,
        endsNote: endsWhenNotice(CALL, channel, viewer, 'Cora'),
        canConnect: true, token: null, onJoin: () => {}, onLeave: () => {},
    })));
}

describe('the card line follows the channel setting', () => {
    it('channel setting ON: everyone else sees "This call ends when <starter> leaves"', () => {
        renderCard(GUEST, { end_call_when_starter_leaves: true });
        expect(note()?.textContent).toBe('This call ends when Cora leaves');
    });

    it('channel setting ON: the starter sees "Ends for everyone when you leave"', () => {
        renderCard(STARTER, { end_call_when_starter_leaves: true });
        expect(note()?.textContent).toBe('Ends for everyone when you leave');
    });

    it('also for someone looking at the call from OUTSIDE it (not in the call)', () => {
        renderCard(GUEST, { end_call_when_starter_leaves: true }, false);
        expect(note()?.textContent).toBe('This call ends when Cora leaves');
    });

    it('channel setting OFF / absent (older API) / unknown channel: no line (negative controls)', () => {
        for (const channel of [{ end_call_when_starter_leaves: false }, {}, null]) {
            renderCard(GUEST, channel);
            expect(note()).toBeNull();
            renderCard(STARTER, channel);
            expect(note()).toBeNull();
        }
    });

    it('turning the channel setting on re-renders the same card with the line (and off removes it)', () => {
        renderCard(GUEST, { end_call_when_starter_leaves: false });
        expect(note()).toBeNull();
        renderCard(GUEST, { end_call_when_starter_leaves: true });
        expect(note()).not.toBeNull();
        renderCard(GUEST, { end_call_when_starter_leaves: false });
        expect(note()).toBeNull();
    });
});

describe('the per-call switch is gone', () => {
    it('no gear, no settings popover and no switch on the card - for the starter, in the call, with the setting on', () => {
        renderCard(STARTER, { end_call_when_starter_leaves: true });
        expect(document.querySelector('[data-testid="call-settings-button"]')).toBeNull();
        expect(document.querySelector('[aria-label="Call settings"]')).toBeNull();
        expect(document.querySelector('[data-testid="call-settings-panel"]')).toBeNull();
        expect(document.querySelector('[role="switch"]')).toBeNull();
        expect(host.textContent).not.toContain('End call for everyone when I leave');
    });
});
