import { describe, it, expect } from 'vitest';
import type { NearSnapshot, NearState } from '../types/near';
import {
    EtaTracker, approvalView, approverScreen, bothBlocked, checkHint, checkRows, formatBytes, formatEta, isKnownState, newDeviceScreen,
    normalizeTyped, percent, safeLabel, transferPhase, triedLine, typedForBridge, typedForDisplay, typedSpelled,
} from './nearModel';

const STATES: NearState[] = ['idle', 'creating_session', 'showing_code', 'peer_connected', 'negotiating', 'proving_ble', 'proving_lan', 'proof_verified', 'awaiting_approval', 'approving', 'approved', 'transferring', 'transfer_paused', 'done', 'refused', 'expired', 'cancelled', 'failed'];
const snap = (state: NearState | string, over: Partial<NearSnapshot> = {}): NearSnapshot => ({ seq: 1, role: 'new_device', state: state as NearState, ...over });
const CTX = { thisDevice: 'this computer', device: 'Pixel 9' };

describe('state to screen: every state in the snapshot type renders something', () => {
    it('maps every host state for the new device to a screen (never undefined)', () => {
        for (const s of STATES) expect(newDeviceScreen(snap(s, { linkId: 'l1' })), s).toBeTruthy();
    });
    it('maps every host state for the approver to a screen (never undefined)', () => {
        for (const s of STATES) expect(approverScreen(snap(s, { role: 'approver' })), s).toBeTruthy();
    });
    it('new device: the approver\'s status lines drive the two rows (11.17) and the peer is named by its sealed label', () => {
        const base = { peer: { label: 'Dawson\'s phone', platform: 'android', labelSealed: true } };
        const ble = checkRows(snap('negotiating', { ...base, peerStatus: { stage: 'checking_ble' } }), CTX);
        expect(ble[0].st).toBe('on');
        const lan = checkRows(snap('negotiating', { ...base, peerStatus: { stage: 'checking_lan' } }), CTX);
        expect([lan[0].st, lan[1].st]).toEqual(['no', 'on']);
        const held = checkRows(snap('awaiting_approval', { ...base, peerStatus: { stage: 'proof_ok', proximity: 'ble' } }), CTX);
        expect(held[0].st).toBe('ok');
        const heldLan = checkRows(snap('awaiting_approval', { ...base, peerStatus: { stage: 'proof_ok', proximity: 'lan' } }), CTX);
        expect(heldLan[1].st).toBe('ok');
        // without any status the rows are what they were before
        expect(checkRows(snap('negotiating', base), CTX)[0].st).toBe('on');
    });
    it('new device: an approver refusal, a cancel and a protocol error each land on a calm screen', () => {
        expect(newDeviceScreen(snap('refused', { error: { code: 'denied', message: '' } }))).toBe('declined');
        expect(newDeviceScreen(snap('cancelled', { error: { code: 'peer_cancelled', message: '' } }))).toBe('lost');
        expect(newDeviceScreen(snap('failed', { linkId: 'l', error: { code: 'peer_error', message: '' } }))).toBe('lost');
        expect(newDeviceScreen(snap('failed', { linkId: 'l', error: { code: 'burned', message: '' } }))).toBe('burned');
        expect(approverScreen(snap('cancelled', { role: 'approver', error: { code: 'peer_cancelled', message: '' } }))).toBe('cancelled');
    });
    it('an UNKNOWN state does not throw and maps to "unknown"', () => {
        expect(newDeviceScreen(snap('teleporting'))).toBe('unknown');
        expect(approverScreen(snap('teleporting', { role: 'approver' }))).toBe('unknown');
        expect(isKnownState('teleporting')).toBe(false);
        expect(isKnownState('idle')).toBe(true);
    });
    it('new device flow: preparing, code, check, wait, signing', () => {
        expect(newDeviceScreen(snap('creating_session'))).toBe('preparing');
        expect(newDeviceScreen(snap('showing_code'))).toBe('code');
        for (const s of ['peer_connected', 'negotiating', 'proving_ble', 'proving_lan'] as const) expect(newDeviceScreen(snap(s))).toBe('check');
        expect(newDeviceScreen(snap('awaiting_approval'))).toBe('wait');
        expect(newDeviceScreen(snap('approved'))).toBe('signing');
    });
    it('refusals split by cause: denied, burned, no proximity', () => {
        expect(newDeviceScreen(snap('refused', { error: { code: 'denied', message: '' } }))).toBe('declined');
        expect(newDeviceScreen(snap('refused', { error: { code: 'no_proximity', message: '' } }))).toBe('refused');
        expect(newDeviceScreen(snap('failed', { error: { code: 'link_near_locked', message: '' } }))).toBe('burned');
        expect(approverScreen(snap('refused', { role: 'approver', error: { code: 'denied', message: '' } }))).toBe('denied');
        expect(approverScreen(snap('refused', { role: 'approver', error: { code: 'no_proximity', message: '' } }))).toBe('refused');
    });
    it('a failure before any session is "could not get a code"; after one it is "lost touch"', () => {
        expect(newDeviceScreen(snap('failed'))).toBe('error');
        expect(newDeviceScreen(snap('failed', { linkId: 'x' }))).toBe('lost');
    });
    it('approver flow: invite, check, approve, approving, done, sending', () => {
        expect(approverScreen(snap('showing_code', { role: 'approver' }))).toBe('invite');
        expect(approverScreen(snap('proving_lan', { role: 'approver' }))).toBe('check');
        expect(approverScreen(snap('proof_verified', { role: 'approver' }))).toBe('approve');
        expect(approverScreen(snap('awaiting_approval', { role: 'approver' }))).toBe('approve');
        expect(approverScreen(snap('approving', { role: 'approver' }))).toBe('approving');
        expect(approverScreen(snap('approved', { role: 'approver' }))).toBe('done');
        expect(approverScreen(snap('transferring', { role: 'approver' }))).toBe('sending');
        expect(approverScreen(snap('expired', { role: 'approver' }))).toBe('expired');
    });
});

