/**
 * ChannelTopicDialog — small read-only popup that shows a channel's full
 * topic / description. Triggered by clicking the truncated topic line in
 * the chat header when there's more text than fits on one row.
 */

import React from 'react';
import { Hash, X } from 'lucide-react';
import { ChannelIconRenderer } from './ChannelIconPicker';
import { ClModal, ClButton } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';

interface Props {
    channelName: string;
    topic: string;
    iconEmoji?: string | null;
    iconName?: string | null;
    onClose: () => void;
}

export const ChannelTopicDialog: React.FC<Props> = ({ channelName, topic, iconEmoji, iconName, onClose }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);

    return (
        <ClModal open={!closing} onClose={handleClose} width={440} cardStyle={{ padding: '24px' }}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-cl-lume/15 flex items-center justify-center text-cl-lume border border-cl-lume/20 shrink-0">
                        {iconName
                            ? <ChannelIconRenderer name={iconName} size={16} />
                            : iconEmoji
                                ? <span className="text-base leading-none">{iconEmoji}</span>
                                : <Hash size={16} />}
                    </div>
                    <div className="min-w-0">
                        <h2 className="font-display font-semibold text-[16px] text-cl-text mt-0 mb-0 truncate">{channelName}</h2>
                        <p className="text-[11px] text-cl-faint">Channel topic</p>
                    </div>
                </div>
                <ClButton icon onClick={handleClose} variant="ghost" tooltip="Close">
                    <X size={16} />
                </ClButton>
            </div>

            <div className="text-sm text-cl-muted leading-relaxed whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto custom-scrollbar">
                {topic}
            </div>
        </ClModal>
    );
};

export default ChannelTopicDialog;
