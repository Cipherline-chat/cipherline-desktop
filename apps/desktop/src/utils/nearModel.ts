/**
 * Proximity sign-in: the pure model behind the screens. Everything here is a function of a `NearSnapshot`
 * (what the Rust host reports) and plain inputs, so every state can be tested without a DOM or a bridge.
 *
 * Spec: `docs/plans/proximity-signin-ux.md` (flows A, B, C, E, I). The state names are the host's
 * (`types/near.ts`); an UNKNOWN state never throws, it maps to `{ screen: 'unknown' }` and the caller shows
 * its neutral "working" view.
 */
import type { NearAttempt, NearRefusal, NearSnapshot, NearState, NearTransferStatus } from '../types/near';
import { nt, type NearStringKey } from './nearStrings';

// ── Screens ────────────────────────────────────────────────────────────────

/** New-device (A / N side) screens. */
export type NewDeviceScreen =
    | 'preparing'   // A-preparing
    | 'code'        // A-code
    | 'check'       // A-check, A-check-lan
    | 'wait'        // A-wait
    | 'signing'     // A-signing
    | 'refused'     // C-n
    | 'declined'    // A-declined
    | 'burned'      // too many wrong tries on the other device
    | 'lost'        // A-lost
    | 'error'       // A-error
    | 'unknown';

/** Approving-side screens (B, C-a, I). */
export type ApproverScreen =
    | 'idle'
    | 'invite'      // showing this device's own invite code (waiting for a new device)
    | 'check'       // B-check
    | 'approve'     // B-approve (and B-approve-sizing / nolan: see approvalView)
    | 'approving'   // B-bio: gate + sign + grant in flight
    | 'done'        // B-done-xfer / B-done-only
    | 'sending'     // sender-side transfer in progress (banner)
    | 'sent'
    | 'refused'     // C-a
    | 'denied'      // B-denied
    | 'expired'     // B-expired
    | 'burned'      // B-burned
    | 'mismatch'    // the new device's identity key is not the one the server named (review F4): a hard refusal, never a retry prompt
    | 'taken'       // another device took over the scan (server v14): scan again
    | 'lost'        // B-lost
    | 'cancelled'
    | 'error'
    | 'unknown';

const KNOWN_STATES: readonly NearState[] = [
    'idle', 'creating_session', 'showing_code', 'peer_connected', 'negotiating', 'proving_ble', 'proving_lan',
    'proof_verified', 'awaiting_approval', 'approving', 'approved', 'transferring', 'transfer_paused', 'done',
    'refused', 'expired', 'cancelled', 'failed',
];

export function isKnownState(s: unknown): s is NearState {
    return typeof s === 'string' && (KNOWN_STATES as readonly string[]).includes(s);
}

/** Error codes that mean the SERVER burned the session after too many bad proofs. */
const BURNED_CODES = new Set(['link_near_locked', 'link_proximity_locked', 'burned', 'link_locked']);

export function isBurned(snap: Pick<NearSnapshot, 'error'>): boolean {
    return !!snap.error && BURNED_CODES.has(snap.error.code);
}

export function newDeviceScreen(snap: NearSnapshot): NewDeviceScreen {
    if (!isKnownState(snap.state)) return 'unknown';
    switch (snap.state) {
        case 'idle':
        case 'creating_session': return 'preparing';
        case 'showing_code': return 'code';
        case 'peer_connected':
        case 'negotiating':
        case 'proving_ble':
        case 'proving_lan':
        case 'proof_verified': return 'check';
        case 'awaiting_approval':
        case 'approving': return 'wait';
        case 'approved':
        case 'transferring':
        case 'transfer_paused':
        case 'done': return 'signing';
        case 'refused':
            if (isBurned(snap)) return 'burned';
            return snap.error?.code === 'denied' ? 'declined' : 'refused';
        case 'expired':
        case 'cancelled': return 'lost';
        case 'failed':
            if (isBurned(snap)) return 'burned';
            // A failure before any session exists is "couldn't get a code"; later it is "lost touch".
            return snap.linkId ? 'lost' : 'error';
    }
}