describe('typed code', () => {
    it('Crockford: uppercase, aliases, separators, paste forms', () => {
        for (const raw of ['K7QM-42F8', 'k7qm 42f8', 'K7QM·42F8', 'k7qm · 42f8']) expect(normalizeTyped(raw)).toBe('K7QM42F8');
        expect(normalizeTyped('oil0')).toBe('0110');
        expect(normalizeTyped('U!U')).toBe('');
        expect(normalizeTyped('ABCDEFGHJKMN')).toHaveLength(8);
    });
    it('formats for the bridge, the screen and the screen reader', () => {
        expect(typedForBridge('k7qm42f8')).toBe('K7QM-42F8');
        expect(typedForBridge('k7q')).toBe('K7Q');
        expect(typedForDisplay('K7QM-42F8')).toBe('K7QM·42F8');
        expect(typedSpelled('K7QM-42F8')).toBe('K 7 Q M, 4 2 F 8');
    });
});

describe('proximity rows', () => {
    it('Bluetooth running: Bluetooth on, Wi-Fi waits', () => {
        const r = checkRows(snap('proving_ble', { attempt: { proof: 'ble', hint: 'scanning' } }), CTX);
        expect(r[0]).toMatchObject({ k: 'ble', st: 'on' }); expect(r[1]).toMatchObject({ k: 'lan', st: 'wait' });
    });
    it('Bluetooth found: ok; Wi-Fi not needed', () => {
        const r = checkRows(snap('proof_verified', { proximity: 'ble' }), CTX);
        expect(r[0].st).toBe('ok');
    });
    it('Bluetooth fell through to Wi-Fi: Bluetooth no, Wi-Fi on', () => {
        const r = checkRows(snap('proving_lan', { attempt: { proof: 'lan', hint: 'dialing' }, ble: { status: 'fell_through' } }), CTX);
        expect(r[0].st).toBe('no'); expect(r[1].st).toBe('on');
    });
    it('radio off names the device; denied and no adapter have their own lines', () => {
        const base = (ble: 'off' | 'denied' | 'no_adapter') => checkRows(snap('proving_lan', { attempt: { proof: 'lan', hint: 'dialing' }, refusal: { ble, lan: 'skipped' } }), CTX)[0].sub;
        expect(base('off')).toContain('this computer');
        expect(base('denied')).toMatch(/allowed/);
        expect(base('no_adapter')).toMatch(/no Bluetooth/);
    });
    it('computer to computer: Bluetooth skipped', () => {
        const r = checkRows(snap('proving_lan', { peer: { label: 'Desk', platform: 'windows', labelSealed: false }, attempt: { proof: 'lan', hint: 'listening' } }), CTX);
        expect(r[0].st).toBe('skip');
    });
    it('Wi-Fi refusal causes', () => {
        const row = (lan: 'denied' | 'firewall' | 'not_found') => checkRows(snap('refused', { refusal: { ble: 'not_found', lan } }), CTX)[1];
        expect(row('firewall').sub).toMatch(/firewall/);
        expect(row('denied').sub).toMatch(/Local network/);
        expect(row('not_found').st).toBe('no');
    });
});

