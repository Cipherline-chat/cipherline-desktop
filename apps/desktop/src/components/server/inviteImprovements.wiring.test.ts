/**
 * Source-level wiring for the Invite People improvements (the "module tested in
 * isolation but never wired" guard). Behaviour lives in
 * ServerInviteModal.invite.test.ts, utils/inviteFriends.test.ts and
 * utils/serverSettingsAccess.test.ts; this proves Dashboard actually connects
 * them: the server-rail context menu entry, its permission gate, the dialog's
 * friend data, and the send path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dash = readFileSync(join(__dirname, '..', 'Dashboard.tsx'), 'utf8');
const modal = readFileSync(join(__dirname, 'ServerInviteModal.tsx'), 'utf8');

/** The body of `openServerRailMenu` (the server-rail right-click handler). */
function railMenu(): string {
    const start = dash.indexOf('const openServerRailMenu = (e: React.MouseEvent, srv: ServerInfo) =>');
    expect(start).toBeGreaterThan(-1);
    return dash.slice(start, dash.indexOf('const openFolderRailMenu', start));
}

describe('server rail context menu: Invite people', () => {
    const menu = railMenu();

    it('gates the item on the invite permission (owner / ADMINISTRATOR / CREATE_INVITE), not on Settings access', () => {
        expect(dash).toContain("import { canOpenServerSettings, canCreateInvite, type ServerSettingsTab } from '../utils/serverSettingsAccess'");
        expect(menu).toMatch(/const canInviteSrv = canCreateInvite\(myPermissions\[srv\.server_id\] \?\? 0n, isOwner\);/);
        expect(menu).toMatch(/\.\.\.\(canInviteSrv \? \[\{[\s\S]*?label: 'Invite people'[\s\S]*?\}\] : \[\]\)/);
    });

    it('selecting it opens the Invite People dialog for THAT server, without navigating', () => {
        const item = menu.slice(menu.indexOf("label: 'Invite people'"));
        const handler = item.slice(0, item.indexOf('}] : []'));
        expect(handler).toContain('setInviteServerId(srv.server_id)');
        expect(handler).toContain('setShowInviteModal(true)');
        expect(handler).not.toContain('setActiveServerView');
        expect(handler).not.toContain('setActiveTab');
    });

    it('sits with the other server actions, ahead of Server Settings', () => {
        expect(menu.indexOf("label: 'Invite people'")).toBeGreaterThan(menu.indexOf("label: 'Mark as Read'"));
        expect(menu.indexOf("label: 'Invite people'")).toBeLessThan(menu.indexOf("label: 'Server Settings'"));
    });

    it('the channel-header Invite button is gated by the same helper and resets the target to the open server', () => {
        expect(dash).toMatch(/onOpenInvite=\{canCreateInvite\(_srvPermsHere, isThisServerOwner\) \? \(\) => \{ setInviteServerId\(null\); setShowInviteModal\(true\); \} : undefined\}/);
    });

    it('the dialog renders for the rail-chosen server id, falling back to the open server', () => {
        expect(dash).toMatch(/const sid = inviteServerId \?\? activeServerView\?\.serverId;/);
    });
});

describe('Dashboard → Invite People dialog: friends and the send path', () => {
    const mount = dash.slice(dash.indexOf('<ServerInviteModal'), dash.indexOf('<ServerInviteModal') + 900);

    it('passes the friends list, DM conversations, local activity map, blocked ids and the send callback', () => {
        expect(mount).toContain('friends={globalFriends?.accepted}');
        expect(mount).toContain('conversations={conversations}');
        expect(mount).toContain('lastActivityAt={lastActivityAt}');
        expect(mount).toContain('blockedIds={activityBlockedIds}');
        expect(mount).toContain('myUserId={userId}');
        expect(mount).toContain('onSendInvite={sendInviteCodeToFriend}');
    });

    it('sending reuses the dialog\'s existing code: DM find-or-create, then the normal E2EE signal_chat path, no new invite', () => {
        const start = dash.indexOf('const sendInviteCodeToFriend = React.useCallback');
        expect(start).toBeGreaterThan(-1);
        const fn = dash.slice(start, dash.indexOf('Returns a submenu items array', start));
        expect(fn).toContain('/conversations/dm');
        expect(fn).toContain('sendInviteCodeMessage(code, cId)');
        expect(fn).not.toContain('/invites');
        // Stays in the dialog: no navigation.
        expect(fn).not.toContain('setActiveChat');
        expect(fn).not.toContain('setActiveTab');
        const send = dash.slice(dash.indexOf('const sendInviteCodeMessage = React.useCallback'), start);
        expect(send).toContain('claim_otp=1');
        expect(send).toContain('encryptAndAddress(');
        expect(send).toContain("envelope_type: 'signal_chat'");
        expect(send).toContain("type: 'server_invite'");
    });

    it('the older Invite-to-Server submenus still mint a fresh invite and share it via the same send path', () => {
        const start = dash.indexOf('const sendInviteMessage = React.useCallback');
        const fn = dash.slice(start, dash.indexOf('const sendInviteCodeToFriend', start));
        expect(fn).toMatch(/\/servers\/\$\{serverId\}\/invites/);
        expect(fn).toContain('sendInviteCodeMessage(');
    });

    it('the dialog never re-checks the roster on keystrokes: membership comes from the roster cache only', () => {
        expect(modal).toContain("from '../../utils/serverRosterCache'");
        expect(modal).not.toMatch(/axios\.get\([^)]*members/);
    });
});

describe('the dialog itself', () => {
    it('has no Regenerate / "Create new link" control left', () => {
        expect(modal).not.toContain('createWithCurrentSettings');
        expect(modal).not.toContain('Create new link');
        expect(modal).not.toContain('RotateCw');
    });

    it('revokes superseded links through the invites DELETE route', () => {
        expect(modal).toMatch(/axios\.delete\(apiUrl`\/servers\/\$\{server\.server_id\}\/invites\/\$\{code\}`/);
    });
});
