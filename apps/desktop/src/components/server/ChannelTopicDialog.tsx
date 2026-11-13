/**
 * ChannelTopicDialog — small read-only popup that shows a channel's full
 * topic / description. Triggered by clicking the truncated topic line in
 * the chat header when there's more text than fits on one row.
 */

import React from 'react';
import { Hash } from 'lucide-react';
import { ChannelIconRenderer } from './ChannelIconPicker';
import { ClModal, ClButton } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';
import { DialogHeader, DialogBody, DialogFooter, DialogText } from '../dialog/DialogFrame';

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
        <ClModal open={!closing} onClose={handleClose} width={460} label={`${channelName} topic`} cardClassName="dlg-card">
            <DialogHeader
                icon={iconName
                    ? <ChannelIconRenderer name={iconName} size={17} />
                    : iconEmoji
                        ? <span className="text-base leading-none">{iconEmoji}</span>
                        : <Hash size={18} strokeWidth={2.2} />}
                title={channelName}
                subtitle="Channel topic"
            />
            <DialogBody className="dlg-body--scroll">
                <DialogText>
                    <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{topic}</span>
                </DialogText>
            </DialogBody>
            <DialogFooter>
                <ClButton variant="ghost" size="sm" onClick={handleClose}>Close</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default ChannelTopicDialog;
