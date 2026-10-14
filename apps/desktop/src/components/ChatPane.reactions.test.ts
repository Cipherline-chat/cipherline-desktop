import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Instant reactions, wiring. ChatPane has no render harness, so the rules that
 * keep the optimistic chip honest are pinned at the source level; each names
 * the way it would go wrong. The behaviour itself is unit-tested in
 * utils/pendingReactions.test.ts and (against the real pill) in
 * components/ReactionFailure.test.ts.
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const block = (from: string, to: string) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    expect(a, `missing: ${from}`).toBeGreaterThan(-1);
    expect(b, `missing: ${to}`).toBeGreaterThan(a);
    return src.slice(a, b);
};

const react = block('const handleReact = (msgId', 'const retryReaction = ');
const sender = block('const sendReactionFor = (msgId', 'const handleReact = (msgId');
const sendClient = block('const sendClientContent = async', 'const handleSendKlipyGif');

describe('a reaction click is optimistic', () => {
    it('goes through the pending-reaction store, not the fire-and-forget dispatcher', () => {
        expect(react).toContain('reactionStore.toggle(');
        // The old path: nothing changed until the echo came back.
        expect(react).not.toContain('dispatchAction');
        expect(src).not.toMatch(/dispatchAction\(\{ type: 'reaction'/);
    });

    it('every add path (pill, picker, quick-react menu) still funnels through handleAddReaction -> handleReact', () => {
        const add = block('const handleAddReaction = (msgId', 'const handleContextMenu = ');
        expect(add).toContain('handleReact(msgId, emoji, currentHasIt)');
        // The toggle decision is still made from the CONFIRMED state with isMyReaction.
        expect(add).toContain('isMyReaction(ids, user?.user_id, myDeviceIds)');
    });
});

describe('the send uses the message-send policy', () => {
    it('reactions ask for the bounded POST and pass the abort signal', () => {
        expect(sender).toContain("type: 'reaction'");
        expect(sender).toContain('bounded: true');
        expect(sender).toContain('signal');
    });

    it('bounded = 20 s timeout + 429 wait, on BOTH the channel and the DM/group POST', () => {
        expect(sendClient.match(/timeout: SEND_POST_TIMEOUT_MS/g)).toHaveLength(2);
        expect(sendClient.match(/opts\?\.bounded \? withRateLimitRetry\(/g)).toHaveLength(2);
        expect(sendClient.match(/signal: opts\.signal/g)).toHaveLength(2);
    });

    it('other callers of sendClientContent (edit, delete, GIF, ...) are unchanged: not bounded', () => {
        const rest = src.replace(sender, '');
        expect(rest).not.toMatch(/sendClientContent\([^)]*bounded/);
    });

    it('a missing / stale channel key still starts the key fetch, then the failure reaches the chip', () => {
        expect(sender).toContain('isStaleEpochError(err)');
        expect(sender).toContain('onChannelKeyMissing?.(channel.server_id, channel.channel_id)');
        expect(sender).toContain('throw err;');
    });
});

describe('the chip shows the pending state', () => {
    it('the reactions row is drawn from the overlay, not from msg.reactions', () => {
        // The chips are one shared definition (ordinary rows AND member-event system
        // rows), declared before the system branch and called where the row used to be.
        const row = block('const reactionChips = () => (', '// ── System messages: event bar');
        expect(src).toContain('{/* Reactions row');
        expect(src.slice(src.indexOf('{/* Reactions row'), src.indexOf('{/* Instant send: a message that did not go through'))).toContain('{reactionChips()}');
        expect(row).toContain('rxView.reactions');
        expect(row).not.toContain('msg.reactions');
        expect(row).toContain('failure={rxFailure ?');
        expect(row).toContain('retryReaction(rxFailure.key, msg.id, emoji)');
        expect(row).toContain('reactionStore.discard(rxFailure.key)');
    });

    it('a memoised row re-renders when ITS pending reactions change', () => {
        expect(src).toContain('const pendingRx = reactionStore.forMessage(reactionConvKey, msg.id);');
        expect(src).toMatch(/\.\.\.rowGlobals, msg, [^\n]*undelivered, pendingRx,/);
        // The row's Retry is the live stand-in, not the closure of a stale render.
        expect(src).toContain('openUndeliveredMenu, retrySend, discardUnsent, retryReaction,');
    });

    it('the pane re-renders on store changes and folds confirmed reactions in', () => {
        expect(src).toContain('const reactionsVersion = usePendingReactions();');
        const eff = block('// Fold the confirmed state', 'const startEdit = ');
        expect(eff).toContain('reactionStore.reconcile(reactionConvKey');
        expect(eff).toContain('[messages, reactionsVersion, reactionConvKey]');
    });

    it('the overlay is keyed per device + conversation, so it cannot leak across accounts or chats', () => {
        expect(src).toContain('`${deviceId ?? \'\'}:channel:${activeChannel.channel_id}`');
        expect(src).toContain('`${deviceId ?? \'\'}:dm:${activeChat.id}`');
    });
});
