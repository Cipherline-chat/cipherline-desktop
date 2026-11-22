import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Where role icons render — owner decision 2026-11-22: the member list,
 * profile role pills and the role editor (pills in settings + the role picker
 * dropdown), and NOT next to message author names in chat. Chat author names
 * still get gradient role colours.
 *
 * Placement is a product rule spread across files nothing else ties together,
 * so it is pinned at the source level.
 */
const SRC = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

describe('role icon placement', () => {
    it('chat (ChatPane) never renders a role icon, but does render gradient names', () => {
        const chat = read('components/ChatPane.tsx');
        expect(chat).not.toMatch(/RoleIconBadge|roleIconOf|getTopIconRole|buildMemberRoleDecor/);
        expect(chat).toMatch(/buildMemberRoleSecondary/);
        expect(chat).toMatch(/roleNameStyle\(/);
    });

    it.each([
        'components/server/ServerContextPanel.tsx',          // member list
        'components/ProfileModal.tsx',                        // profile role pills
        'components/server/roles/MemberRoleChipRow.tsx',      // settings -> members pills
        'components/server/roles/RoleListPane.tsx',           // role picker dropdown
        'components/server/roles/RoleDisplayEditor.tsx',      // role editor hero
        'components/server/roles/RoleIconPicker.tsx',         // icon picker preview
    ])('%s renders role icons', (rel) => {
        expect(read(rel)).toMatch(/<RoleIconBadge\b/);
    });
});
