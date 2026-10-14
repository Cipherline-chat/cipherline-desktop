/**
 * "Learn more" for the server storage grace — a plain, in-app explanation of
 * the policy (packages/shared/storage-grace.ts). In-app rather than a web link:
 * there is no help-center page for it, and the facts all fit on one card.
 */
import React from 'react';
import { HardDrive } from 'lucide-react';
import { formatBytes, SERVER_STORAGE_GRACE_DAYS, FREE_OWNER_STORAGE_BYTES } from '@cipherline/shared';
import { ClModal } from '../cl';
import { ClButton } from '../ClButton';

export const STORAGE_GRACE_EXPLAINER_POINTS: readonly string[] = (() => {
    const free = formatBytes(FREE_OWNER_STORAGE_BYTES);
    return [
        `A server's saved storage (saved and pinned messages with their files, plus custom emojis) follows its owner's plan: ${free} on the free plan, and 100 MB to 10 GB with Pro as the server grows.`,
        `If a server uses more than ${free} while its owner is on the free plan, nothing is removed right away. New saves and emojis are paused, and there are ${SERVER_STORAGE_GRACE_DAYS} days to sort it out.`,
        'Any one of these ends it with nothing removed: the owner gets Pro again, ownership moves to a member who has Pro, or enough emojis and saved messages are removed to get back under the limit.',
        `Otherwise, at the deadline the server is trimmed back to ${free}: the oldest custom emojis are removed first, then the oldest saved messages and their files, stopping as soon as it fits.`,
        'The owner gets email reminders along the way, and server admins see the countdown here.',
    ];
})();

export const StorageGraceExplainer: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => (
    <ClModal open={open} onClose={onClose} width={460} label="How server storage works" overlayStyle={{ zIndex: 1100 }}>
        <div className="flex items-center gap-2.5 mb-3">
            <HardDrive size={18} style={{ color: 'var(--cl-lume)' }} />
            <h2 className="m-0 text-[17px] font-semibold text-cl-text" style={{ fontFamily: 'var(--cl-font-display)' }}>
                How server storage works
            </h2>
        </div>
        <ul className="m-0 pl-4 space-y-2 text-[13px] leading-relaxed text-cl-muted list-disc">
            {STORAGE_GRACE_EXPLAINER_POINTS.map(p => <li key={p}>{p}</li>)}
        </ul>
        <div className="flex justify-end mt-4">
            <ClButton type="button" variant="primary" onClick={onClose}>Got it</ClButton>
        </div>
    </ClModal>
);

export default StorageGraceExplainer;
