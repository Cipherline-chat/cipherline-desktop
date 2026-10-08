import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guard for "a sent message animates in once"
 * (utils/messageEntrance.ts, unit-tested in messageEntrance.test.ts). ChatPane
 * has no render harness, so — like feedScrollWiring / instantSendWiring — the
 * property "the feed actually uses the stable identity" is pinned by a scan:
 * a pure module tested and never consulted is the failure this guards against.
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

describe('ChatPane keys and animates message rows by their stable identity', () => {
    it('imports the identity helpers', () => {
        expect(src).toMatch(/import \{[^}]*assignRowKeys[^}]*createEntranceTracker[^}]*createRevealGate[^}]*messageRowKey[^}]*\} from '\.\.\/utils\/messageEntrance'/);
    });

    it('no message row is keyed by msg.id any more (an id swap remounted it and replayed its entrance)', () => {
        expect(src).not.toMatch(/key=\{msg\.id \?\? index\}/);
        expect(src).toContain('<MemoRow key={rowKey} deps={rowDeps}');
        // Every row variant's own Fragment carries the same key — a changing key
        // on the inner Fragment would remount the row even under a stable MemoRow.
        expect((src.match(/<React\.Fragment key=\{rowKey\}>/g) ?? []).length).toBeGreaterThanOrEqual(5);
        expect(src).toMatch(/const rowKeys = assignRowKeys\(displayMessages, deviceId\);/);
        expect(src).toMatch(/const rowKey = rowKeys\[index\];/);
    });

    it('the entrance decision and its animationend use the same identity', () => {
        expect(src).toMatch(/const \[entrance\] = useState<EntranceTracker>\(createEntranceTracker\);/);
        expect(src).toMatch(/entrance\.decide\(displayMessages, rowKeys\)/);
        expect(src).toMatch(/entrance\.finish\(rowKey\)/);
        // …and is reset per conversation.
        expect(src).toMatch(/entrance\.reset\(\);/);
        expect(src).toMatch(/entering \? \(isMe \? 'cl-msg-enter-sent' : 'cl-msg-enter-recv'\) : ''/);
        // The old id-keyed bookkeeping is gone.
        expect(src).not.toMatch(/seenMsgIdsRef|animateIds/);
    });

    it('the new-message reveal is gated on the identity, not on id::timestamp', () => {
        expect(src).toMatch(/const lastMsgKey = last \? messageRowKey\(last, deviceId, 'no-id'\) : null;/);
        expect(src).toMatch(/if \(!revealGate\.check\(chatId, lastMsgKey\)\) return;/);
        expect(src).not.toMatch(/\$\{last\.id \?\? 'no-id'\}::\$\{last\.timestamp/);
    });

    it('an instant text send flies the paper plane once (only an awaited send flies it again on success)', () => {
        const start = src.indexOf('const handleSendAll = async');
        const end = src.indexOf('const [pendingCallMode', start);
        const handler = src.slice(start, end);
        const plays = handler.match(/playIco\(sendIcoRef\.current, 'play-send'\)/g) ?? [];
        expect(plays.length).toBe(2);
        expect(handler).toContain("if (!earlyReleased) playIco(sendIcoRef.current, 'play-send');");
    });
});
