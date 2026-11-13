import { describe, it, expect } from 'vitest';
import { buildCallIdentityMap, unresolvedCallParticipants } from './callIdentity';

describe('call identity resolution while viewing another server / DM', () => {
    it('resolves a non-friend joiner from the live JOIN event maps (was "Member", no avatar)', () => {
        const map = buildCallIdentityMap(['u1', 'u2'], {
            voiceNames: { u2: 'Joiner' },
            voiceAvatars: { u2: 'att-2' },
            friends: { u1: { username: 'Friend', avatar_url: 'att-1' } },
        });
        expect(map.u2).toEqual({ username: 'Joiner', avatar_url: 'att-2' });
        expect(map.u1).toEqual({ username: 'Friend', avatar_url: 'att-1' });
    });

    it('prefers nickname and the call server avatar map', () => {
        const map = buildCallIdentityMap(['u2'], {
            nicknames: { u2: 'Nick' }, voiceNames: { u2: 'user2' },
            serverAvatars: { u2: 'srv-att' }, voiceAvatars: { u2: 'att-2' },
        });
        expect(map.u2).toEqual({ username: 'Nick', avatar_url: 'srv-att' });
    });

    it('updates live: the same id resolves once its JOIN event lands', () => {
        const before = buildCallIdentityMap(['u2'], {});
        expect(before.u2).toBeUndefined();
        const after = buildCallIdentityMap(['u2'], { voiceNames: { u2: 'Late' }, voiceAvatars: { u2: 'a' } });
        expect(after.u2).toEqual({ username: 'Late', avatar_url: 'a' });
    });

    it('omits unknown ids and reports them as unresolved (excluding self)', () => {
        const s = { voiceNames: { a: 'A' } };
        expect(buildCallIdentityMap(['a', 'b'], s)).not.toHaveProperty('b');
        expect(unresolvedCallParticipants(['me', 'a', 'b'], 'me', s)).toEqual(['b']);
    });
});
