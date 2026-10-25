import { PhoneOff } from 'lucide-react';
import { ClButton, ClModal } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText } from '../dialog/DialogFrame';
import { useModalExit } from '../../hooks/useModalExit';

interface SoloKickDialogProps {
    onClose: () => void;
}

export const SoloKickDialog = ({ onClose }: SoloKickDialogProps) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    return (
        // Shown over the call chrome, hence the raised overlay z-index.
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={420}
            label="Call ended"
            overlayStyle={{ zIndex: 10000 }}
            cardClassName="dlg-card dlg-card--confirm"
        >
            <DialogHeader tone="danger" icon={<PhoneOff size={18} strokeWidth={2.2} />} title="Call ended" />
            <DialogBody>
                <DialogText>You were removed from the call because you were alone for 15 minutes.</DialogText>
            </DialogBody>
            <DialogFooter>
                <ClButton variant="primary" size="sm" onClick={handleClose}>Got it</ClButton>
            </DialogFooter>
        </ClModal>
    );
};
