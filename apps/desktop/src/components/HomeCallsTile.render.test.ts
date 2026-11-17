// @vitest-environment jsdom
/**
 * Home "Happening now": however many calls are live, ONE tile with at most
 * three compact rows and a "+N more" fold (owner 2026-11-16: "more compact").
 * Also pins the wiring — HomePanel renders this tile once instead of mapping
 * every call to its own card.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./EncryptedAvatar', () => ({
    EncryptedAvatar: ({ userId }: { userId?: string }) => React.createElement('span', { 'data-avatar': userId }),
}));

import { HomeCallsTile, type HomeCallEntry } from './HomeCallsTile';
import { resetHomeCallsExpandedForTests } from '../utils/homeCallsList';
import type { ChannelInfo, ServerInfo } from '../hooks/useServers';
import { Permissions } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

// CONNECT + VIEW_CHANNEL granted / VIEW_CHANNEL only (see utils/voiceJoinGate).
const CAN_CONNECT = String(Permissions.VIEW_CHANNEL | Permissions.CONNECT);
const VIEW_ONLY = String(Permissions.VIEW_CHANNEL);

const mk = (i: number, participants: number, o: Partial<HomeCallEntry> = {}, perms?: string): HomeCallEntry => ({
    key: `voice-c${i}`,
    name: `Channel ${i}`,
    channel: { channel_id: `c${i}`, server_id: `s${i}`, kind: 'voice', name: `Channel ${i}`, my_permissions: perms } as ChannelInfo,
    server: { server_id: `s${i}`, name: `Server ${i}` } as ServerInfo,
    participantIds: Array.from({ length: participants }, (_, k) => `u${i}-${k}`),
    startedAt: null,
    row: { kind: 'voice', channelId: `c${i}` },
    onJoin: vi.fn(),
    ...o,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    resetHomeCallsExpandedForTests();
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = (calls: HomeCallEntry[], extra: Record<string, unknown> = {}) =>
    act(() => root.render(h(HomeCallsTile, { calls, friendIds: new Set<string>(), token: null, ...extra })));
const tiles = () => host.querySelectorAll('[data-testid="home-calls-tile"]');
const rows = () => Array.from(host.querySelectorAll('[data-testid="home-call-row"]'));
const more = () => host.querySelector<HTMLButtonElement>('[data-testid="home-calls-more"]');

describe('HomeCallsTile', () => {
    it('no calls: no tile at all (empty state unchanged)', () => {
        render([]);
        expect(host.innerHTML).toBe('');
    });

    it('one call: one tile, one compact row, no fold, no count chip', () => {
        render([mk(1, 2)]);
        expect(tiles()).toHaveLength(1);
        expect(rows()).toHaveLength(1);
        expect(more()).toBeNull();
        expect(host.querySelector('.hd-count')).toBeNull();
        expect(host.querySelectorAll('h2')).toHaveLength(1);
    });

    describe('single call: its own two-line layout (owner 2026-11-16)', () => {
        const stack = (r: Element) => r.querySelector('.hd-call-stack')!;
        it('name as the primary line, "server · N in call" under it', () => {
            render([mk(1, 2)]);
            const r = rows()[0];
            expect(r.classList.contains('hd-call--solo')).toBe(true);
            expect(host.querySelector('.hd-calls')!.classList.contains('hd-calls--solo')).toBe(true);
            expect(r.querySelector('.hd-call-body > .hd-call-name')?.textContent).toBe('Channel 1');
            const meta = r.querySelector('.hd-call-body > .hd-call-meta')!;
            expect(meta.querySelector('.hd-call-srv')?.textContent).toContain('Server 1');
            expect(meta.querySelector('.hd-call-n')?.textContent).toContain('2 in call');
        });
        it('Join is the full-size button, vertically its own column', () => {
            render([mk(1, 2)]);
            const join = rows()[0].querySelector('button.hd-btn')!;
            expect(join.textContent).toBe('Join');
            expect(join.classList.contains('hd-btn--sm')).toBe(false);
            expect(join.parentElement).toBe(rows()[0]);
        });
        it('avatar slot has no reserved width for 1 or 2 avatars (no dead gap)', () => {
            for (const people of [1, 2]) {
                render([mk(1, people)]);
                expect(stack(rows()[0]).children).toHaveLength(people);
                expect(host.querySelector<HTMLElement>('.hd-calls')!.style.getPropertyValue('--hd-stack-w')).toBe('');
                expect(stack(rows()[0]).getAttribute('style')).toBeNull();
            }
        });
        it('up to 4 discs: all four avatars, or three and "+N"', () => {
            render([mk(1, 4)]);
            expect(stack(rows()[0]).querySelectorAll('[data-avatar]')).toHaveLength(4);
            expect(rows()[0].querySelector('.hd-call-stackmore')).toBeNull();
            render([mk(1, 9)]);
            expect(stack(rows()[0]).querySelectorAll('[data-avatar]')).toHaveLength(3);
            expect(rows()[0].querySelector('.hd-call-stackmore')?.textContent).toBe('+6');
        });
        it('your own call alone: the quiet "In call" tag, no Join, no highlight', () => {
            render([mk(1, 1)], { localCallSession: { voiceChannelId: 'c1', huddleCallId: null } });
            const r = rows()[0];
            expect(r.getAttribute('data-mine')).toBe('true');
            expect(r.querySelector('.hd-call-here')?.textContent).toBe('In call');
            expect(r.querySelector('.hd-live')).toBeNull();
            expect(r.querySelector('button.hd-btn')).toBeNull();
        });
        it('CONNECT gate still applies to the single-call Join', () => {
            render([mk(1, 2, {}, VIEW_ONLY)]);
            expect(rows()[0].querySelector('button.hd-btn')).toBeNull();
        });
    });

    it('multi-call: avatar slot = widest stack SHOWN, so names align without a fixed 3-avatar gap', () => {
        const slot = () => host.querySelector<HTMLElement>('.hd-calls')!.style.getPropertyValue('--hd-stack-w');
        render([mk(1, 1), mk(2, 1)]);
        expect(rows()[0].classList.contains('hd-call--solo')).toBe(false);
        expect(slot()).toBe('20px');
        render([mk(1, 2), mk(2, 1)]);
        expect(slot()).toBe('34px');
        render([mk(1, 5), mk(2, 1)]);
        expect(slot()).toBe('48px');
        // Multi rows keep the compact Join.
        expect(rows()[0].querySelector('button.hd-btn')!.classList.contains('hd-btn--sm')).toBe(true);
    });

    it('exactly three calls: all shown, no fold', () => {
        render([mk(1, 1), mk(2, 1), mk(3, 1)]);
        expect(rows()).toHaveLength(3);
        expect(more()).toBeNull();
    });

    it('eight calls: ONE tile, ONE header, three rows and "+5 more"; expands in place and collapses back', () => {
        render(Array.from({ length: 8 }, (_, i) => mk(i, 8 - i)));
        expect(tiles()).toHaveLength(1);
        expect(host.querySelectorAll('h2')).toHaveLength(1);
        expect(host.querySelector('.hd-count')?.textContent).toBe('8');
        expect(rows()).toHaveLength(3);
        // Biggest calls first (no friends, no own call in this fixture).
        expect(rows().map(r => r.querySelector('.hd-call-name')?.textContent)).toEqual(['Channel 0', 'Channel 1', 'Channel 2']);
        const btn = more()!;
        expect(btn.textContent).toContain('+5 more');
        expect(btn.getAttribute('aria-expanded')).toBe('false');
        expect(btn.getAttribute('aria-controls')).toBe(host.querySelector('.hd-calls')!.id);

        act(() => btn.click());
        expect(rows()).toHaveLength(8);
        expect(more()!.textContent).toContain('Show less');
        expect(more()!.getAttribute('aria-expanded')).toBe('true');
        expect(rows().slice(3).every(r => r.classList.contains('hd-call--extra'))).toBe(true);

        act(() => more()!.click());
        expect(rows()).toHaveLength(3);
    });

    it('remembers expanded for the session (across remounts)', () => {
        const calls = Array.from({ length: 5 }, (_, i) => mk(i, 1));
        render(calls);
        act(() => more()!.click());
        act(() => root.unmount());
        root = createRoot(host);
        render(calls);
        expect(rows()).toHaveLength(5);
    });

    it('your own call: first, an "In call" tag and never Join', () => {
        const calls = [mk(1, 5), mk(2, 4), mk(3, 3), mk(4, 1)];
        render(calls, { localCallSession: { voiceChannelId: 'c4', huddleCallId: null } });
        const first = rows()[0];
        expect(first.getAttribute('data-mine')).toBe('true');
        expect(first.querySelector('.hd-call-name')?.textContent).toBe('Channel 4');
        expect(first.textContent).toContain('In call');
        expect(first.querySelector('button.hd-btn')).toBeNull();
        // No highlight: no filled pill on the tag, and (below) no row band.
        expect(first.querySelector('.hd-live')).toBeNull();
        expect(first.querySelector('.hd-call-here')).not.toBeNull();
        expect(first.className).toBe('hd-call');
        expect(rows()[1].querySelector('button.hd-btn')?.textContent).toBe('Join');
    });

    it('calls with friends outrank bigger calls', () => {
        const calls = [mk(1, 6), mk(2, 2)];
        render(calls, { friendIds: new Set(['u2-1']) });
        expect(rows()[0].querySelector('.hd-call-name')?.textContent).toBe('Channel 2');
    });

    it('presence churn updates counts live without moving rows', () => {
        const a = mk(1, 3); const b = mk(2, 2);
        render([a, b]);
        expect(rows()[0].querySelector('.hd-call-name')?.textContent).toBe('Channel 1');
        render([{ ...a, participantIds: ['x'] }, { ...b, participantIds: ['1', '2', '3', '4', '5'] }]);
        expect(rows()[0].querySelector('.hd-call-name')?.textContent).toBe('Channel 1');
        expect(rows()[1].querySelector('.hd-call-n')?.textContent).toContain('5');
    });

    it('CONNECT gate: no Join on a call you can see but not join', () => {
        render([mk(1, 2, {}, VIEW_ONLY), mk(2, 1, {}, CAN_CONNECT)]);
        expect(rows()[0].querySelector('button.hd-btn')).toBeNull();
        expect(rows()[1].querySelector('button.hd-btn')).not.toBeNull();
    });

    it('Join calls onJoin only; the row itself opens the server', () => {
        const onSelectServer = vi.fn();
        const c = mk(1, 2);
        render([c], { onSelectServer });
        act(() => rows()[0].querySelector<HTMLButtonElement>('.hd-call-open')!.click());
        expect(onSelectServer).toHaveBeenCalledWith('s1');
        expect(c.onJoin).not.toHaveBeenCalled();
        act(() => rows()[0].querySelector<HTMLButtonElement>('button.hd-btn')!.click());
        expect(c.onJoin).toHaveBeenCalledTimes(1);
    });

    it('long names carry a full-text tooltip on the row', () => {
        const long = 'A really quite remarkably long voice channel name that will not fit';
        render([mk(1, 2, { name: long })]);
        expect(rows()[0].querySelector('.hd-call-open')?.getAttribute('title')).toBe(`${long} · Server 1 · 2 in call`);
    });
});

describe('home-deck.css: no highlighted row for your call (owner 2026-11-16)', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'home-deck.css'), 'utf8');
    it('no rule paints a background on the mine row', () => {
        // Every rule whose selector mentions [data-mine] — none may set a background.
        const rules = [...css.matchAll(/([^{}]*\[data-mine[^{}]*)\{([^}]*)\}/g)];
        for (const [, , body] of rules) expect(body).not.toMatch(/background/);
    });
    it('the "In call" tag has no fill', () => {
        const m = css.match(/\.hd-call-here\s*\{([^}]*)\}/);
        expect(m).not.toBeNull();
        expect(m![1]).not.toMatch(/background/);
    });
    it('the avatar slot is not a fixed width', () => {
        const m = css.match(/\.hd-call-stack\s*\{([^}]*)\}/);
        expect(m![1]).not.toMatch(/(^|[;\s])width:\s*\d/);
        expect(m![1]).toContain('var(--hd-stack-w');
    });
});

describe('HomePanel wiring', () => {
    const src = readFileSync(join(__dirname, 'HomePanel.tsx'), 'utf8');
    it('renders the calls tile once instead of a card per call', () => {
        expect(src.match(/<HomeCallsTile\b/g)).toHaveLength(1);
        expect(src).not.toMatch(/activeCalls\.map\(/);
        expect(src).not.toContain('hd-t--call');
    });
    it('the calls section still counts as ONE deck alert', () => {
        expect(src).toMatch(/const alertCount = \(backupNudge \? 1 : 0\) \+ \(activeCalls\.length > 0 \? 1 : 0\);/);
    });
});