describe('hints (no yellow callouts: just which one)', () => {
    it('bring it closer appears only after 6 s without a hit', () => {
        const s = snap('proving_ble', { attempt: { proof: 'ble', hint: 'scanning' } });
        expect(checkHint(s, 5999, { thisIsWindows: true, device: 'x' })).toBeNull();
        expect(checkHint(s, 6000, { thisIsWindows: true, device: 'x' })?.key).toBe('hint.closer');
        expect(checkHint(snap('proof_verified', { proximity: 'ble' }), 9000, { thisIsWindows: true, device: 'x' })).toBeNull();
    });
    it('Bluetooth off, Wi-Fi retry and the Windows firewall line', () => {
        expect(checkHint(snap('proving_lan', { refusal: { ble: 'off', lan: 'skipped' } }), 0, { thisIsWindows: true, device: 'x' })?.key).toBe('hint.bt.off.d');
        expect(checkHint(snap('proving_lan', { attempt: { proof: 'lan', hint: 'dialing' } }), 0, { thisIsWindows: true, device: 'x' })?.key).toBe('hint.lan.same');
        expect(checkHint(snap('proving_lan', { peer: { label: 'd', platform: 'windows', labelSealed: false }, attempt: { proof: 'lan', hint: 'listening' } }), 0, { thisIsWindows: true, device: 'x' })?.key).toBe('hint.win.fw');
    });
});

describe('refusal line', () => {
    it('says what each proof said, with the per-proof causes', () => {
        expect(triedLine({ ble: 'off', lan: 'firewall' }, { thisDevice: 'this computer', bleNa: false })).toBe('Tried: Bluetooth — Bluetooth is off on this computer. Same Wi‑Fi — this PC’s firewall blocked it.');
        expect(triedLine({ ble: 'not_found', lan: 'not_found' }, { thisDevice: 'x', bleNa: false })).toMatch(/didn’t find it nearby.*not on the same network/);
        expect(triedLine({ ble: 'not_found', lan: 'not_found' }, { thisDevice: 'x', bleNa: true })).toMatch(/not used between two computers/);
        expect(triedLine(undefined, { thisDevice: 'x', bleNa: false })).toContain('Tried:');
    });
    it('both blocked by permissions is its own variant', () => {
        expect(bothBlocked({ ble: 'denied', lan: 'denied' })).toBe(true);
        expect(bothBlocked({ ble: 'not_found', lan: 'denied' })).toBe(false);
        expect(bothBlocked(undefined)).toBe(false);
    });
});

