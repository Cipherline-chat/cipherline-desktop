/**
 * Reply needs the right to post: in a server channel without SEND_MESSAGES the
 * hover-bar Reply button and the context-menu Reply item are hidden, and
 * beginReply refuses (owner, 2026-10-20). Source-level wiring checks, like the
 * other ChatPane wiring tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(resolve(__dirname, 'ChatPane.tsx'), 'utf8');

describe('Reply is hidden where you cannot send', () => {
    it('derives canReplyHere from SEND_MESSAGES for server channels', () => {
        expect(src).toMatch(/const canReplyHere = canComposeInThisChat\s*&& \(!isServerChannel \|\| channelPermissions === undefined\s*\|\| !!\(channelPermissions & Permissions\.SEND_MESSAGES\)\);/);
    });
    it('gates the hover-bar Reply button', () => {
        expect(src).toMatch(/\{canReplyHere && \(\s*<MsgBarBtn\s*icon=\{<Reply \/>\}/);
    });
    it('gates the context-menu Reply item', () => {
        expect(src).toContain('if (canReplyToMessage(gateCtx) && canReplyHere) {');
    });
    it('beginReply refuses in a read-only channel', () => {
        expect(src).toMatch(/const beginReply = \(id: string\) => \{\s*if \(!canReplyHere\) return;/);
    });
});
