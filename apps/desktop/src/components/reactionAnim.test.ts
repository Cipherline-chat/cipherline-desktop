import { describe, it, expect } from 'vitest';
import { decideReactionAnim } from './reactionAnim';

describe('decideReactionAnim', () => {
    it('never fires on first mount, no matter what the initial snapshot looks like', () => {
        expect(decideReactionAnim(null, { count: 1, hasMine: true })).toBeNull();
        expect(decideReactionAnim(null, { count: 5, hasMine: false })).toBeNull();
        expect(decideReactionAnim(null, { count: 0, hasMine: false })).toBeNull();
    });

    it('fires "add" when hasMine flips false -> true (you reacted)', () => {
        expect(decideReactionAnim({ count: 1, hasMine: false }, { count: 2, hasMine: true })).toBe('add');
    });

    it('fires "remove" when hasMine flips true -> false (you un-reacted)', () => {
        expect(decideReactionAnim({ count: 2, hasMine: true }, { count: 1, hasMine: false })).toBe('remove');
    });

    it('fires "bump" when hasMine stays true and the count rises (someone else piled on)', () => {
        expect(decideReactionAnim({ count: 1, hasMine: true }, { count: 2, hasMine: true })).toBe('bump');
    });

    it('does NOT fire "bump" for your own add — that transition is "add", not "bump"', () => {
        // Guards against the two branches being confused: a fresh add also
        // raises the count, but hasMine going false->true must win.
        const kind = decideReactionAnim({ count: 0, hasMine: false }, { count: 1, hasMine: true });
        expect(kind).toBe('add');
        expect(kind).not.toBe('bump');
    });

    it('does nothing when hasMine stays true and the count is unchanged', () => {
        expect(decideReactionAnim({ count: 3, hasMine: true }, { count: 3, hasMine: true })).toBeNull();
    });

    it('bumps when hasMine stays false but the count RISES (someone else reacted)', () => {
        // This assertion used to expect null — it pinned the very bug the app
        // owner reported: a bystander saw no animation when someone else
        // reacted. Corrected, not deleted, so the intent stays recorded.
        expect(decideReactionAnim({ count: 1, hasMine: false }, { count: 2, hasMine: false })).toBe('bump');
    });

    it('does not fire "bump" when hasMine stays true but the count falls (another reactor left)', () => {
        expect(decideReactionAnim({ count: 3, hasMine: true }, { count: 2, hasMine: true })).toBeNull();
    });
});

describe('remote reactions animate for a bystander', () => {
    // The regression: every branch used to be gated on the viewer's own
    // hasMine, so watching someone ELSE react was completely silent.
    it('bumps when someone else reacts and you have NOT reacted', () => {
        expect(decideReactionAnim({ count: 1, hasMine: false }, { count: 2, hasMine: false }))
            .toBe('bump');
    });

    it('still bumps when someone else piles onto YOUR reaction', () => {
        expect(decideReactionAnim({ count: 1, hasMine: true }, { count: 2, hasMine: true }))
            .toBe('bump');
    });

    it('does NOT animate when someone else REMOVES their reaction', () => {
        expect(decideReactionAnim({ count: 2, hasMine: false }, { count: 1, hasMine: false }))
            .toBeNull();
    });

    it('prefers add over bump when the count rises because YOU reacted', () => {
        expect(decideReactionAnim({ count: 1, hasMine: false }, { count: 2, hasMine: true }))
            .toBe('add');
    });
});
