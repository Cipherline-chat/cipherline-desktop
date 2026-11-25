import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Laptop } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClBanner } from './ClBanner';
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

/**
 * Where a "Not me — remove it" stands. `removed` is set only once a fresh
 * complete listing no longer shows the device, never on the revoke's 200 alone,
 * so "signed out and removed" is never claimed for a device the server still
 * lists. `name` is captured at click time: the device drops out of
 * GET /devices once revoked, so the label would otherwise fall back to an id.
 */
export interface OwnDeviceRemoval { state: 'removing' | 'removed' | 'failed'; name?: OwnDeviceName }

interface Props {
    alerts: Alert[];
    selfKeyMismatch: boolean;
    unreviewedBaseline: string[];
    names: Record<string, OwnDeviceName>;
    onConfirm: (deviceId: string, pub: string) => void;
    onReject: (deviceId: string, pub: string) => void;
    onReviewed: () => void;
    onManage: () => void;
    removals?: Record<string, OwnDeviceRemoval>;
    /** Clears the "signed out and removed" confirmation. */
    onRemovedDone?: () => void;
}

const NO_REMOVALS: Record<string, OwnDeviceRemoval> = {};

function label(id: string, names: Record<string, OwnDeviceName>, removals: Record<string, OwnDeviceRemoval> = NO_REMOVALS): string {
    const n = names[id] ?? removals[id]?.name;
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
    removals = NO_REMOVALS, onRemovedDone,
}) => {
    const [hidden, setHidden] = useState(false);
    const danger = alerts.length > 0 || selfKeyMismatch;
    const alertIds = new Set(alerts.map(a => a.device_id));
    const removedIds = Object.keys(removals).filter(id => removals[id].state === 'removed' && !alertIds.has(id));
    const removedText = removedIds.length === 1
        ? `${label(removedIds[0], names, removals)} was signed out and removed.`
        : `${removedIds.length} devices were signed out and removed.`;

    // The confirmation for a removal must show even if "Hide until next launch"
    // was used on the alarm earlier: it is the answer to the click just made.
    if (!danger && removedIds.length > 0) {
        return (
            <ClBanner
                id="own-device-removed"
                tone="success"
                priority={90}
                testId="own-device-removed"
                icon={<CheckCircle2 size={15} />}
                title={removedText}
                description={removedIds.length === 1
                    ? "It can no longer read your messages. If you didn't add it, change your password."
                    : "They can no longer read your messages. If you didn't add them, change your password."}
                actions={[
                    { key: 'manage', label: 'Manage devices', variant: 'ghost', onClick: onManage },
                    { key: 'done', label: 'Done', variant: 'primary', onClick: onRemovedDone },
                ]}
                onDismiss={onRemovedDone}
            />
        );
    }

    if (hidden || (!danger && unreviewedBaseline.length === 0)) return null;

    if (!danger) {
        return (
            <ClBanner
                id="own-device-review"
                tone="info"
                priority={45}
                testId="own-device-review"
                icon={<Laptop size={15} />}
                title="Cipherline now alerts you when a device is added to your account."
                description={<>
                    These are the {unreviewedBaseline.length + 1} devices on it today: this device,{' '}
                    {unreviewedBaseline.map(id => label(id, names, removals)).join(', ')}. If one isn't yours, remove it
                    and change your password.
                </>}
                actions={[
                    { key: 'manage', label: 'Manage devices', variant: 'ghost', onClick: onManage },
                    { key: 'reviewed', label: 'Looks right', variant: 'primary', onClick: onReviewed },
                ]}
            />
        );
    }

    const alertsHead = alerts.length === 1
        ? 'A device on your account needs your attention.'
        : `${alerts.length} devices on your account need your attention.`;
    const alertsBody = "A device receives every message you send and receive. If one isn't yours, remove it and change your password.";

    return (
        <ClBanner
            id="own-device-alert"
            tone="danger"
            priority={100}
            testId="own-device-alert"
            icon={<AlertTriangle size={15} />}
            title={selfKeyMismatch ? 'The server is publishing a key for this device that this device does not hold.' : alertsHead}
            description={selfKeyMismatch
                ? "Messages sent to that key are not reaching this device, and could be read by whoever holds it. Don't share your verification code or send anything sensitive until this is resolved."
                : alertsBody}
            dismissLabel="Hide until next launch"
            onDismiss={() => setHidden(true)}
        >
            {selfKeyMismatch && alerts.length > 0 && (
                <p className="m-0 mb-2">
                    <strong className="text-cl-text">{alertsHead}</strong> {alertsBody}
                </p>
            )}
            {alerts.map(a => {
                const removal = removals[a.device_id]?.state;
                return (
                <div key={a.device_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-1" data-testid="own-device-alert-row">
                    <span className="min-w-0">
                        <strong className="text-cl-text">{label(a.device_id, names, removals)}</strong>
                        {' · '}
                        {removal === 'removing'
                            ? 'signing it out…'
                            : removal === 'failed'
                            ? "couldn't remove it. Check your connection and try again."
                            : a.kind === 'key_changed'
                            ? 'now presents a different key'
                            : a.kind === 'rejected_still_listed'
                                ? 'you said this is not yours, and it is still on your account'
                                : `added ${ago(a.first_seen)}`}
                        {a.gone && ' (no longer listed)'}
                    </span>
                    <span className="flex gap-2 shrink-0">
                        <ClButton size="sm" variant="danger" loading={removal === 'removing'} onClick={() => onReject(a.device_id, a.pub)}>
                            {removal === 'failed' ? 'Try again' : 'Not me — remove it'}
                        </ClButton>
                        {a.kind !== 'rejected_still_listed' && removal === undefined && (
                            <ClButton size="sm" variant="ghost" onClick={() => onConfirm(a.device_id, a.pub)}>
                                This was me
                            </ClButton>
                        )}
                    </span>
                </div>
                );
            })}
            {removedIds.map(id => (
                <div key={id} className="flex items-center gap-2 py-1" data-testid="own-device-removed-row">
                    <CheckCircle2 size={14} className="text-cl-ok shrink-0" aria-hidden />
                    <span className="min-w-0">
                        <strong className="text-cl-text">{label(id, names, removals)}</strong> · signed out and removed
                    </span>
                </div>
            ))}
        </ClBanner>
    );
};