export function approverScreen(snap: NearSnapshot): ApproverScreen {
    if (!isKnownState(snap.state)) return 'unknown';
    switch (snap.state) {
        case 'idle': return 'idle';
        case 'creating_session':
        case 'peer_connected':
        case 'negotiating':
        case 'proving_ble':
        case 'proving_lan': return 'check';
        case 'showing_code': return 'invite';
        case 'proof_verified':
        case 'awaiting_approval': return 'approve';
        case 'approving': return 'approving';
        case 'approved': return 'done';
        case 'transferring':
        case 'transfer_paused': return 'sending';
        case 'done': return 'sent';
        case 'refused':
            if (isBurned(snap)) return 'burned';
            return snap.error?.code === 'denied' ? 'denied' : 'refused';
        case 'expired': return 'expired';
        case 'cancelled': return 'cancelled';
        case 'failed':
            if (isBurned(snap)) return 'burned';
            if (snap.error?.code === 'identity_mismatch') return 'mismatch';
            if (snap.error?.code === 'taken_over') return 'taken';
            return snap.error?.code === 'session_expired' ? 'expired' : (snap.error?.code === 'hello_timeout' ? 'lost' : 'error');
    }
}

// ── Typed code ─────────────────────────────────────────────────────────────

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]$/;

/** Uppercase, strip separators, fold Crockford aliases (O to 0, I and L to 1), drop anything else, cap at 8. */
export function normalizeTyped(input: string): string {
    let out = '';
    for (const raw of input.toUpperCase()) {
        if (/[\s\-\u00b7\u2010-\u2015\u2022.:_\u200a]/.test(raw)) continue;
        const c = raw === 'O' ? '0' : raw === 'I' || raw === 'L' ? '1' : raw;
        if (CROCKFORD.test(c)) out += c;
        if (out.length >= 8) break;
    }
    return out;
}

/** `K7QM42F8` to the contract's `K7QM-42F8` (the bridge takes this form). */
export function typedForBridge(normalized: string): string {
    const n = normalizeTyped(normalized);
    return n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
}

/** `K7QM-42F8` to the on-screen `K7QM·42F8` (display only). */
export function typedForDisplay(code: string): string {
    const n = normalizeTyped(code);
    return n.length === 8 ? `${n.slice(0, 4)}\u00b7${n.slice(4)}` : n;
}

/** `K 7 Q M, 4 2 F 8` for the spoken label. */
export function typedSpelled(code: string): string {
    const n = normalizeTyped(code);
    const sp = (s: string) => s.split('').join(' ');
    return n.length === 8 ? `${sp(n.slice(0, 4))}, ${sp(n.slice(4))}` : sp(n);
}

// ── Devices ────────────────────────────────────────────────────────────────

export function platformName(p: string | null | undefined): string {
    switch ((p ?? '').toLowerCase()) {
        case 'ios': return 'iPhone';
        case 'android': return 'Android phone';
        case 'mac':
        case 'macos': return 'Mac';
        case 'windows': return 'Windows PC';
        case 'linux': return 'Linux PC';
        default: return 'Device';
    }
}

export function isDesktopPlatform(p: string | null | undefined): boolean {
    return ['windows', 'mac', 'macos', 'linux'].includes((p ?? '').toLowerCase());
}

/** Icon family for a peer: phones get Smartphone, computers Laptop. */
export function peerIsPhone(snap: Pick<NearSnapshot, 'peer'>): boolean {
    const p = (snap.peer?.platform ?? '').toLowerCase();
    return p === 'ios' || p === 'android';
}

/** A device label is untrusted display text: bound its length and strip control characters. */
export function safeLabel(label: string | null | undefined, fallback = 'Your other device'): string {
    // eslint-disable-next-line no-control-regex -- stripping control characters from an untrusted device label is the point
    // Control characters, every bidi override / isolate / mark and the zero-width characters (so a name cannot reorder or hide text
    // around it). The same set as the phone's `near::clean_label`; the length is counted in code points, like the phone.
    const s = Array.from((label ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '').trim()).slice(0, 64).join('');
    return s || fallback;
}

