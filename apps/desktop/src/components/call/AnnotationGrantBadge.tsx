/**
 * AnnotationGrantBadge - a small pencil beside a participant's name, shown
 * while that person holds an annotation grant somewhere in this call.
 *
 * One component for every surface a name appears on (video tile label,
 * participant rows and tiles, screen-share gate, huddle roster, the server
 * panel's voice/huddle lists) so the mark means exactly one thing everywhere
 * and can only ever be changed in one place.
 *
 * What it does NOT mark: a streamer's implicit right to draw on their own
 * tile. That is universal, so badging it would put a pencil on everyone who
 * shares and tell the room nothing. Only an explicit grant lights this up -
 * see selectCanAnnotate.
 *
 * Grant lists are mirrored from each surface's owner to every peer, so all
 * clients render the same badge for the same person at the same time, and it
 * clears the instant the owner revokes (annotationStore -> grant.list).
 *
 * Renders nothing at all when there is no grant: callers can drop it beside
 * any name without reserving space or adding a conditional of their own.
 */
import React from 'react';
import { Pencil } from 'lucide-react';
import { useAnnotationStore, selectCanAnnotate } from '../../utils/annotationStore';

export interface AnnotationGrantBadgeProps {
    /** LiveKit identity (= Cipherline user_id) of the person the name belongs to. */
    identity: string;
    /** Icon size in px. Defaults to 11 — sized to sit inside a name label. */
    size?: number;
    className?: string;
}

export const AnnotationGrantBadge: React.FC<AnnotationGrantBadgeProps> = ({ identity, size = 11, className }) => {
    const canAnnotate = useAnnotationStore(selectCanAnnotate(identity));
    if (!canAnnotate) return null;
    return (
        <span
            // role=img + a label: the pencil carries meaning, so it must not be
            // aria-hidden like the app's decorative icons.
            role="img"
            aria-label="Can annotate shared video"
            title="Can draw on shared video"
            className={`inline-flex shrink-0 items-center text-cl-lume ${className ?? ''}`}
        >
            <Pencil size={size} aria-hidden="true" />
        </span>
    );
};
