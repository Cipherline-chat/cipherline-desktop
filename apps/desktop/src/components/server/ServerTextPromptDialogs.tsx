import React, { useId, useState } from 'react';
import { PhoneCall, UserPen } from 'lucide-react';
import { ClModal, ClButton, ClInput } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../dialog/DialogFrame';
import { DialogForm, DialogField } from '../dialog/DialogExtras';
import { cleanCallName } from '../../utils/callName';

/**
 * Two small one-field prompts from the server panel, in the house dialog
 * pattern (components/dialog/DialogFrame): rename a call, set a nickname.
 * Presentation only; the caller owns the draft and the request.
 */

export const RenameCallDialog: React.FC<{
    open: boolean;
    draft: string;
    onDraftChange: (v: string) => void;
    onSubmit: () => void;
    onClose: () => void;
}> = ({ open, draft, onDraftChange, onSubmit, onClose }) => {
    const id = useId();
    const canSubmit = cleanCallName(draft).length > 0;
    return (
        <ClModal open={open} onClose={onClose} width={400} label="Rename call" cardClassName="dlg-card">
            <DialogHeader
                icon={<PhoneCall size={18} strokeWidth={2.2} />}
                title="Rename call"
                subtitle="Everyone in the call sees the new name."
            />
            <DialogForm onSubmit={() => { if (canSubmit) onSubmit(); }}>
                <DialogBody>
                    <DialogField label="Call name" htmlFor={id} aside={`${draft.length}/60`}>
                        <ClInput
                            id={id}
                            value={draft}
                            onChange={e => onDraftChange(e.target.value)}
                            maxLength={60}
                            placeholder="Call name"
                            autoComplete="off"
                            autoFocus
                        />
                    </DialogField>
                </DialogBody>
                <DialogFooter hint="Letters, numbers, spaces and . - _ '">
                    <ClButton type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</ClButton>
                    <ClButton type="submit" size="sm" disabled={!canSubmit}>Rename</ClButton>
                </DialogFooter>
            </DialogForm>
        </ClModal>
    );
};

export const NicknameDialog: React.FC<{
    open: boolean;
    /** True when editing your own nickname. */
    isSelf: boolean;
    displayName: string;
    value: string;
    onChange: (v: string) => void;
    error?: string | null;
    saving?: boolean;
    onSubmit: () => void;
    onClose: () => void;
    overlayStyle?: React.CSSProperties;
}> = ({ open, isSelf, displayName, value, onChange, error, saving = false, onSubmit, onClose, overlayStyle }) => {
    const id = useId();
    // The subtitle keeps naming the person through the exit animation (the caller
    // clears its target the moment the dialog closes).
    const [shown, setShown] = useState({ isSelf, displayName });
    if (open && (shown.isSelf !== isSelf || shown.displayName !== displayName)) setShown({ isSelf, displayName });
    return (
        <ClModal open={open} onClose={onClose} width={400} overlayStyle={overlayStyle} label="Change nickname" cardClassName="dlg-card">
            <DialogHeader
                icon={<UserPen size={18} strokeWidth={2.2} />}
                title="Change nickname"
                subtitle={shown.isSelf ? 'Your nickname in this server' : `Nickname for ${shown.displayName}`}
            />
            <DialogForm onSubmit={() => { if (!saving) onSubmit(); }}>
                <DialogBody>
                    <DialogField
                        label="Nickname"
                        htmlFor={id}
                        aside={`${value.length}/32`}
                        help="Leave blank to reset to the account username"
                    >
                        <ClInput
                            id={id}
                            autoFocus
                            autoComplete="off"
                            value={value}
                            onChange={e => onChange(e.target.value)}
                            maxLength={32}
                            placeholder="Leave blank to reset to username"
                            disabled={saving}
                        />
                    </DialogField>
                </DialogBody>
                {error && <DialogError>{error}</DialogError>}
                <DialogFooter>
                    <ClButton type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</ClButton>
                    <ClButton type="submit" size="sm" loading={saving} disabled={saving}>Save</ClButton>
                </DialogFooter>
            </DialogForm>
        </ClModal>
    );
};
