import React, { useState } from 'react';
import { HardDrive, Info, AlertTriangle } from 'lucide-react';
import { ClButton, ClModal } from './cl';
import { RetentionChoiceTable } from './RetentionChoiceTable';
import type { MessageRetention, AttachmentRetention } from '../hooks/useRetentionPolicy';
import { RECOMMENDED_RETENTION, type DeviceRetentionChoice, type SetupHow } from '../utils/deviceStorageSetup';

interface Props {
    open: boolean;
    /** Persist the choice. May throw (locked / unavailable store) — the modal
     *  stays open and shows the error. */
    onSave: (choice: DeviceRetentionChoice, how: SetupHow) => void | Promise<void>;
}

/**
 * First-run "storage on this device" prompt. Shown by Dashboard when the
 * signed-in account has never chosen a retention on this device — after a
 * password sign-in on a new machine, after a restore or history transfer, and
 * (for free) after any future sign-in path. Never after signup: the wizard
 * already asked. See utils/deviceStorageSetup.ts.
 *
 * Not dismissable by Escape / overlay: until it is answered the retention
 * sweeper is held (Dashboard), so closing it without a choice would leave the
 * device in limbo. Both answers are one click away.
 */
export const DeviceStorageSetupModal: React.FC<Props> = ({ open, onSave }) => {
    const [dmMsg,  setDmMsg]  = useState<MessageRetention>(RECOMMENDED_RETENTION.dmMessageRetention);
    const [dmAtt,  setDmAtt]  = useState<AttachmentRetention>(RECOMMENDED_RETENTION.dmAttachmentRetention);
    const [grpMsg, setGrpMsg] = useState<MessageRetention>(RECOMMENDED_RETENTION.groupMessageRetention);
    const [grpAtt, setGrpAtt] = useState<AttachmentRetention>(RECOMMENDED_RETENTION.groupAttachmentRetention);
    const [srvMsg, setSrvMsg] = useState<MessageRetention>(RECOMMENDED_RETENTION.serverMessageRetention);
    const [srvAtt, setSrvAtt] = useState<AttachmentRetention>(RECOMMENDED_RETENTION.serverAttachmentRetention);
    const [saving, setSaving] = useState<SetupHow | null>(null);
    const [error, setError] = useState('');

    const submit = async (how: SetupHow) => {
        if (saving) return;
        setError('');
        setSaving(how);
        const choice: DeviceRetentionChoice = how === 'recommended' ? { ...RECOMMENDED_RETENTION } : {
            dmMessageRetention: dmMsg,     dmAttachmentRetention: dmAtt,
            groupMessageRetention: grpMsg, groupAttachmentRetention: grpAtt,
            serverMessageRetention: srvMsg, serverAttachmentRetention: srvAtt,
        };
        try {
            await onSave(choice, how);
        } catch (e) {
            setError(e instanceof Error && e.message ? e.message : 'Couldn’t save your storage settings. Try again.');
        } finally {
            setSaving(null);
        }
    };

    return (
        <ClModal
            open={open}
            onClose={() => { /* must be answered — see component doc */ }}
            closeOnOverlay={false}
            width={520}
            cardClassName="mcard--scroll"
            cardStyle={{ padding: '28px' }}
            label="Set up storage on this device"
        >
            <form
                onSubmit={e => { e.preventDefault(); void submit('chosen'); }}
                style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
                data-testid="device-storage-setup"
            >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                    <div style={{
                        width: 48, height: 48, borderRadius: 14, flexShrink: 0,
                        background: 'rgba(37,224,200,.1)', border: '1px solid rgba(37,224,200,.2)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <HardDrive size={22} style={{ color: 'var(--cl-lume)' }} aria-hidden />
                    </div>
                    <div>
                        <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: 'var(--cl-text)', fontFamily: 'var(--cl-font-display)' }}>
                            Set up storage on this device
                        </h2>
                        <p style={{ margin: 0, fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.5 }}>
                            Your messages live on your devices, never on our servers. Choose how long
                            <strong style={{ color: 'var(--cl-text)', fontWeight: 600 }}> this device </strong>
                            keeps them.
                        </p>
                    </div>
                </div>

                <RetentionChoiceTable rows={[
                    { label: 'Direct messages', msg: dmMsg,  att: dmAtt,  onMsg: setDmMsg,  onAtt: setDmAtt },
                    { label: 'Group chats',     msg: grpMsg, att: grpAtt, onMsg: setGrpMsg, onAtt: setGrpAtt },
                    { label: 'Servers',         msg: srvMsg, att: srvAtt, onMsg: setSrvMsg, onAtt: setSrvAtt },
                ]} />

                <div className="flex items-start gap-2 px-1">
                    <Info size={13} className="text-cl-faint mt-0.5 shrink-0" aria-hidden />
                    <p className="text-xs text-cl-faint leading-relaxed" style={{ margin: 0 }}>
                        These settings apply to this device only. They don’t sync to your other devices
                        and aren’t included in backups, so each device can keep as much or as little as you like.
                        You can change them any time in Settings → Storage.
                    </p>
                </div>

                {error && (
                    <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-xl"
                        style={{ background: 'rgba(255,107,107,.08)', border: '1px solid rgba(255,107,107,.25)' }}>
                        <AlertTriangle size={14} style={{ color: 'var(--cl-glow)', marginTop: 1, flexShrink: 0 }} aria-hidden />
                        <p className="text-xs leading-relaxed" style={{ margin: 0, color: 'var(--cl-text)' }}>{error}</p>
                    </div>
                )}

                <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                    <ClButton
                        type="button"
                        fullWidth
                        variant="ghost"
                        style={{ flex: 1 }}
                        disabled={!!saving}
                        loading={saving === 'recommended'}
                        onClick={() => void submit('recommended')}
                    >
                        Use recommended
                    </ClButton>
                    <ClButton
                        type="submit"
                        fullWidth
                        style={{ flex: 1 }}
                        disabled={!!saving}
                        loading={saving === 'chosen'}
                    >
                        {saving === 'chosen' ? 'Saving…' : 'Save'}
                    </ClButton>
                </div>
            </form>
        </ClModal>
    );
};

export default DeviceStorageSetupModal;
