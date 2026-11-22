import { describe, it, expect, vi } from 'vitest';
import { Track } from 'livekit-client';
import {
    SHARE_AUDIO_SUFFIX, isShareAudioHelperIdentity, shareAudioOwnerIdentity, shareAudioHelperIdentity,
    withoutShareAudioHelpers, realRemoteCount,
} from './shareAudioHelper';
import { wantsShareAudio, reconcileShareAudioSubscriptions, shouldPlayShareAudio } from './screenShareAudioWatch';

const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const H = shareAudioHelperIdentity(U);

describe('share-audio helper identity', () => {
    it('matches the server format and round-trips', () => {
        expect(H).toBe(`${U}${SHARE_AUDIO_SUFFIX}`);
        expect(H.endsWith('~share-audio')).toBe(true);
        expect(isShareAudioHelperIdentity(H)).toBe(true);
        expect(shareAudioOwnerIdentity(H)).toBe(U);
    });
    it('a normal identity is not a helper', () => {
        expect(isShareAudioHelperIdentity(U)).toBe(false);
        expect(shareAudioOwnerIdentity(U)).toBeNull();
        expect(isShareAudioHelperIdentity(undefined)).toBe(false);
    });
    it('withoutShareAudioHelpers drops helpers and keeps identity when nothing is dropped', () => {
        const a = [{ identity: U }, { identity: 'b' }];
        expect(withoutShareAudioHelpers(a)).toBe(a);
        expect(withoutShareAudioHelpers([...a, { identity: H }]).map(p => p.identity)).toEqual([U, 'b']);
    });
    it('realRemoteCount ignores helpers (no "N in call" inflation)', () => {
        const m = new Map([[U, { identity: U }], [H, { identity: H }], ['b', { identity: 'b' }]]);
        expect(realRemoteCount(m)).toBe(2);
    });
});

describe('helper audio follows the SHARER\'s watch decision', () => {
    it('wants the helper\'s audio only while its owner is watched', () => {
        expect(wantsShareAudio(H, new Set([U]), 'me')).toBe(true);
        expect(wantsShareAudio(H, new Set(), 'me')).toBe(false);
        expect(wantsShareAudio(H, new Set(['other']), 'me')).toBe(false);
    });
    it('never wants your own helper back', () => {
        expect(wantsShareAudio(shareAudioHelperIdentity('me'), new Set(['me']), 'me')).toBe(false);
    });
    it('reconcile subscribes the helper\'s ScreenShareAudio on Watch and releases it on stop-watching', () => {
        const pub = { isDesired: true, setSubscribed: vi.fn((v: boolean) => { pub.isDesired = v; }) };
        const helper = { identity: H, getTrackPublication: (s: Track.Source) => (s === Track.Source.ScreenShareAudio ? pub : undefined) };
        // autoSubscribe delivered it: not watching -> released
        let r = reconcileShareAudioSubscriptions([helper], new Set(), 'me');
        expect(pub.setSubscribed).toHaveBeenLastCalledWith(false);
        expect(r.unsubscribed).toEqual([H]);
        // Watch the SHARER -> helper audio subscribed
        r = reconcileShareAudioSubscriptions([helper], new Set([U]), 'me');
        expect(pub.setSubscribed).toHaveBeenLastCalledWith(true);
        expect(r.subscribed).toEqual([H]);
        // steady state sends nothing
        pub.setSubscribed.mockClear();
        reconcileShareAudioSubscriptions([helper], new Set([U]), 'me');
        expect(pub.setSubscribed).not.toHaveBeenCalled();
    });
    it('the tile rule is unchanged: a share tile of a watched remote sharer plays', () => {
        expect(shouldPlayShareAudio({ isLocal: false, isScreenShareTile: true, watched: true })).toBe(true);
        expect(shouldPlayShareAudio({ isLocal: false, isScreenShareTile: true, watched: false })).toBe(false);
    });
});
