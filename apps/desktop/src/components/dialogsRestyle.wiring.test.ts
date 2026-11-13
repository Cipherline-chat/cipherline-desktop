/**
 * Wiring for the dialogs-restyle change: every block / remove-friend / report /
 * destructive-confirm surface now goes through the house dialog pattern, and the
 * old hand-rolled versions are gone. Source-level, because these call sites live
 * inside monoliths (Dashboard, ChatPane, ServerSettingsModal) that cannot be
 * mounted in a unit test. Each "uses X" claim has a "no longer has Y" control.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');
const walk = (dir: string, out: string[] = []): string[] => {
    for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(full);
    }
    return out;
};

describe('block / remove friend', () => {
    const dashboard = read('Dashboard.tsx');
    const chat = read('ChatPane.tsx');
    const friends = read('FriendsPane.tsx');

    it('Dashboard asks through FriendActionDialog; the hand-rolled block ClModal is gone', () => {
        expect(dashboard).toContain("from './FriendActionDialog'");
        expect(dashboard).toMatch(/<FriendActionDialog[\s\S]*?kind=\{friendActionConfirm\.kind\}/);
        expect(dashboard).not.toContain('sidebarBlockConfirm');
        expect(dashboard).not.toContain('<ClModal');
    });

    it('every Dashboard Block menu item and the profile card route through handleSidebarBlock (no direct POST)', () => {
        expect(dashboard).toContain("onBlock={(uid, uname) => { setProfileModalUserId(null); handleSidebarBlock(uid, uname); }}");
        // The only /friends/block request left in Dashboard is inside confirmFriendAction.
        expect(dashboard.match(/\/friends\/block/g)?.length).toBe(1);
        expect(dashboard).toMatch(/confirmFriendAction = async[\s\S]*?\/friends\/block/);
    });

    it('Remove Friend is confirmed from the DM list menu and the profile card (it used to delete on one click)', () => {
        expect(dashboard).toContain('handleSidebarRemoveFriend(conv.other_user_id!, conv.title');
        expect(dashboard).toContain('onRemoveFriend={(uid, uname) => { setProfileModalUserId(null); handleSidebarRemoveFriend(uid, uname); }}');
        // The menu item no longer deletes on select.
        expect(dashboard).not.toMatch(/label: 'Remove Friend',\s*danger: true,\s*onSelect: async/);
        expect(dashboard).toMatch(/confirmFriendAction = async[\s\S]*?axios\.delete\(apiUrl`\/friends\/\$\{targetId\}`/);
    });

    it('ChatPane DM header menu uses FriendActionDialog; its private overlay ConfirmDialog is gone', () => {
        expect(chat).toContain("from './FriendActionDialog'");
        expect(chat).not.toMatch(/const ConfirmDialog: React\.FC/);
        expect(chat).not.toContain('SharedConfirmDialog');
        expect(chat).not.toContain("position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)'");
        expect(chat).toMatch(/kind: 'block', userId: otherId/);
        expect(chat).toMatch(/kind: 'unfriend', userId: otherId/);
    });

    it('FriendsPane uses FriendActionDialog for both actions', () => {
        expect(friends).toContain("from './FriendActionDialog'");
        expect(friends).toMatch(/kind: 'block'/);
        expect(friends).toMatch(/kind: 'unfriend'/);
        expect(friends).not.toContain('ClConfirm');
    });
});

describe('no native dialogs left in the renderer', () => {
    it('no window.confirm / window.alert / window.prompt call in shipped source', () => {
        const hits: string[] = [];
        for (const f of walk(SRC)) {
            const s = readFileSync(f, 'utf8');
            s.split('\n').forEach((line, i) => {
                const t = line.trim();
                if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.includes('{/*')) return;
                const code = line.replace(/\/\/.*$/, '');
                if (/\bwindow\.(confirm|alert|prompt)\s*\(/.test(code)) hits.push(`${f.slice(SRC.length + 1)}:${i + 1}`);
            });
        }
        expect(hits).toEqual([]);
    });

    it('DevicesPane confirms remove-device and sign-out-others with ClConfirm, and only acts on confirm', () => {
        const pane = read('settings', 'panes', 'DevicesPane.tsx');
        expect(pane.match(/<ClConfirm/g)?.length).toBe(2);
        // The row buttons only OPEN the prompt; the request lives in the confirm handlers.
        expect(pane).toContain('onClick={() => setConfirmRevokeId(d.device_id)}');
        expect(pane).toContain('onClick={() => setConfirmRevokeOthers(true)}');
        expect(pane).toContain('onConfirm={() => { if (confirmRevokeId) void handleRevokeDevice(confirmRevokeId); }}');
    });
});

describe('server settings', () => {
    const modal = read('server', 'ServerSettingsModal.tsx');

    it('delete server and transfer ownership use PasswordConfirmDialog; the bare ClModal cards are gone', () => {
        expect(modal.match(/<PasswordConfirmDialog/g)?.length).toBe(2);
        expect(modal).not.toContain('<ClModal');
        expect(modal).not.toContain("cardStyle={{ padding: 0, overflow: 'hidden' }}");
    });

    it('the kick / ban dialog is NOT nested inside another modal (it never rendered there)', () => {
        const at = modal.indexOf('<MemberActionDialog');
        expect(at).toBeGreaterThan(-1);
        // Everything between the previous top-level JSX comment and the dialog must not open a PasswordConfirmDialog/ClModal.
        const before = modal.slice(Math.max(0, at - 400), at);
        expect(before).not.toMatch(/<PasswordConfirmDialog[^>]*$/);
        expect(before).not.toContain('<ClModal');
        // And the transfer dialog is a sibling that closes before the kick/ban block starts.
        expect(modal.slice(at).indexOf('Transfer Ownership dialog')).toBeGreaterThan(0);
    });
});

describe('report / prompts / security dialogs use the dialog frame', () => {
    it.each([
        ['ReportModal.tsx', ['ReportModal.tsx']],
        ['AnimatedImageDialog.tsx', ['settings', 'panes', 'AnimatedImageDialog.tsx']],
        ['ChannelTopicDialog.tsx', ['server', 'ChannelTopicDialog.tsx']],
        ['ServerTextPromptDialogs.tsx', ['server', 'ServerTextPromptDialogs.tsx']],
        ['TotpSettingsCard.tsx', ['auth', 'TotpSettingsCard.tsx']],
    ])('%s renders DialogHeader inside a dlg-card', (_name, path) => {
        const s = read(...path);
        expect(s).toContain('<DialogHeader');
        expect(s).toContain('dlg-card');
    });

    it('ServerContextPanel no longer hand-rolls the rename-call and nickname modals', () => {
        const s = read('server', 'ServerContextPanel.tsx');
        expect(s).toContain('<RenameCallDialog');
        expect(s).toContain('<NicknameDialog');
        expect(s).not.toContain('<ClModal');
    });
});
