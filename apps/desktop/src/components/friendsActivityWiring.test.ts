import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guard (Dashboard has no render harness): the Friends
 * page's right panel is the activity panel, the old online list is gone, the
 * recorder is mounted app-wide, and no server endpoint backs any of it.
 */
const dashboard = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
const panel = readFileSync(join(__dirname, 'FriendsActivityPanel.tsx'), 'utf8');
const hook = readFileSync(join(__dirname, '..', 'hooks', 'useFriendActivity.ts'), 'utf8');
const store = readFileSync(join(__dirname, '..', 'utils', 'friendActivityStore.ts'), 'utf8');
const model = readFileSync(join(__dirname, '..', 'utils', 'friendActivity.ts'), 'utf8');

function friendsBranch(): string {
    const i = dashboard.indexOf("activeTab === 'friends' ? (\n");
    expect(i, 'friends branch of the right panel not found').toBeGreaterThan(-1);
    const end = dashboard.indexOf(') : activeChannel ? (() => {', i);
    expect(end).toBeGreaterThan(i);
    return dashboard.slice(i, end);
}

describe('Friends page right panel wiring', () => {
    it('renders FriendsActivityPanel for the Friends tab', () => {
        const b = friendsBranch();
        expect(b).toMatch(/<FriendsActivityPanel\b/);
        expect(b).toMatch(/onOpenProfile=\{\(uid, anchor\) => openProfileAt\(uid, anchor\)\}/);
        expect(b).toMatch(/blockedIds=\{activityBlockedIds\}/);
        expect(b).toMatch(/presence=\{displayPresence\}/);
    });

    it('no longer renders the "Active Now" online list there', () => {
        const b = friendsBranch();
        expect(b).not.toMatch(/selectActiveFriends/);
        expect(b).not.toMatch(/Active Now/);
        expect(dashboard).not.toMatch(/selectActiveFriends\(/);
    });

    it('the recorder is mounted unconditionally (fills while other pages are open)', () => {
        expect(dashboard).toMatch(/\n {4}useFriendActivityRecorder\(\{/);
        const call = dashboard.slice(dashboard.indexOf('useFriendActivityRecorder({'), dashboard.indexOf('useFriendActivityRecorder({') + 500);
        expect(call).toMatch(/blockedIds: activityBlockedIds/);
        expect(call).toMatch(/wsConnectCount/);
    });

    it('is renderer-only: no network calls and no persistence in the feed code', () => {
        for (const src of [panel, hook, store, model]) {
            expect(src).not.toMatch(/\baxios\b|\bfetch\(|apiUrl`/);
            expect(src).not.toMatch(/secureLocalStore|localStorage|indexedDB/);
        }
    });
});
