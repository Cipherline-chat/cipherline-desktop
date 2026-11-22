/**
 * Share-audio helper identity (client side of apps/api/src/calls/share-audio-helper.ts).
 *
 * A phone that shares its screen with audio publishes that audio from a SECOND
 * LiveKit connection whose identity is `<userId>~share-audio`. It is part of
 * the sharer, never a person: it is not in any roster, tile list, count, join
 * sound or capability check, and its one ScreenShareAudio track is handled as
 * the SHARER's share audio — received and played only while that sharer's share
 * is watched (utils/screenShareAudioWatch.ts).
 *
 * Pure (structural types only): testable without LiveKit.
 */
export const SHARE_AUDIO_SUFFIX = '~share-audio';

export function isShareAudioHelperIdentity(identity: string | undefined | null): boolean {
    return typeof identity === 'string' && identity.endsWith(SHARE_AUDIO_SUFFIX);
}

/** The sharer a helper identity belongs to; null for anything that is not a helper. */
export function shareAudioOwnerIdentity(identity: string | undefined | null): string | null {
    return isShareAudioHelperIdentity(identity) ? (identity as string).slice(0, -SHARE_AUDIO_SUFFIX.length) : null;
}

export function shareAudioHelperIdentity(ownerIdentity: string): string {
    return `${ownerIdentity}${SHARE_AUDIO_SUFFIX}`;
}

/** Everything that is a real participant (helper connections dropped). Keeps the input's identity when nothing is dropped. */
export function withoutShareAudioHelpers<T extends { identity: string }>(list: readonly T[]): T[] {
    return list.some(p => isShareAudioHelperIdentity(p.identity)) ? list.filter(p => !isShareAudioHelperIdentity(p.identity)) : (list as T[]);
}

/** Number of real remote participants in a LiveKit `remoteParticipants` map. */
export function realRemoteCount(remotes: { values(): Iterable<{ identity: string }> }): number {
    let n = 0;
    for (const p of remotes.values()) if (!isShareAudioHelperIdentity(p.identity)) n++;
    return n;
}
