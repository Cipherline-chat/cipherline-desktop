/**
 * Source-level wiring checks for the group panel's "+" (Dashboard.tsx is ~14k
 * lines and cannot be mounted here): the heading is the shared component gated
 * by canAddGroupMembers, the modal is rendered for a group chat, and a
 * successful add both merges the new people locally and re-fetches the roster.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dash = readFileSync(path.join(dir, 'Dashboard.tsx'), 'utf8');
const settings = readFileSync(path.join(dir, 'GroupSettingsModal.tsx'), 'utf8');

describe('Dashboard group-panel "+" wiring', () => {
    it('renders GroupMembersHeading gated by canAddGroupMembers with the loaded roster and loading flag', () => {
        expect(dash).toMatch(/<GroupMembersHeading[\s\S]{0,400}canAddGroupMembers\(\{[^}]*memberIds: groupMemberIds[^}]*membersLoading: groupMembersLoading[^}]*\}\)/);
        expect(dash).toMatch(/onAdd=\{\(\) => setAddPeopleForChatId\(activeChat\.id\)\}/);
    });

    it('no longer renders the heading as a bare inline div', () => {
        expect(dash).not.toMatch(/<div style=\{\{ fontSize: 11[^>]*>Members \(\{groupMembers\.length\}\)<\/div>/);
    });

    it('renders AddGroupMembersModal for the active group and closes it', () => {
        expect(dash).toMatch(/\{addPeopleForChatId && activeChat && activeChat\.type === 'group' && addPeopleForChatId === activeChat\.id && \(\s*<AddGroupMembersModal[\s\S]{0,400}onClose=\{\(\) => setAddPeopleForChatId\(null\)\}[\s\S]{0,100}onAdded=\{handleGroupMembersAdded\}/);
    });

    it('a successful add merges locally and re-fetches the roster from /devices', () => {
        const fn = dash.slice(dash.indexOf('const handleGroupMembersAdded'));
        const body = fn.slice(0, fn.indexOf('}, [activeChat?.id, token, deviceId'));
        expect(body).toContain('mergeAddedGroupMembers(prev, result.added)');
        expect(body).toMatch(/axios\.get\(apiUrl`\/conversations\/\$\{chatId\}\/devices`/);
        expect(body).toContain('setGroupMembers(buildGroupMemberList(');
    });
});

describe('GroupSettingsModal uses the shared add-people dialog', () => {
    it('opens AddGroupMembersModal (same invite logic as the panel "+") and carries no invite call of its own', () => {
        expect(settings).toContain('<AddGroupMembersModal');
        expect(settings).not.toContain('<AddGroupMembersPicker');
        expect(settings).not.toContain('/invite');
        expect(settings).not.toContain('selectedToAdd');
    });

    it('renders the stacked dialog OUTSIDE the settings <form> so it can never submit it', () => {
        expect(settings.indexOf('</form>')).toBeGreaterThan(0);
        expect(settings.indexOf('<AddGroupMembersModal')).toBeGreaterThan(settings.indexOf('</form>'));
    });
});

describe('Dashboard group card', () => {
    it('renders the group picture header with the loaded roster size and the conversation picture', () => {
        expect(dash).toMatch(/<GroupContextHeader[\s\S]{0,300}memberCount=\{groupMembers\.length\}[\s\S]{0,200}avatarUrl=\{activeChat\.avatar_url \?\? null\}/);
    });

    it('no longer hard-codes the unpluralised "members" count', () => {
        expect(dash).not.toMatch(/\{groupMembers\.length\} members/);
    });
});