describe('approval view', () => {
    it('Bluetooth proof: sizing until the Wi-Fi probe answers, then offer or fall back', () => {
        expect(approvalView(snap('proof_verified', { proximity: 'ble' }), true).sizing).toBe(true);
        expect(approvalView(snap('awaiting_approval', { proximity: 'ble', transferOfferable: true }), false).sizing).toBe(true);
        const ok = approvalView(snap('awaiting_approval', { proximity: 'ble', transferOfferable: true }), true);
        expect(ok).toMatchObject({ sizing: false, canTransfer: true, noLan: false, proof: 'ble' });
        const no = approvalView(snap('awaiting_approval', { proximity: 'ble', transferOfferable: false }), true);
        expect(no).toMatchObject({ canTransfer: false, noLan: true });
    });
    it('F3: a local-network proof is approve-only (no history sizing, no transfer), whatever the probe says', () => {
        expect(approvalView(snap('awaiting_approval', { proximity: 'lan', historyAllowed: false }), true)).toMatchObject({ proof: 'lan', canTransfer: false, sizing: false, noLan: false, lanOnly: true });
        // a snapshot that predates `historyAllowed` reads the same way
        expect(approvalView(snap('awaiting_approval', { proximity: 'lan' }), false)).toMatchObject({ canTransfer: false, sizing: false, lanOnly: true });
        // even a (buggy or hostile) host that claims a path after a LAN proof cannot enable the transfer
        expect(approvalView(snap('awaiting_approval', { proximity: 'lan', historyAllowed: false, transferOfferable: true }), true).canTransfer).toBe(false);
    });
    it('F3: after a Bluetooth proof the transfer button waits for the probe (it runs after the sheet is up)', () => {
        const early = approvalView(snap('awaiting_approval', { proximity: 'ble', historyAllowed: true, transferOfferable: false }), true);
        expect(early).toMatchObject({ lanOnly: false, canTransfer: false });
        expect(approvalView(snap('awaiting_approval', { proximity: 'ble', historyAllowed: true, transferOfferable: true }), true)).toMatchObject({ lanOnly: false, canTransfer: true, sizing: false });
    });
    it('F4 / v14 refusals: identity_mismatch and taken_over have their own approver screens', () => {
        expect(approverScreen(snap('failed', { error: { code: 'identity_mismatch', message: 'x' } }))).toBe('mismatch');
        expect(approverScreen(snap('failed', { error: { code: 'taken_over', message: 'x' } }))).toBe('taken');
    });
});

describe('labels, sizes, ETA', () => {
    it('a device label is untrusted: control characters stripped, bounded', () => {
        expect(safeLabel('Pixel‮ 9\u0000')).toBe('Pixel 9');
        expect(safeLabel('x'.repeat(200))).toHaveLength(64);
        expect(safeLabel('  ', 'fallback')).toBe('fallback');
        expect(safeLabel(undefined)).toBe('Your other device');
        expect(safeLabel('a\u200bb\u200ec\u061cd\ufeffe')).toBe('abcde'); // zero-width and direction marks, like the phone's clean_label
    });
    it('bytes and percent', () => {
        expect(formatBytes(0)).toBe('0 B'); expect(formatBytes(1500)).toBe('1.5 KB'); expect(formatBytes(2_400_000_000)).toBe('2.4 GB');
        expect(percent({ bytesDone: 50, bytesTotal: 200 })).toBe(25); expect(percent({ bytesDone: 5, bytesTotal: 0 })).toBe(0);
        expect(percent({ bytesDone: 500, bytesTotal: 200 })).toBe(100);
    });
    it('ETA: never seconds', () => {
        expect(formatEta(500)).toBe('about 1 min left'); expect(formatEta(4 * 60_000)).toBe('about 4 min left'); expect(formatEta(70 * 60_000)).toBe('about 1 h 10 min left');
    });
    it('ETA only after 10 s of steady throughput and 5 percent', () => {
        const e = new EtaTracker();
        e.push(0, 0); e.push(5000, 100);
        expect(e.eta(5000, 100, 1000)).toBeNull();           // under 10 s
        e.push(12_000, 400);
        expect(e.eta(12_000, 400, 10_000)).toBeNull();           // 4 percent: still under 5
        expect(e.eta(12_000, 400, 5_000)).toBe('about 3 min left'); // 8 percent, 12 s of samples
    });
});

describe('transfer phase', () => {
    const t = (over: object = {}) => ({ direction: 'receive' as const, bytesDone: 1, bytesTotal: 10, recordsDone: 1, recordsTotal: 5, attempt: 1, paused: false, interrupted: false, ...over });
    it('moving, interrupted, paused, done', () => {
        expect(transferPhase(snap('transferring', { transfer: t() }))).toBe('moving');
        expect(transferPhase(snap('transfer_paused', { transfer: t({ interrupted: true }) }))).toBe('interrupted');
        expect(transferPhase(snap('transferring', { transfer: t({ paused: true }) }))).toBe('paused');
        expect(transferPhase(snap('done'))).toBe('done');
        expect(transferPhase(snap('idle'))).toBeNull();
    });
});