// ── Proximity rows ─────────────────────────────────────────────────────────

export type CheckStatus = 'on' | 'ok' | 'no' | 'wait' | 'skip';
export interface CheckRow { k: 'ble' | 'lan'; st: CheckStatus; sub: string }

export interface CheckCtx {
    /** "this computer" in the sentences. */
    thisDevice: string;
    /** The other device's name, for "Looking for {device} nearby…". */
    device: string;
}

type BleDetail = 'off' | 'denied' | 'no_adapter' | null;

function bleDetail(snap: NearSnapshot): BleDetail {
    const r = snap.refusal?.ble;
    if (r === 'off' || r === 'denied' || r === 'no_adapter') return r;
    const reason = snap.ble?.reason;
    if (reason === 'radio_off' || reason === 'off') return 'off';
    if (reason === 'denied') return 'denied';
    if (reason === 'no_adapter' || reason === 'unsupported') return 'no_adapter';
    return null;
}

/** The two rows of `ProximityCheck`, from the snapshot alone. */
export function checkRows(snap: NearSnapshot, ctx: CheckCtx): CheckRow[] {
    const a: NearAttempt | undefined = snap.attempt;
    // The approving device narrates which proof it is trying and which held (contract 11.17, `peerStatus`): informational,
    // it only ever changes what these rows SAY on the new device.
    const ps = snap.peerStatus;
    const peerProved: NearSnapshot['proximity'] = ps?.stage === 'proof_ok' ? ps.proximity : undefined;
    const bleOnly = isDesktopPlatform(snap.peer?.platform) && !peerIsPhone(snap);
    const ble: CheckRow = { k: 'ble', st: 'wait', sub: nt('ck.lan.waiting') };
    const lan: CheckRow = { k: 'lan', st: 'wait', sub: nt('ck.lan.waiting') };

    // Bluetooth row
    if (bleOnly) {
        ble.st = 'skip'; ble.sub = nt('ck.ble.na');
    } else if (snap.proximity === 'ble' || peerProved === 'ble') {
        ble.st = 'ok'; ble.sub = nt('ck.ble.ok');
    } else if (a?.proof === 'ble' || snap.ble?.status === 'scanning' || ps?.stage === 'checking_ble') {
        ble.st = 'on'; ble.sub = nt('ck.ble.trying', { device: ctx.device });
    } else if (a?.proof === 'lan' || snap.ble?.status === 'fell_through' || snap.state === 'refused' || snap.proximity === 'lan' || peerProved === 'lan' || ps?.stage === 'checking_lan') {
        const d = bleDetail(snap);
        ble.st = d ? 'no' : 'no';
        ble.sub = d === 'off' ? nt('ck.ble.off', { thisDevice: ctx.thisDevice })
            : d === 'denied' ? nt('ck.ble.denied')
            : d === 'no_adapter' ? nt('ck.ble.noadapter')
            : nt('ck.ble.none');
        if (snap.refusal?.ble === 'skipped') { ble.st = 'skip'; ble.sub = nt('ck.ble.na'); }
    } else if (snap.state === 'peer_connected' || snap.state === 'negotiating') {
        ble.st = 'on'; ble.sub = nt('ck.ble.trying', { device: ctx.device });
    } else {
        ble.sub = nt('ck.ble.trying', { device: ctx.device });
    }

    // Wi-Fi row
    if (snap.proximity === 'lan' || peerProved === 'lan') {
        lan.st = 'ok'; lan.sub = nt('ck.lan.ok');
    } else if (a?.proof === 'lan' || ps?.stage === 'checking_lan') {
        lan.st = 'on'; lan.sub = nt('ck.lan.trying', { device: ctx.device });
    } else if (snap.state === 'refused') {
        lan.st = snap.refusal?.lan === 'skipped' ? 'skip' : 'no';
        lan.sub = snap.refusal?.lan === 'denied' ? nt('ck.lan.denied')
            : snap.refusal?.lan === 'firewall' ? nt('ck.lan.firewall')
            : nt('ck.lan.none');
    } else if (snap.proximity === 'ble' && snap.transferOfferable === undefined && a?.hint === 'probing_for_transfer') {
        lan.st = 'on'; lan.sub = nt('ck.lan.trying', { device: ctx.device });
    }
    return [ble, lan];
}

