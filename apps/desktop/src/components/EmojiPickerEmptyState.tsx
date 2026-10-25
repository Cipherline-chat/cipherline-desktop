import React from 'react';
import { Server, SmilePlus } from 'lucide-react';
import { requestOpenSettings } from '../utils/openSettingsRequest';
import type { EmptyTabOverlay } from './useEmptyTabOverlay';

interface Props {
    overlay: EmptyTabOverlay;
    /** Closes the whole picker (used after jumping to Settings). */
    onClose: () => void;
    /** Scrolling or other interaction hands the grid back. */
    onDismiss: () => void;
}

/**
 * Shown over the emoji grid when an empty "Server emojis" / "My Emojis" tab is
 * chosen. My Emojis gets a button straight to Settings → Personalize, where
 * the library is managed.
 */
export const EmojiPickerEmptyState: React.FC<Props> = ({ overlay, onClose, onDismiss }) => {
    const { tab, top, bottom } = overlay;
    const Icon = tab.id === 'server' ? Server : SmilePlus;
    return (
        <div
            role="region"
            aria-label={tab.label}
            data-testid="emoji-picker-empty"
            onWheel={onDismiss}
            style={{ position: 'absolute', left: 0, right: 0, top, bottom, background: '#1e2024', zIndex: 3 }}
            className="flex flex-col items-center justify-center text-center gap-2 px-8"
        >
            <span className="w-11 h-11 rounded-full bg-white/[0.06] flex items-center justify-center text-cl-faint">
                <Icon size={20} aria-hidden="true" />
            </span>
            <p className="text-[13px] font-bold text-white/85 m-0">{tab.emptyTitle}</p>
            <p className="text-[12px] leading-snug text-white/50 m-0">{tab.emptyBody}</p>
            {tab.id === 'mine' && (
                <button
                    type="button"
                    onClick={() => { requestOpenSettings('personalize'); onClose(); }}
                    className="mt-1 px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-[12px] font-bold text-white/90 border-none cursor-pointer transition-colors"
                >
                    Open Personalize
                </button>
            )}
        </div>
    );
};

export default EmojiPickerEmptyState;
