import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guards for "the @mention picker tracks the live roster".
 * ChatPane/Dashboard have no render harness (see avatarWarmingWiring.test.ts),
 * so these pin the registration that makes hooks/useMentionRoster.test.ts's
 * behaviour reachable in the real component:
 *
 *  - ChatPane derives its mention candidates from the live roster hook and no
 *    longer copies the roster into component state on channel switch (that copy
 *    is the bug: it went stale on join / leave / ban / role change).
 *  - the join event still reaches the roster cache (invalidate + roster key bump).
 */
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const chatPane = read('ChatPane.tsx');
const dashboard = read('Dashboard.tsx');

describe('ChatPane mention candidates come from the live roster', () => {
    it('calls useMentionRoster (not merely imports it)', () => {
        expect(chatPane).toContain("import { useMentionRoster } from '../hooks/useMentionRoster';");
        expect(chatPane).toContain('useMentionRoster(activeChannel?.server_id');
    });

    it('does not snapshot the roster into mention state any more', () => {
        expect(chatPane).not.toMatch(/setMentionMembers\s*\(/);
        expect(chatPane).not.toMatch(/setMentionRoles\s*\(/);
        expect(chatPane).not.toMatch(/setMyServerRoleIds\s*\(/);
        expect(chatPane).not.toMatch(/useState<Array<\{ user_id: string; username: string; discriminator: number \| null \}>>/);
    });

    it('feeds the send-time @name -> wire-token map from the live view', () => {
        expect(chatPane).toContain('mentionTokenMapRef.current = mentionView.tokenMap');
    });

    it('re-syncs name/avatar maps on every roster change, not only on channel switch', () => {
        expect(chatPane).toContain('useServerRoster(activeChannel?.server_id)');
        expect(chatPane).toContain('syncRosterIdentities(liveMentionRoster)');
    });
});

describe('the join event still reaches the roster cache', () => {
    const start = dashboard.indexOf('const distributeKeysToNewMember');
    const body = dashboard.slice(start, start + 900);
    it('server:member_joined invalidates the roster and bumps the roster refresh key', () => {
        expect(start).toBeGreaterThan(0);
        expect(body).toContain('invalidateRoster(server_id)');
        expect(body).toContain('setServerRolesRefreshKey(k => k + 1)');
    });
});
