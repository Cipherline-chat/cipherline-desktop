import { PhoneOff } from 'lucide-react';
import { ClButton, ClModal } from '../cl';
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
            width={384}
            label="Call Ended"
            overlayStyle={{ zIndex: 10000 }}
            cardClassName="text-center"
        >
            <div className="mx-auto w-12 h-12 rounded-full bg-cl-flash/20 flex items-center justify-center mb-4">
                <PhoneOff className="w-6 h-6 text-cl-flash" />
            </div>
            <h3 className="text-cl-text font-bold text-lg mb-2">Call Ended</h3>
            <p className="text-cl-faint text-sm mb-6">
                You were removed from the call because you were alone for 15 minutes.
            </p>
            <ClButton variant="primary" fullWidth onClick={handleClose}>
                OK
            </ClButton>
        </ClModal>
    );
};