export function checkStatusKey(st: CheckStatus): NearStringKey {
    return st === 'on' ? 'ck.st.trying' : st === 'ok' ? 'ck.st.ok' : st === 'no' ? 'ck.st.no' : st === 'wait' ? 'ck.st.wait' : 'ck.st.skip';
}

export type NearHint =
    | { key: 'hint.closer' | 'hint.bt.off.d' | 'hint.win.fw' | 'hint.lan.same'; vars?: Record<string, string> }
    | null;

export const CLOSER_HINT_MS = 6000;

/** The one hint to show under the rows, if any. `elapsedMs` = time since the check began. */
export function checkHint(snap: NearSnapshot, elapsedMs: number, opts: { thisIsWindows: boolean; device: string }): NearHint {
    const a = snap.attempt;
    if (bleDetail(snap) === 'off') return { key: 'hint.bt.off.d' };
    if (a?.proof === 'lan' && a.hint === 'listening' && opts.thisIsWindows && isDesktopPlatform(snap.peer?.platform)) return { key: 'hint.win.fw' };
    if (a?.proof === 'lan' && snap.state !== 'refused') return { key: 'hint.lan.same' };
    if ((a?.proof === 'ble' || snap.ble?.status === 'scanning') && elapsedMs >= CLOSER_HINT_MS && snap.proximity !== 'ble') {
        return { key: 'hint.closer', vars: { device: opts.device } };
    }
    return null;
}

// ── Refusal ────────────────────────────────────────────────────────────────

function lowerFirst(s: string): string {
    if (/^(Bluetooth|Cipherline|Wi\u2011Fi|PC)\b/.test(s)) return s;
    return s.charAt(0).toLowerCase() + s.slice(1);
}

/** `c.tried`: what each proof said, from the per-proof causes. */
export function triedLine(refusal: NearRefusal | undefined, ctx: { thisDevice: string; bleNa: boolean }): string {
    const r: NearRefusal = refusal ?? { ble: 'skipped', lan: 'skipped' };
    const ble = ctx.bleNa || r.ble === 'skipped' ? nt('ck.ble.na')
        : r.ble === 'off' ? nt('ck.ble.off', { thisDevice: ctx.thisDevice })
        : r.ble === 'denied' ? nt('ck.ble.denied')
        : r.ble === 'no_adapter' ? nt('ck.ble.noadapter')
        : nt('ck.ble.none');
    const lan = r.lan === 'denied' ? nt('ck.lan.denied')
        : r.lan === 'firewall' ? nt('ck.lan.firewall')
        : nt('ck.lan.none');
    return nt('c.tried', { ble: lowerFirst(ble), lan: lowerFirst(lan) });
}

/** Both proofs denied by the OS (C-n-perm variant): not "not found", but "not allowed". A radio that is merely off, or a firewall, is not a permission. */
export function bothBlocked(refusal: NearRefusal | undefined): boolean {
    return !!refusal && refusal.ble === 'denied' && refusal.lan === 'denied';
}

// ── Approval view ──────────────────────────────────────────────────────────

export interface ApprovalView {
    /** Which proof line to show. */
    proof: 'ble' | 'lan';
    /** Sizing the history / probing a Wi-Fi path: Approve-and-transfer shows loading, Deny works. */
    sizing: boolean;
    /** True once we know a transfer is possible (Wi-Fi path exists). */
    canTransfer: boolean;
    /** Known, and no Wi-Fi path: only plain Approve is offered. */
    /** Known, and no Wi‑Fi path: only plain Approve is offered. */
    noLan: boolean;
    /** F3: the proof was the local network only. Approve only, no history sizing, and the note points to Settings. */
    lanOnly: boolean;
}

