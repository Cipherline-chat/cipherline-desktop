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

    it('Dashboard hands the pane the SAME state the right-hand activity panel reads', () => {
        const paneUse = dashboard.slice(dashboard.indexOf('<FriendsPane'));
        expect(paneUse.slice(0, 900)).toContain('friends={globalFriends}');
        // The activity panel (it replaced the old "Active Now" list) reads globalFriends' accepted list.
        expect(dashboard).toMatch(/const acceptedFriendsForStatus = React\.useMemo\(\(\) =>\s*globalFriends\?\.accepted \?\? \[\]/);
        const panelUse = dashboard.slice(dashboard.indexOf('<FriendsActivityPanel'));
        expect(panelUse.slice(0, 600)).toContain('friends={acceptedFriendsForStatus}');
    });

    it('every refetch goes through the validated, order-safe sync (no raw setGlobalFriends(res.data))', () => {
        expect(dashboard).toContain('createFriendsSync({');
        expect(dashboard).not.toMatch(/setGlobalFriends\(\s*res\.data\s*\)/);
    });
});

/**
 * Animated avatars play while their row is hovered or focused, the same
 * contract as the server member list (server/HoverPlayRow.tsx). Lists still
 * never pass `animate` (profileCustomization.wiring.test.ts) — `playing` is the
 * transient, row-scoped flag.
 */
describe('FriendsPane — animated avatars play on row hover', () => {
    it('every row is a HoverPlayRow and every avatar takes its `playing` flag', () => {
        expect(src).toContain("import { HoverPlayRow } from './server/HoverPlayRow';");
        const avatars = src.match(/<EncryptedAvatar[\s\S]*?\/>/g) ?? [];
        expect(avatars.length).toBe(4); // accepted, blocked, incoming, outgoing
        for (const a of avatars) expect(a).toContain('playing={playing}');
        expect((src.match(/<HoverPlayRow\b/g) ?? []).length).toBe(4);
    });
});

/**
 * Narrow-pane Pending rows. The pane is a flex child whose width depends on the
 * window AND the rail/sidebar, so the layout answers to CONTAINER queries on
 * `.fp-root` (not the viewport). Below COMPACT_PANE_PX the Accept/Decline labels
 * collapse to icons — they stay in the DOM (screen-reader text + a tooltip) so
 * the buttons never lose their names. Visual proof: harness/friends-narrow-*.
 */
describe('FriendsPane — Pending rows at narrow widths', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'friends-pane.css'), 'utf8');

    it('request rows opt into the narrow-pane rules and their timing wraps instead of truncating', () => {
        expect((src.match(/fp-row fp-row--static fp-row--req /g) ?? []).length).toBe(2); // incoming + sent
        expect(src).not.toMatch(/className="truncate">\{age/);
        expect(src).toContain('<span className="fp-subtext">');
        expect(css).toMatch(/\.fp-subrow\s*\{[^}]*flex-wrap:\s*wrap[^}]*white-space:\s*normal/);
    });

    it('Accept/Decline keep an accessible name and get a tooltip when their label is hidden', () => {
        expect(src).toContain('<span className="fp-btn-label">Accept</span>');
        expect(src).toContain('<span className="fp-btn-label">Decline</span>');
        expect(src).toContain("tooltip={compact ? 'Accept' : undefined}");
        expect(src).toContain("tooltip={compact ? 'Decline' : undefined}");
        // hidden visually, never display:none (that would drop the accessible name)
        const hidden = css.match(/\.fp-btn-label\s*\{[^}]*\}/)?.[0] ?? '';
        expect(hidden).toContain('clip: rect(0 0 0 0)');
        expect(hidden).not.toContain('display: none');
    });

    it('the JS breakpoint matches the CSS container breakpoint', () => {
        const px = src.match(/COMPACT_PANE_PX = (\d+)/)?.[1];
        expect(px).toBeDefined();
        expect(css).toContain(`@container fp (max-width: ${px}px) {\n  .fp-btn-label`);
    });
});
