import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Friends tab's Pending/Blocked polish, pinned at the source level
 * (FriendsPane has no render harness). The server half is
 * apps/api/src/attachments/attachments-avatar-relations.service.spec.ts — the
 * two must agree on WHO may be shown, or the avatar silently falls back again.
 */
const src = readFileSync(join(__dirname, 'FriendsPane.tsx'), 'utf8');

function avatarLine(userIdExpr: string): string {
    const i = src.indexOf(`userId={${userIdExpr}}`);
    expect(i, `no avatar for ${userIdExpr}`).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf('/>', i));
}

describe('FriendsPane — Pending and Blocked pictures', () => {
    it('incoming requests bypass the friends-only gate (the server serves exactly that relationship)', () => {
        expect(avatarLine('f.requester_id')).toContain('bypassFriendGate');
    });

    it('blocked users bypass it too (the blocker is looking at their own block list)', () => {
        // the blocked list is the only EncryptedAvatar with userId={f.user_id} and opacity-60
        const i = src.indexOf('className="w-full h-full opacity-60"');
        expect(i).toBeGreaterThan(-1);
        expect(src.slice(i, i + 260)).toContain('bypassFriendGate');
    });

    it('OUTGOING requests do not: the server refuses a stranger the recipient\'s picture, so no gate bypass', () => {
        expect(avatarLine('f.recipient_id')).not.toContain('bypassFriendGate');
    });
});

describe('FriendsPane — Pending tab badge', () => {
    it('shows incoming requests in the red unread pill, with the rail badge colours', () => {
        expect(src).toContain('const incomingCount = friends.pending_incoming.length;');
        expect(src).toContain('unread: incomingCount || undefined');
        expect(src).toMatch(/background: 'var\(--cl-flash\)', color: 'var\(--cl-on-flash\)'/);
    });

    it('requests you sent only show a plain count, and only when nothing is incoming', () => {
        expect(src).toContain('badge: incomingCount ? undefined : (pendingCount || undefined)');
    });
});

/**
 * Regression: "accepted a friend, ~10 min later the Friends list says I have no
 * friends, but the Active Now panel shows them online". The pane kept its own
 * copy of GET /friends (empty on every mount, one swallowed GET), separate from
 * the Dashboard copy that feeds the panel. Pinned at source level (no render
 * harness); the behavioural half is utils/friendsSync.test.ts.
 */
describe('FriendsPane — single source of truth for the friends list', () => {
    const dashboard = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

    it('keeps no private copy of the list and does no GET /friends of its own', () => {
        expect(src).not.toMatch(/useState<\{\s*pending_incoming/);
        expect(src).not.toMatch(/\bsetFriends\b/);
        expect(src).not.toMatch(/axios\.get\([^)]*\/friends/);
    });

    it('reads the shared payload and tells "never loaded" apart from "loaded and empty"', () => {
        expect(src).toContain('const loaded = friendsProp !== null;');
        // the "no friends yet" / blocked / pending bodies only render once loaded
        expect(src).toContain("{loaded && subTab === 'all' && (");
        expect(src).toContain("{loaded && subTab === 'pending' && (");
        expect(src).toContain("{loaded && subTab === 'blocked' && (");
        expect(src).toContain('{!loaded && (');
    });

    it('Dashboard hands the pane the SAME state the Active Now panel reads', () => {
        const paneUse = dashboard.slice(dashboard.indexOf('<FriendsPane'));
        expect(paneUse.slice(0, 900)).toContain('friends={globalFriends}');
        expect(dashboard).toContain('selectActiveFriends(globalFriends?.accepted || []');
    });

    it('every refetch goes through the validated, order-safe sync (no raw setGlobalFriends(res.data))', () => {
        expect(dashboard).toContain('createFriendsSync({');
        expect(dashboard).not.toMatch(/setGlobalFriends\(\s*res\.data\s*\)/);
    });
});