/** F3: a local-network-only proof never offers the history at approval time. The host's `historyAllowed` is the authority; a snapshot that
 *  predates it (or a LAN proof) reads as approve-only. */
export function isLanOnly(snap: Pick<NearSnapshot, 'proximity' | 'historyAllowed'>): boolean {
    return snap.historyAllowed === false || (snap.historyAllowed === undefined && snap.proximity === 'lan');
}

export function approvalView(snap: NearSnapshot, historySized: boolean): ApprovalView {
    const proof = snap.proximity === 'lan' ? 'lan' : 'ble';
    const lanOnly = isLanOnly(snap);
    // After a LAN proof there is no history at approval (F3); after BLE the host probes AFTER the sheet is up (`transferOfferable`), so the
    // button for the transfer is disabled until it flips and "Approve only" is always enabled.
    const known = lanOnly ? true : snap.transferOfferable !== undefined;
    const canTransfer = lanOnly ? false : snap.transferOfferable === true;
    return {
        proof,
        sizing: lanOnly ? false : (!historySized || !known),
        canTransfer,
        noLan: !lanOnly && known && !canTransfer,
        lanOnly,
    };
}

// ── Sizes, time, progress ──────────────────────────────────────────────────

export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '0 B';
    if (n < 1000) return `${Math.round(n)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1000;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    const digits = v >= 100 ? 0 : v >= 10 ? 1 : 1;
    return `${v.toFixed(digits).replace(/\.0$/, '')} ${units[i]}`;
}

export function formatCount(n: number): string {
    return Math.max(0, Math.round(n)).toLocaleString('en-US');
}

export function percent(t: Pick<NearTransferStatus, 'bytesDone' | 'bytesTotal'>): number {
    if (!t.bytesTotal || t.bytesTotal <= 0) return 0;
    return Math.max(0, Math.min(100, Math.floor((t.bytesDone / t.bytesTotal) * 100)));
}

/** "about 4 min left", never seconds. */
export function formatEta(remainingMs: number): string {
    const min = Math.max(1, Math.ceil(remainingMs / 60_000));
    if (min < 60) return `about ${min} min left`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `about ${h} h left` : `about ${h} h ${m} min left`;
}

/**
 * ETA shown only after at least 10 s of steady throughput AND at least 5 % received (spec section 2); otherwise
 * the caller shows bytes only. Pure: feed it samples, read `eta()`.
 */
export class EtaTracker {
    private samples: { t: number; b: number }[] = [];
    private startedAt: number | null = null;

    reset(): void { this.samples = []; this.startedAt = null; }

    push(nowMs: number, bytesDone: number): void {
        if (this.startedAt === null) this.startedAt = nowMs;
        this.samples.push({ t: nowMs, b: bytesDone });
        // Keep a 30 s window.
        while (this.samples.length > 2 && nowMs - this.samples[0].t > 30_000) this.samples.shift();
    }

    eta(nowMs: number, bytesDone: number, bytesTotal: number): string | null {
        if (this.startedAt === null || bytesTotal <= 0) return null;
        if (nowMs - this.startedAt < 10_000) return null;
        if (bytesDone / bytesTotal < 0.05) return null;
        const first = this.samples[0];
        const last = this.samples[this.samples.length - 1];
        const dt = last.t - first.t;
        const db = last.b - first.b;
        if (dt < 5_000 || db <= 0) return null;
        const rate = db / dt; // bytes per ms
        return formatEta((bytesTotal - bytesDone) / rate);
    }
}

export type TransferPhase = 'moving' | 'interrupted' | 'paused' | 'applying' | 'done';

export function transferPhase(snap: NearSnapshot): TransferPhase | null {
    const t = snap.transfer;
    if (snap.state === 'done') return 'done';
    if (!t && snap.state !== 'transferring' && snap.state !== 'transfer_paused') return null;
    if (t?.paused) return 'paused';
    if (snap.state === 'transfer_paused' || t?.interrupted) return 'interrupted';
    return 'moving';
}

export function isTransferActive(snap: NearSnapshot): boolean {
    return snap.state === 'transferring' || snap.state === 'transfer_paused';
}
