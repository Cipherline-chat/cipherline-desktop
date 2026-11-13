import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guards for persistent system messages. Dashboard and
 * ChatPane have no render harness (see mentionRosterWiring.test.ts), so these
 * pin the registrations that make utils/systemMessages.test.ts's behaviour
 * reachable in the real app, and that the old ephemeral path is really gone.
 */
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const dashboard = read('Dashboard.tsx');
const chatPane = read('ChatPane.tsx');
const realtime = read('../hooks/useRealtime.ts');

describe('the single-slot ephemeral injection stays gone; the legacy event is a deduped fallback', () => {
    it('Dashboard no longer injects synthetic sys_* text rows or reads a single-slot event', () => {
        expect(dashboard).not.toMatch(/channelSystemEvent/);
        expect(dashboard).not.toMatch(/sys_\$\{Date\.now\(\)\}/);
        expect(dashboard).not.toContain('Inject ephemeral system messages');
        expect(dashboard).not.toMatch(/was kicked by \$\{actor_username/);
    });

    it('useRealtime keeps no single-slot state; channel:system_event goes to a callback', () => {
        expect(realtime).not.toMatch(/setChannelSystemEvent|channelSystemEvent/);
        expect(realtime).toMatch(/msg\.event === 'channel:system_event'/);
        expect(realtime).toContain('onLegacySystemEventRef.current?.(msg.data as Record<string, unknown>)');
    });

    it('Dashboard registers the legacy handler and builds the line from ids via the shared helpers', () => {
        expect(dashboard).toMatch(/useRealtime\(token, pullMessages, handleChannelMessage, deviceId, userId, handleChannelSystemMessage, handleLegacySystemEvent\)/);
        expect(dashboard).toContain('memberEventFromLegacy(data)');
        expect(dashboard).toContain('addEphemeralMemberEventRow(existing, row)');
    });

    it('a history fold drops ephemeral lines a persisted row supersedes', () => {
        expect(dashboard).toContain('dropShadowedEphemeralRows(unTombstoned)');
    });

    it('ChatPane: a line with no server row gets only a LOCAL hide, never a server delete', () => {
        // Right-click only (owner, 2026-11-08): no hover trash button; the menu
        // labels follow the delete mode.
        expect(chatPane).toContain('label: systemRowDeleteLabel(mode)');
        // The delete path routes a line without a server row to the local hide (utils/systemRowDelete.ts).
        expect(chatPane).toMatch(/systemRowDeleteMode\(target, \{ canManageMessages, isServerChannel \}\) === 'local'/);
    });
});

describe('the persisted path is wired', () => {
    it('useRealtime hands channel:system_message to a callback (no state slot)', () => {
        expect(realtime).toMatch(/msg\.event === 'channel:system_message'/);
        expect(realtime).toContain('onChannelSystemMessageRef.current?.(msg.data as ChannelSystemMessageEvent)');
    });

    it('Dashboard registers the handler with useRealtime', () => {
        expect(dashboard).toContain('const handleChannelSystemMessage = useCallback(');
        expect(dashboard).toMatch(/useRealtime\(token, pullMessages, handleChannelMessage, deviceId, userId, handleChannelSystemMessage, handleLegacySystemEvent\)/);
    });

    it('every history read opts in to system rows, as do the unread count and the mention scan', () => {
        expect(dashboard).toMatch(/params: \{ include_system: 1, \.\.\.params \}/);
        expect(dashboard).toMatch(/params: \{ limit: Math\.min\(unreadCount, 100\), include_system: 1 \}/);
        expect(dashboard).toMatch(/servers\/\$\{sid\}\/unread`, \{[\s\S]{0,300}params: \{ include_system: 1 \}/);
    });

    it('a system history row is turned into a local row WITHOUT any decrypt', () => {
        const at = dashboard.indexOf('if (isRawSystemRow(m)) return memberEventFromHistory(channelId, m);');
        expect(at).toBeGreaterThan(-1);
        // ...and it precedes the decrypt call in the same function
        const decryptAt = dashboard.indexOf('window.electronAPI!.decryptChannelMessage({', at);
        expect(decryptAt).toBeGreaterThan(at);
        expect(decryptAt - at).toBeLessThan(1500);
    });

    it('ChatPane renders member-event rows, offers NO reactions, moderator delete (right-click), no reply/edit there', () => {
        const start = chatPane.indexOf('if (isMemberEventContent(msg.content)) {');
        expect(start).toBeGreaterThan(-1);
        const end = chatPane.indexOf('// DM placeholder (Message integrity', start);
        const block = chatPane.slice(start, end);
        expect(block).toContain('memberEventText(ev, id => userIdToUsername[id])');
        // Owner 2026-11-11: no reaction affordance of any kind on these lines.
        expect(block).not.toMatch(/canReact|reactionChips|SmilePlus|EmojiPickerPopover|setShowEmojiPicker|aria-label="React"/);
        expect(block).toContain('onContextMenu={(e) => openMemberEventMenu(e, msg)}');
        // The hover trash button is gone: delete lives only in the right-click menu.
        expect(block).not.toContain('<Trash2');
        expect(block).not.toMatch(/setReplyingId|startEdit|Reply/);
        // The menu offers delete only by the shared rule (server delete needs MANAGE_MESSAGES).
        const menu = chatPane.slice(chatPane.indexOf('const openMemberEventMenu = '), chatPane.indexOf('const openUndeliveredMenu = '));
        expect(menu).not.toMatch(/Add Reaction|SmilePlus|setShowEmojiPicker/);
        expect(menu).toContain('systemRowDeleteMode(msg, { canManageMessages, isServerChannel })');
        expect(menu).toContain("requestDelete(msg, { entryPoint: 'contextmenu', shiftKey: false }, false)");
    });

    it('the shared reaction funnel refuses a system row', () => {
        const fn = chatPane.slice(chatPane.indexOf('const handleAddReaction = '));
        expect(fn.slice(0, 600)).toContain("if (msg?.content?.type === 'system') return;");
    });

    it('ChatPane resolves names for member-event rows through the same lazy lookup as senders', () => {
        expect(chatPane).toMatch(/isMemberEventContent\(msg\.content\)\s*\?\s*memberEventUserIds\(msg\.content\)/);
    });
});
