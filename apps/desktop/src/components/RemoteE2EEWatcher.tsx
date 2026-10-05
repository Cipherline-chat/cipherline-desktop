import { useEffect, useRef } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { watchRemoteE2EE, type RemoteEncryptionSnapshot } from '../utils/remoteE2EEWatch';

/**
 * Reports which REMOTE participants are publishing unencrypted media.
 *
 * Sibling to `E2EEActivator`, and deliberately its opposite number:
 * `E2EEActivator` enforces (and ends the call on a local failure), this only
 * observes. See utils/remoteE2EEWatch.ts for why remote plaintext must not be
 * fatal — refusing would make calling anyone on an older build impossible,
 * and our builds are unsigned so "they'll have auto-updated" is not safe.
 *
 * Must live inside <LiveKitRoom> for useRoomContext. Unlike E2EEActivator it
 * has no ordering requirement — it reads state the SDK already maintains, and
 * seeds itself from the current roster on mount, so mounting late only costs
 * a render, never a missed participant.
 *
 * Mounted UNCONDITIONALLY, including on a keyless call. A keyless call is one
 * where WE are the unencrypted party, and the peers we can still observe are
 * worth reporting either way; gating this on `keyB64` would blind the one
 * case where the local side is already known-bad.
 */
export const RemoteE2EEWatcher = ({ onChange }: {
    onChange: (snapshot: RemoteEncryptionSnapshot) => void;
}) => {
    const room = useRoomContext();
    // Latest-value ref so a re-render of CallPane (which recreates the inline
    // callback) never re-subscribes — the watch is keyed on the Room alone.
    const onChangeRef = useRef(onChange);
    useEffect(() => { onChangeRef.current = onChange; });

    useEffect(() => {
        return watchRemoteE2EE(room, (snapshot) => {
            if (snapshot.anyUnencrypted) {
                // One line per state change, not per frame — the watch
                // de-duplicates, so this cannot spam.
                console.warn(
                    '[CallPane] participant(s) publishing UNENCRYPTED media:',
                    snapshot.unencryptedIdentities.join(', '),
                );
            }
            onChangeRef.current(snapshot);
        });
    }, [room]);

    return null;
};
