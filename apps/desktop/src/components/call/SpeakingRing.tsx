import React from 'react';
import { useIsCallParticipantSpeaking } from '../../utils/callSpeakingStore';
import { useCallPersonalization } from '../../utils/callPersonalizationStore';
import { speakingShadow } from '../../utils/callPersonalizationStyle';

/**
 * Avatar wrapper whose ring follows one participant's speaking state, drawn in
 * THEIR chosen ring colour (utils/callPersonalizationStyle.ts; stock green
 * when they have not picked one).
 *
 * The subscription lives HERE, not in the roster that renders it, so a
 * speaking flip re-renders this one div — not the server panel / member list
 * around it. `children` is the same element object across those re-renders,
 * so the avatar inside is not re-rendered either. See utils/callSpeakingStore.ts.
 */
export const SpeakingRing: React.FC<{
    uid: string;
    className: string;
    /** Glow blur (px) and opacity of the speaking ring. */
    glow: number;
    glowAlpha: number;
    idleClassName?: string;
    children: React.ReactNode;
}> = ({ uid, className, glow, glowAlpha, idleClassName = '', children }) => {
    const speaking = useIsCallParticipantSpeaking(uid);
    const { ring_color } = useCallPersonalization(uid);
    return (
        <div
            className={`${className} ${speaking ? '' : idleClassName}`}
            style={speaking ? { boxShadow: speakingShadow(ring_color, { glow, alpha: glowAlpha }) } : undefined}
        >
            {children}
        </div>
    );
};
