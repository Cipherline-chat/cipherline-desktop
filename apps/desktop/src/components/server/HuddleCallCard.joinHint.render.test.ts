// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * People aiming for an open call often clicked the Calls channel row above it,
 * which STARTS a new call. A joinable call now shows a "Join" hint while the
 * pointer is anywhere on the channel (the row or its calls) - CSS-driven by
 * HuddleButton's `group/huddle`, so here we pin which cards get the hint and
 * that the group it keys off actually exists.
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
});

const hint = () => host.querySelector('[data-testid="huddle-call-join-hint"]');

function renderCard(isMine: boolean, canConnect: boolean) {
    act(() => root.render(React.createElement(HuddleCallCard, {
        callId: 'c1', name: "Dawson's Call", participants: [{ user_id: 'u1' }],
        isMine, canRename: false, canConnect, token: null,
        spawnedAt: new Date().toISOString(), onJoin: () => {}, onLeave: () => {},
    })));
}

describe('call card "Join" hint', () => {
    it('a call you can join: hint present, hidden until the channel is hovered, timer kept', () => {
        renderCard(false, true);
        const el = hint();
        expect(el?.textContent).toBe('Join');
        expect(el?.className).toContain('opacity-0');
        expect(el?.className).toContain('group-hover/huddle:opacity-100');
        expect(host.textContent).toMatch(/0:0\d/);
    });

    it('your own call and a call you cannot connect to: no hint', () => {
        renderCard(true, true);
        expect(hint()).toBeNull();
        renderCard(false, false);
        expect(hint()).toBeNull();
    });

    it('HuddleButton declares the group/huddle the hint keys off', () => {
        const src = readFileSync(join(__dirname, 'HuddleButton.tsx'), 'utf8');
        expect(src).toMatch(/'group\/huddle rounded-xl/);
        expect(src).toMatch(/: 'group\/huddle'\}/);
    });
});
