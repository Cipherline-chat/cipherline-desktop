// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useHeldOn, SPEAKING_PLAY_LINGER_MS } from '../../utils/animatedImage';

/**
 * Animated avatars show their first frame unless hovered, opened in a profile,
 * or (this file) their owner is talking in a call. Speech is bursty, so the
 * "talking" signal is held through short pauses - otherwise the GIF would
 * snap back to frame one and restart on every word.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let seen: boolean[] = [];
const Probe: React.FC<{ on: boolean }> = ({ on }) => { seen.push(useHeldOn(on, SPEAKING_PLAY_LINGER_MS)); return null; };
const last = () => seen[seen.length - 1];

beforeEach(() => { vi.useFakeTimers(); seen = []; host = document.createElement('div'); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

describe('useHeldOn (speaking -> playing)', () => {
    it('off stays off; on is immediate', () => {
        act(() => root.render(React.createElement(Probe, { on: false })));
        expect(last()).toBe(false);
        act(() => root.render(React.createElement(Probe, { on: true })));
        expect(last()).toBe(true);
    });

    it('holds through a pause shorter than the linger, then lets go', () => {
        act(() => root.render(React.createElement(Probe, { on: true })));
        act(() => root.render(React.createElement(Probe, { on: false })));
        act(() => { vi.advanceTimersByTime(SPEAKING_PLAY_LINGER_MS - 100); });
        expect(last()).toBe(true);
        // talks again inside the window: still playing, and the clock restarts
        act(() => root.render(React.createElement(Probe, { on: true })));
        act(() => root.render(React.createElement(Probe, { on: false })));
        act(() => { vi.advanceTimersByTime(SPEAKING_PLAY_LINGER_MS - 100); });
        expect(last()).toBe(true);
        act(() => { vi.advanceTimersByTime(200); });
        expect(last()).toBe(false);
    });
});

describe('every call surface feeds its speaking state to the avatar', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
    it.each([
        ['call/ParticipantCard.tsx', /bypassFriendGate\s+speaking=\{speaking\}/g, 2],
        ['call/FloatingHuddleCard.tsx', /speaking=\{isSpeaking\}/g, 1],
        ['call/VideoTile.tsx', /speaking=\{avatarSpeaking\}/g, 2],
        ['server/ServerContextPanel.tsx', /speaking=\{speaking\}/g, 2],
    ])('%s', (file, re, n) => {
        expect((src(file).match(re) ?? []).length).toBe(n);
    });

    it('EncryptedAvatar ORs the held speaking state into the still-gate', () => {
        const s = src('EncryptedAvatar.tsx');
        expect(s).toMatch(/useHeldOn\(speaking, SPEAKING_PLAY_LINGER_MS\)/);
        expect(s).toMatch(/\|\| playing \|\| talking\)/);
    });
});
