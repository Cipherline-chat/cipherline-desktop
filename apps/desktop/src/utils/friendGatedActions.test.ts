import { describe, it, expect } from 'vitest';
import { canOfferFriendGatedAction, type FriendRelationship } from './friendGatedActions';

describe('canOfferFriendGatedAction', () => {
    it('allows the action for the viewer\'s own profile (never gate on yourself)', () => {
        expect(canOfferFriendGatedAction('self')).toBe(true);
    });

    it('allows the action for an accepted friend', () => {
        expect(canOfferFriendGatedAction('friend')).toBe(true);
    });

    it('hides the action for a stranger', () => {
        expect(canOfferFriendGatedAction('stranger')).toBe(false);
    });

    it('hides the action while a request the viewer sent is still pending', () => {
        expect(canOfferFriendGatedAction('pending_outgoing')).toBe(false);
    });

    it('hides the action while a request the viewer received is still pending', () => {
        expect(canOfferFriendGatedAction('pending_incoming')).toBe(false);
    });

    it('hides the action for a blocked relationship', () => {
        expect(canOfferFriendGatedAction('blocked')).toBe(false);
    });

    it('hides the action for a removed ("ex") friend', () => {
        expect(canOfferFriendGatedAction('ex_friend')).toBe(false);
    });

    it('is exhaustive: every non-friend, non-self relationship is hidden', () => {
        const hidden: FriendRelationship[] = [
            'stranger', 'pending_outgoing', 'pending_incoming', 'blocked', 'ex_friend',
        ];
        for (const relationship of hidden) {
            expect(canOfferFriendGatedAction(relationship)).toBe(false);
        }
    });
});
