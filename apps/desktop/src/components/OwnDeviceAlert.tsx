import React, { useState } from 'react';
import { AlertTriangle, Laptop, X } from 'lucide-react';
import { ClButton } from './ClButton';
import type { OwnDeviceAlert as Alert } from '../utils/ownDeviceLedger';

/**
 * The own-device alarm: the Dashboard half of the ghost-device fix
 * (docs/ghost-device.md §2.5).
 *
 * A device on your account that you never confirmed receives every message
 * you send and receive. Nothing else in the app tells you it exists, so this
 * banner stays until each device is answered. "Later" hides it for this
 * session only, never durably.
 *
 * Every new device gets its own row. When the server adds a ghost at the
 * moment you add a real device, you see TWO rows, and that is the whole point.
 */

export interface OwnDeviceName { device_name?: string; platform?: string; created_at?: string }

interface Props {
    alerts: Alert[];
    selfKeyMismatch: boolean;
    unreviewedBaseline: string[];
    names: Record<string, OwnDeviceName>;
    onConfirm: (deviceId: string, pub: string) => void;
    onReject: (deviceId: string, pub: string) => void;
    onReviewed: () => void;
    onManage: () => void;
}

function label(id: string, names: Record<string, OwnDeviceName>): string {
    const n = names[id];
    if (n?.device_name) return n.platform ? `${n.device_name} (${n.platform})` : n.device_name;
    return `Device •••${id.replace(/-/g, '').slice(-4)}`;
}

function ago(ms: number): string {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return 'just now';
    const m = Math.round(s / 60);
    if (m < 90) return `${m} minutes ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} hours ago`;
    return `${Math.round(h / 24)} days ago`;
}

export const OwnDeviceAlert: React.FC<Props> = ({
    alerts, selfKeyMismatch, unreviewedBaseline, names, onConfirm, onReject, onReviewed, onManage,
}) => {
    const [hidden, setHidden] = useState(false);
    const danger = alerts.length > 0 || selfKeyMismatch;
    if (hidden || (!danger && unreviewedBaseline.length === 0)) return null;

    if (!danger) {
        return (
            <div
                className="w-full px-4 py-2.5 border-b text-sm flex flex-col gap-2"
                style={{ background: 'rgba(120,170,255,0.08)', borderColor: 'rgba(120,170,255,0.25)' }}
                role="status"
                data-testid="own-device-review"
            >
                <div className="flex items-start gap-2">
                    <Laptop size={15} className="shrink-0 mt-0.5" />
                    <span>
                        Cipherline now alerts you when a device is added to your account. These are the{' '}
                        {unreviewedBaseline.length + 1} devices on it today: this device,{' '}
                        {unreviewedBaseline.map(id => label(id, names)).join(', ')}. If one isn't yours, remove it
                        and change your password.
                    </span>
                </div>
                <div className="flex items-center gap-2 justify-end">
                    <ClButton size="sm" variant="ghost" onClick={onManage}>Manage devices</ClButton>
                    <ClButton size="sm" onClick={onReviewed}>Looks right</ClButton>
                </div>
            </div>
        );
    }

    return (
        <div
            className="w-full px-4 py-2.5 border-b text-sm flex flex-col gap-2"
            style={{ background: 'var(--cl-flash-tint)', borderColor: 'var(--cl-flash)', color: 'var(--cl-flash)' }}
            role="alert"
            data-testid="own-device-alert"
        >
            {selfKeyMismatch && (
                <div className="flex items-start gap-2">
                    <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                    <span>
                        <strong>The server is publishing a key for this device that this device does not hold.</strong>{' '}
                        Messages sent to that key are not reaching this device, and could be read by whoever holds it.
                        Don't share your verification code or send anything sensitive until this is resolved.
                    </span>
                </div>
            )}
            {alerts.length > 0 && (
                <div className="flex items-start gap-2">
                    <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                    <span>
                        <strong>
                            {alerts.length === 1
                                ? 'A device on your account needs your attention.'
                                : `${alerts.length} devices on your account need your attention.`}
                        </strong>{' '}
                        A device receives every message you send and receive. If one isn't yours, remove it and change
                        your password.
                    </span>
                </div>
            )}
            {alerts.map(a => (
                <div key={a.device_id} className="flex items-center justify-between gap-3 pl-6" data-testid="own-device-alert-row">
                    <span className="min-w-0 truncate">
                        <strong>{label(a.device_id, names)}</strong>
                        {' · '}
                        {a.kind === 'key_changed'
                            ? 'now presents a different key'
                            : a.kind === 'rejected_still_listed'
                                ? 'you said this is not yours, and it is still on your account'
                                : `added ${ago(a.first_seen)}`}
                        {a.gone && ' (no longer listed)'}
                    </span>
                    <span className="flex gap-2 shrink-0">
                        <ClButton size="sm" variant="danger" onClick={() => onReject(a.device_id, a.pub)}>
                            Not me — remove it
                        </ClButton>
                        {a.kind !== 'rejected_still_listed' && (
                            <ClButton size="sm" variant="ghost" onClick={() => onConfirm(a.device_id, a.pub)}>
                                This was me
                            </ClButton>
                        )}
                    </span>
                </div>
            ))}
            <div className="flex justify-end">
                <ClButton size="sm" variant="ghost" icon tooltip="Hide until next launch" onClick={() => setHidden(true)}>
                    <X size={13} />
                </ClButton>
            </div>
        </div>
    );
};
