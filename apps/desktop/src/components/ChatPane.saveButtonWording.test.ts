/**
 * Source scans for two small ChatPane.tsx fixes (audit-fixes items 4 and 5a).
 * Same technique as dmInbound.test.ts / channelHistoryMerge.test.ts's
 * Dashboard-wiring blocks: ChatPane is a ~7k-line component with no
 * component-test harness, so these pin the exact source shape instead of
 * mounting it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'ChatPane.tsx'), 'utf8');

/**
 * Item 4: the personal "Save for me" hover-toolbar button used to show
 * 'Saved' / 'Save — keep forever' and light up when EITHER the message was
 * personally saved OR pinned (`saved || pinnedMsgIds.includes(msg.id)`).
 * Now matches the context menu's own "Save for me" / "Remove from my saves"
 * wording, and `saved` alone drives the active state — the channel case has
 * its own "Save to server" button/state now, and the DM case already gets
 * `saved` set at pin time (see the comment right above this button in
 * ChatPane.tsx and Dashboard.tsx's incoming-pin-op handler, which both call
 * retention.saveMessage()/saveAttachment() on a pin add).
 */
describe('the personal "Save for me" hover-toolbar button', () => {
    // Bounded to the Save/unsave button block specifically, not the whole
    // file, so a match elsewhere (e.g. the context menu's own copy of this
    // wording) can't accidentally satisfy these assertions.
    const start = src.indexOf('{/* Save / unsave — text, invite, and attachment messages.');
    const end = src.indexOf('{isMe && msg.content?.type', start);
    const block = src.slice(start, end);

    it('meta: found the button block', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    it('label matches the context menu\'s wording: "Save for me" / "Remove from my saves"', () => {
        expect(block).toContain("label={saved ? 'Remove from my saves' : 'Save for me'}");
        expect(block).not.toContain("'Save — keep forever'");
        expect(block).not.toContain("'Saved'");
    });

    it('active state and icon stroke are driven by `saved` alone, not `pinnedMsgIds`', () => {
        expect(block).toContain('active={saved}');
        expect(block).toContain('strokeWidth={saved ? 2.5 : 2}');
        expect(block).not.toContain('pinnedMsgIds.includes(msg.id) ? 2.5');
        expect(block).not.toContain('active={saved || pinnedMsgIds');
    });
});

/**
 * Item 5a: the pinned-sidebar panel's `canUnpin` prop used to re-derive
 * "!activeChannel || canManageMessages" a third time (the hover bar and the
 * context menu already share this exact rule via `canPinInThisChat` /
 * `canPinMessage`, messageMenuGating.ts) — now reuses the same variable.
 */
describe('PinnedMessagesPanel canUnpin prop', () => {
    it('passes the shared canPinInThisChat variable instead of re-deriving the rule', () => {
        expect(src).toContain('canUnpin={canPinInThisChat}');
        expect(src).not.toContain('canUnpin={!activeChannel || canManageMessages}');
    });
});
