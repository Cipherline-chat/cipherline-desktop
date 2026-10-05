import React, { useState } from 'react';
import { Server, X } from 'lucide-react';
import { ClModal, ClButton, ClField, ClInput } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';

interface Props {
    onClose: () => void;
    onCreateServer: (name: string) => Promise<void>;
}

export const CreateServerModal: React.FC<Props> = ({ onClose, onCreateServer }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || trimmed.length < 2) { setError('Server name must be at least 2 characters'); return; }
        if (trimmed.length > 50) { setError('Server name must be 50 characters or less'); return; }
        setLoading(true);
        setError(null);
        try {
            await onCreateServer(trimmed);
            handleClose();
        } catch (err: any) {
            setError(err?.response?.data?.message ?? 'Failed to create server');
        } finally {
            setLoading(false);
        }
    };

    return (
        <ClModal open={!closing} onClose={handleClose} width={440} cardStyle={{ padding: '28px' }}>
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-cl-lume/15 flex items-center justify-center text-cl-lume border border-cl-lume/20">
                        <Server size={18} />
                    </div>
                    <div>
                        <h2 className="font-display font-semibold text-[17px] text-cl-text mt-0 mb-0">Create a Server</h2>
                        <p className="text-[12px] text-cl-faint">Invite-only — share a code after creation</p>
                    </div>
                </div>
                <ClButton icon onClick={handleClose} variant="ghost" tooltip="Close">
                    <X size={16} />
                </ClButton>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
                <ClField label="Server Name" note={`${name.length}/50`}>
                    <ClInput
                        autoFocus
                        value={name}
                        onChange={e => setName(e.target.value.replace(/[^a-zA-Z0-9 '\-_.]/g, ''))}
                        placeholder="My Awesome Server"
                        maxLength={50}
                    />
                </ClField>

                {error && (
                    <p className="text-sm text-cl-flash bg-cl-flash/10 rounded-xl px-3 py-2">{error}</p>
                )}

                <div className="flex gap-3 pt-2">
                    <ClButton type="button" variant="ghost" fullWidth style={{ flex: 1 }} onClick={handleClose}>Cancel</ClButton>
                    <ClButton type="submit" fullWidth disabled={loading || !name.trim()} loading={loading} style={{ flex: 1 }}>Create Server</ClButton>
                </div>
            </form>
        </ClModal>
    );
};

export default CreateServerModal;
