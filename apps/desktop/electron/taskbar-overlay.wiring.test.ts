import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * main.ts imports `electron` and cannot load under vitest, so (like
 * share-boost.wiring.test.ts) this reads the source to pin the WIRING of the
 * Windows taskbar overlay: renderer state (in-call / mute / deafen / unread
 * mention) -> preload -> ipcMain -> badge.ts. The decisions themselves are in
 * overlay-glyphs.test.ts and badge.test.ts.
 */
const dir = __dirname;
const read = (...p: string[]): string => fs.readFileSync(path.resolve(dir, ...p), 'utf8');
const MAIN = read('main.ts');
const PRELOAD = read('preload.ts');
const BADGE = read('badge.ts');
const GLYPHS = read('overlay-glyphs.ts');
const DASHBOARD = read('..', 'src', 'components', 'Dashboard.tsx');
const CONFERENCE = read('..', 'src', 'components', 'SidebarConference.tsx');
const ENV_DTS = read('..', 'src', 'env.d.ts');

function handlerSource(channel: string): string {
    const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
    expect(start, `no ipcMain.handle registration for '${channel}'`).toBeGreaterThan(-1);
    const open = MAIN.indexOf('(', start);
    let depth = 0;
    for (let i = open; i < MAIN.length; i++) {
        if (MAIN[i] === '(') depth++;
        else if (MAIN[i] === ')' && --depth === 0) return MAIN.slice(open, i + 1);
    }
    throw new Error(`unbalanced parentheses in '${channel}'`);
}

describe('mention flag: renderer -> main', () => {
    it('Dashboard derives it from the mention maps and sends it on both badge channels', () => {
        expect(DASHBOARD).toMatch(/hasUnreadMention\(mentionCounts, channelMentionCounts,/);
        expect(DASHBOARD).toMatch(/notifSetBadge\?\.\(count, hasMention\)/);
        expect(DASHBOARD).toMatch(/trayUpdateState\?\.\(\{\s*unreadCount: count,\s*hasMention,/);
    });

    it('preload forwards the flag on notif:set-badge and tray:update-state', () => {
        expect(PRELOAD).toMatch(/notifSetBadge: \(count: number, hasMention\?: boolean\)[^]*?ipcRenderer\.invoke\('notif:set-badge', count, hasMention\)/);
        expect(PRELOAD).toMatch(/trayUpdateState: \(state: \{ unreadCount: number; hasMention\?: boolean;/);
        expect(ENV_DTS).toMatch(/notifSetBadge: \(count: number, hasMention\?: boolean\)/);
        expect(ENV_DTS).toMatch(/trayUpdateState: \(state: \{ unreadCount: number; hasMention\?: boolean;/);
    });

    it('main passes it to setBadgeCount from both handlers (only when it is a boolean)', () => {
        expect(handlerSource('notif:set-badge')).toMatch(/setBadgeCount\(mainWindow, count, typeof hasMention === 'boolean' \? hasMention : undefined\)/);
        expect(handlerSource('tray:update-state')).toMatch(/setBadgeCount\(mainWindow, trayState\.unreadCount, typeof state\.hasMention === 'boolean' \? state\.hasMention : undefined\)/);
    });
});

describe('call state: renderer -> main', () => {
    it('SidebarConference pushes in-call / speaking / muted / deafened, and clears on unmount', () => {
        expect(CONFERENCE).toMatch(/traySetCallSpeaking\?\.\(true, localIsSpeaking, localIsMuted, isLocalDeafened\)/);
        expect(CONFERENCE).toMatch(/traySetCallSpeaking\?\.\(false, false, false, false\)/);
    });

    it('tray:call-speaking stores the state then re-applies the Windows overlay', () => {
        const h = handlerSource('tray:call-speaking');
        expect(h).toMatch(/setTrayCallState\(inCall, isSpeaking, isMuted, isDeafened\)/);
        expect(h).toMatch(/applyWindowsCallOverlay\(mainWindow\)/);
        expect(h.indexOf('setTrayCallState')).toBeLessThan(h.indexOf('applyWindowsCallOverlay'));
    });
});

describe('badge.ts', () => {
    it('every overlay decision goes through resolveOverlay, fed by call state + count + mention', () => {
        expect(BADGE).toMatch(/resolveOverlay\(\{[^}]*inCall: cs\.inCall[^}]*isDeafened: cs\.isDeafened[^}]*isMuted: cs\.isMuted[^}]*hasMention: currentMention[^}]*unreadCount: currentCount/);
        // No second, divergent ladder left behind.
        expect(BADGE).not.toMatch(/applyOverlay\(win, '(deafened|muted|unread)'/);
    });

    it('overlay-glyphs.ts stays pure: no electron import, nothing from src/', () => {
        expect(GLYPHS).not.toMatch(/from 'electron'/);
        expect(GLYPHS).not.toMatch(/from '\.\.\/src/);
        expect(BADGE).not.toMatch(/from '\.\.\/src/);
    });
});
