import React from 'react';
import { useIsCallParticipantSpeaking } from '../../utils/callSpeakingStore';

/**
 * Avatar wrapper whose ring follows one participant's speaking state.
 *
 * The subscription lives HERE, not in the roster that renders it, so a
 * speaking flip re-renders this one div — not the server panel / member list
 * around it. `children` is the same element object across those re-renders,
 * so the avatar inside is not re-rendered either. See utils/callSpeakingStore.ts.
 */
export const SpeakingRing: React.FC<{
    uid: string;
    className: string;
    speakingClassName: string;
    idleClassName?: string;
    children: React.ReactNode;
}> = ({ uid, className, speakingClassName, idleClassName = '', children }) => {
    const speaking = useIsCallParticipantSpeaking(uid);
    return <div className={`${className} ${speaking ? speakingClassName : idleClassName}`}>{children}</div>;
};
