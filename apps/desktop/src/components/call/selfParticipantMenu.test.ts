import { describe, it, expect, vi } from 'vitest';
import { buildSelfParticipantMenuItems } from './selfParticipantMenu';

/** Narrow the ContextMenuItem union down to the action-row shape used here
 *  (label + onSelect), so tests can read `.label`/`.onSelect` without a
 *  type-narrowing dance against the `divider`/`custom` variants this
 *  builder never produces. */
function asAction(item: ReturnType<typeof buildSelfParticipantMenuItems>[number]) {
    return item as { label: string; onSelect: () => void };
}

describe('buildSelfParticipantMenuItems', () => {
    it('always includes View Profile as the first item', () => {
        const onViewProfile = vi.fn();
        const items = buildSelfParticipantMenuItems({
            canChangeOwnNick: false,
            onViewProfile,
            onChangeNickname: vi.fn(),
        });
        expect(items).toHaveLength(1);
        expect(asAction(items[0]).label).toBe('View Profile');
        asAction(items[0]).onSelect();
        expect(onViewProfile).toHaveBeenCalledTimes(1);
    });

    it('adds Change Nickname when canChangeOwnNick is true', () => {
        const onChangeNickname = vi.fn();
        const items = buildSelfParticipantMenuItems({
            canChangeOwnNick: true,
            onViewProfile: vi.fn(),
            onChangeNickname,
        });
        expect(items).toHaveLength(2);
        expect(asAction(items[1]).label).toBe('Change Nickname');
        asAction(items[1]).onSelect();
        expect(onChangeNickname).toHaveBeenCalledTimes(1);
    });

    it('omits Change Nickname when canChangeOwnNick is false', () => {
        const items = buildSelfParticipantMenuItems({
            canChangeOwnNick: false,
            onViewProfile: vi.fn(),
            onChangeNickname: vi.fn(),
        });
        expect(items.map(i => asAction(i).label)).toEqual(['View Profile']);
    });

    it('never calls onChangeNickname when the item is not offered', () => {
        // Guards against a future refactor accidentally wiring the callback
        // to something else that fires unconditionally.
        const onChangeNickname = vi.fn();
        buildSelfParticipantMenuItems({
            canChangeOwnNick: false,
            onViewProfile: vi.fn(),
            onChangeNickname,
        });
        expect(onChangeNickname).not.toHaveBeenCalled();
    });
});
