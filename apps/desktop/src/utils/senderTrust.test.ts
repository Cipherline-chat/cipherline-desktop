import { describe, it, expect } from 'vitest';
import { hasUnverifiedDeviceWarning, isWarnable, type SenderVerdict } from './senderTrust';

describe('hasUnverifiedDeviceWarning — conversation-picker red marker rule', () => {
    it('is true for a contact with a stored key_changed verdict (positive control)', () => {
        // A device we HAVE seen before is now presenting a different key.
        // This is exactly the case the marker exists to surface.
        expect(hasUnverifiedDeviceWarning('bob', { bob: 'key_changed' })).toBe(true);
    });

    it('is true for a contact with a stored unrecognized_verified verdict', () => {
        // The forgery-shaped case: a contact the user has vouched for is
        // presenting a key they never vouched for.
        expect(hasUnverifiedDeviceWarning('bob', { bob: 'unrecognized_verified' })).toBe(true);
    });

    it('is true for a contact with a stored unattributed verdict', () => {
        // The server's own directory does not publish this key for this user.
        expect(hasUnverifiedDeviceWarning('bob', { bob: 'unattributed' })).toBe(true);
    });

    it('is false for a contact with no entry at all', () => {
        // No message from this contact has ever been judged warnable — the
        // common case for the overwhelming majority of conversation rows.
        expect(hasUnverifiedDeviceWarning('bob', {})).toBe(false);
        expect(hasUnverifiedDeviceWarning('bob', { alice: 'key_changed' })).toBe(false);
    });

    it('is false for a missing otherUserId (group chats, malformed rows)', () => {
        expect(hasUnverifiedDeviceWarning(null, { bob: 'key_changed' })).toBe(false);
        expect(hasUnverifiedDeviceWarning(undefined, { bob: 'key_changed' })).toBe(false);
        expect(hasUnverifiedDeviceWarning('', { '': 'key_changed' })).toBe(false);
    });

    it('is false for a plain first_contact entry, even if one somehow existed', () => {
        // In practice `senderWarnings` (Dashboard.tsx's pinAndDetect) never
        // writes a first_contact or ok entry — isWarnable already gates that
        // at the write site. This asserts the READ side enforces the same
        // rule independently, so the marker stays correct even if a future
        // caller feeds it a map from somewhere else that isn't as careful.
        const permissive: Record<string, SenderVerdict> = { bob: 'first_contact' };
        expect(hasUnverifiedDeviceWarning('bob', permissive)).toBe(false);
        const okMap: Record<string, SenderVerdict> = { bob: 'ok' };
        expect(hasUnverifiedDeviceWarning('bob', okMap)).toBe(false);
    });

    it('agrees with isWarnable for every SenderVerdict', () => {
        // The rule this function embodies is "warnable verdict is on file for
        // this contact" — assert that equivalence exhaustively rather than
        // just spot-checking a couple of cases above.
        const verdicts: SenderVerdict[] = ['ok', 'first_contact', 'key_changed', 'unrecognized_verified', 'unattributed'];
        for (const verdict of verdicts) {
            expect(hasUnverifiedDeviceWarning('bob', { bob: verdict })).toBe(isWarnable(verdict));
        }
    });

    it('is per-contact — one warned contact does not mark every row', () => {
        const warnings: Record<string, SenderVerdict> = { bob: 'key_changed' };
        expect(hasUnverifiedDeviceWarning('bob', warnings)).toBe(true);
        expect(hasUnverifiedDeviceWarning('carol', warnings)).toBe(false);
    });
});
