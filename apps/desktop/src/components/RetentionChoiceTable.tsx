import React from 'react';
import { ClSelect } from './cl';
import {
    type MessageRetention, type AttachmentRetention,
    MESSAGE_RETENTION_LABELS, ATTACHMENT_RETENTION_LABELS,
} from '../hooks/useRetentionPolicy';

/* Shared by the signup wizard's "Your history lives here" step and the
   first-run device storage prompt (DeviceStorageSetupModal), so the two ask
   the same question with the same control. */

const MESSAGE_OPTIONS: MessageRetention[]       = ['never', '1y', '6mo', '3mo', '1mo', '1wk'];
const ATTACHMENT_OPTIONS: AttachmentRetention[] = ['never', '1y', '6mo', '3mo', '1mo', '1wk', '24h'];

export interface RetentionRowData {
    label: string;
    msg: MessageRetention;
    att: AttachmentRetention;
    onMsg: (v: MessageRetention) => void;
    onAtt: (v: AttachmentRetention) => void;
}

/* A compact table: one row per chat type, with the message + file retention
   selects filling their columns (no wasted width, no wrapped labels). One card
   for all three types keeps the step short enough not to overflow the window. */
export const RetentionChoiceTable: React.FC<{ rows: RetentionRowData[] }> = ({ rows }) => {
    const msgOpts = MESSAGE_OPTIONS.map(o => ({ value: o, label: MESSAGE_RETENTION_LABELS[o] }));
    const attOpts = ATTACHMENT_OPTIONS.map(o => ({ value: o, label: ATTACHMENT_RETENTION_LABELS[o] }));
    return (
        <div
            className="rounded-2xl px-4 pt-3 pb-4"
            style={{
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
                display: 'grid', gridTemplateColumns: 'minmax(94px,auto) 1fr 1fr',
                columnGap: 10, rowGap: 11, alignItems: 'center',
            }}
        >
            <span />
            <p className="text-[10px] text-cl-faint uppercase tracking-widest pl-0.5">Messages</p>
            <p className="text-[10px] text-cl-faint uppercase tracking-widest pl-0.5">Files</p>
            {rows.map(r => (
                <React.Fragment key={r.label}>
                    <p className="text-[13px] font-semibold text-cl-text leading-tight pr-1" style={{ fontFamily: 'var(--cl-font-display)' }}>
                        {r.label}
                    </p>
                    <ClSelect style={{ width: '100%' }} ariaLabel={`${r.label}: keep messages for`} value={r.msg} onChange={v => r.onMsg(v as MessageRetention)} options={msgOpts} />
                    <ClSelect style={{ width: '100%' }} ariaLabel={`${r.label}: keep files for`} value={r.att} onChange={v => r.onAtt(v as AttachmentRetention)} options={attOpts} />
                </React.Fragment>
            ))}
        </div>
    );
};

export default RetentionChoiceTable;
