/**
 * Settings, Storage, Move your history: transfer from ANOTHER OF THIS ACCOUNT'S OWN devices (flow F, contract section 7).
 *
 * The host engine has the own-device role (`nearTransferRequest`); the control messages between the two devices travel through the
 * page's E2EE self-fan-out (`utils/nearOwnTransport.ts`). `ownTransferCapable()` is true when the bridge has the request member,
 * which is what shows the Transfer row.
 */
import type { OwnDevicePresenceEntry } from '../hooks/useOwnDevicePresence';
import { platformName, safeLabel } from './nearModel';
import { askedDeviceName } from './ownTransferPicker';
import type { NearSnapshot } from '../types/near';

export interface OwnTransferApi {
    /** `ownDeviceId` = this device; the host never guesses it. Resolves with the new session's snapshot. */
    nearTransferRequest?: (opts: { deviceId: string; ownDeviceId: string }) => Promise<unknown>;
}

/** The picker's "Continue": ask the chosen device for its history. Rejects with the host's message when it cannot start. */
export async function requestOwnTransfer(api: OwnTransferApi | null | undefined, target: { deviceId: string }, ownDeviceId: string | null | undefined): Promise<void> {
    if (typeof api?.nearTransferRequest !== 'function') throw new Error('Local transfer is not available in this build');
    if (!ownDeviceId) throw new Error('This device is not registered yet');
    if (!target.deviceId || target.deviceId === ownDeviceId) throw new Error('Pick another device');
    await api.nearTransferRequest({ deviceId: target.deviceId, ownDeviceId });
}

export function ownTransferCapable(api: OwnTransferApi | undefined | null = typeof window !== 'undefined' ? (window.electronAPI as OwnTransferApi | undefined) : undefined): boolean {
    return typeof api?.nearTransferRequest === 'function';
}

export interface PickRow {
    deviceId: string;
    name: string;
    platform: string;
    /** The server says this device has a live socket for it. */
    online: boolean;
    /** A phone (ios / android). */
    phone: boolean;
    /** Can be picked. A phone is always offered, `online` or not (B3): the phones' sockets carry no `device_id`, so the API's per-device
     *  `connected` is false for every phone for ever, and greying them would make a phone impossible to pick. The row then says to open
     *  Cipherline on it. A desktop that is not connected stays greyed (its socket does carry the id, so `online` is reliable). */
    selectable: boolean;
    /** The row's second line key: online, or "last active {date}". */
    lastActive: string | null;
}

export function isPhonePlatform(p: string | null | undefined): boolean { const v = (p ?? '').toLowerCase(); return v === 'ios' || v === 'android'; }

/** The account's OTHER devices (never this one), pickable first. Seeded presence, not polled. */
export function pickRows(devices: OwnDevicePresenceEntry[], myDeviceId: string | null): PickRow[] {
    return devices
        .filter(d => d.device_id !== myDeviceId)
        .map(d => { const phone = isPhonePlatform(d.platform); return { deviceId: d.device_id, name: safeLabel(d.device_name, platformName(d.platform)), platform: platformName(d.platform), online: d.connected, phone, selectable: d.connected || phone, lastActive: d.last_seen_at || null }; })
        .sort((a, b) => Number(b.selectable) - Number(a.selectable) || Number(b.online) - Number(a.online) || String(b.lastActive).localeCompare(String(a.lastActive)));
}

/** What the holder's sheet calls the asking device: its sanitised name, its platform and the date it was registered
 *  (`created_at`), from the account's device list (security round H2). The server supplied every part, so it is display text only:
 *  nothing here is proof the device is the person's, which is why the sheet is still gated by the account password. Max 64 characters
 *  (the bridge's cap). `undefined` when the device is not in the list: the sheet then says "your other device" and nothing more. */
export function holderLabel(d: { device_name?: string; platform?: string; created_at?: string } | null | undefined): string | undefined {
    if (!d) return undefined;
    const platform = platformName(d.platform);
    const name = Array.from(safeLabel(d.device_name, platform)).slice(0, 24).join('');
    const t = d.created_at ? Date.parse(d.created_at) : NaN;
    const added = Number.isFinite(t) ? `added ${new Date(t).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })}` : '';
    return [name, platform, added].filter(Boolean).join(' \u00b7 ').slice(0, 64);
}

/** The holder sheet reads "Send your history to {name}?" and "{name} ({platform} · added {date}) asked for your history". The host hands the
 *  page one string (`holderLabel`: "name · platform · added date"), so the sheet splits it on the same separator. A label without detail
 *  (the generic "Your other device", or a bare name) has no parenthesis and no invented platform: the old fallback printed "(this computer)"
 *  next to a phone's name (found live, lan-transfer e2e B9). */
export function splitHolderLabel(label: string | null | undefined): { name: string; detail: string } {
    const parts = String(label ?? '').split(' · ').map(x => x.trim()).filter(Boolean);
    if (parts.length === 0) return { name: 'your other device', detail: '' };
    return { name: parts[0], detail: parts.slice(1).join(' · ') };
}

/** `holderLabel` for one device of this account, looked up in `GET /v1/devices`. Never throws (a failed lookup just means no label). */
export async function lookupHolderLabel(fetchList: () => Promise<unknown>, deviceId: string): Promise<string | undefined> {
    try {
        const list = await fetchList();
        const row = Array.isArray(list) ? (list as { device_id?: string }[]).find(x => x && x.device_id === deviceId) : undefined;
        return holderLabel(row as { device_name?: string; platform?: string; created_at?: string } | undefined);
    } catch { return undefined; }
}

/** The other device's name for the transfer screens. The asking device's host only knows it as "Your other device"; the picker
 *  remembered which one it asked (`rememberAskedDevice`), so the wait screen, the banner and the endings name it. Display text only. */
export function ownPeerName(snap: Pick<NearSnapshot, 'role' | 'peer'> | null | undefined, fallback = 'your other device'): string {
    const label = snap?.peer?.label?.trim() ?? '';
    const generic = !label || /^your other device$/i.test(label);
    const asked = askedDeviceName();
    if (generic && snap?.role === 'own_receiver' && asked) return asked;
    return safeLabel(generic ? '' : label, fallback);
}
