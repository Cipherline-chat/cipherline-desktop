import { describe, it, expect } from 'vitest';
import { publishGrants } from './livekitPublishGrants';

const tok = (video: unknown) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc({ alg: 'HS256' })}.${enc({ video })}.sig`;
};

describe('publishGrants', () => {
    it('everything allowed when the token grants publish with no source list', () => {
        expect(publishGrants(tok({ roomJoin: true, canPublish: true }))).toEqual({ microphone: true, camera: true });
        expect(publishGrants(tok({ roomJoin: true }))).toEqual({ microphone: true, camera: true });
    });

    it('CONNECT without SPEAK: canPublish false → listen-only (the server\'s empty-source token)', () => {
        expect(publishGrants(tok({ roomJoin: true, canPublish: false }))).toEqual({ microphone: false, camera: false });
    });

    it('a source allow-list is honoured per source', () => {
        expect(publishGrants(tok({ canPublish: true, canPublishSources: ['microphone'] }))).toEqual({ microphone: true, camera: false });
        expect(publishGrants(tok({ canPublish: true, canPublishSources: ['camera', 'screen_share'] }))).toEqual({ microphone: false, camera: true });
    });

    it('is case-insensitive about source names', () => {
        expect(publishGrants(tok({ canPublish: true, canPublishSources: ['MICROPHONE'] })).microphone).toBe(true);
    });

    it('an empty allow-list with canPublish true is not "nothing" (LiveKit treats it as unrestricted)', () => {
        expect(publishGrants(tok({ canPublish: true, canPublishSources: [] }))).toEqual({ microphone: true, camera: true });
    });

    it('an unreadable or missing token changes nothing (old behaviour)', () => {
        for (const t of [undefined, null, '', 'garbage', 'a.b.c', 'a.!!!.c', tok(undefined)]) {
            expect(publishGrants(t as string | null | undefined)).toEqual({ microphone: true, camera: true });
        }
    });
});

import { canPublishMicrophone } from './livekitPublishGrants';

describe('canPublishMicrophone (the live connection)', () => {
    it('true when the SFU has said nothing yet', () => {
        expect(canPublishMicrophone(undefined)).toBe(true);
        expect(canPublishMicrophone({})).toBe(true);
        expect(canPublishMicrophone({ permissions: undefined })).toBe(true);
    });
    it('false for a listen-only member', () => {
        expect(canPublishMicrophone({ permissions: { canPublish: false } })).toBe(false);
    });
    it('honours the source allow-list (2 = microphone)', () => {
        expect(canPublishMicrophone({ permissions: { canPublish: true, canPublishSources: [2] } })).toBe(true);
        expect(canPublishMicrophone({ permissions: { canPublish: true, canPublishSources: [1, 3] } })).toBe(false);
        expect(canPublishMicrophone({ permissions: { canPublish: true, canPublishSources: [] } })).toBe(true);
    });
});
