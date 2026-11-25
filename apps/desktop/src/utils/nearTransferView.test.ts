import { describe, it, expect } from 'vitest';
import type { NearSnapshot } from '../types/near';
import { transferBannerView, InterruptWatch, GIVE_UP_ATTEMPTS, GIVE_UP_AFTER_MS, type TransferViewCtx } from './nearTransferView';

const t = (over: object = {}) => ({ direction: 'receive' as const, bytesDone: 38_000_000, bytesTotal: 100_000_000, recordsDone: 3, recordsTotal: 10, attempt: 1, paused: false, interrupted: false, ...over });
const snap = (state: NearSnapshot['state'], over: Partial<NearSnapshot> = {}): NearSnapshot => ({ seq: 1, role: 'new_device', state, ...over });
const ctx = (over: Partial<TransferViewCtx> = {}): TransferViewCtx => ({ device: 'iPhone 16', direction: 'receive', eta: null, controls: { pause: false, cancel: true, details: true }, ...over });

describe('transfer banner view', () => {
    it('moving: title, bytes without an ETA, progress, Details and Cancel (Pause hidden: the engine cannot pause)', () => {
        const v = transferBannerView(snap('transferring', { transfer: t() }), ctx())!;
        expect(v.title).toBe('Bringing your history over from iPhone 16');
        expect(v.description).toBe('38% · 38 MB of 100 MB');
        expect(v.progress).toEqual({ pct: 38, state: 'moving' });
        expect(v.actions).toEqual(['details', 'cancel']);
    });
    it('connected but no byte moved yet (the sender is sealing): an indeterminate "preparing" bar, same text', () => {
        const v = transferBannerView(snap('transferring', { role: 'approver', transfer: t({ direction: 'send', bytesDone: 0 }) }), ctx({ direction: 'send' }))!;
        expect(v.kind).toBe('moving'); expect(v.progress).toEqual({ pct: 0, state: 'preparing' });
        expect(v.description).toBe('0% · 0 B of 100 MB');
        const r = transferBannerView(snap('transferring', { transfer: t({ bytesDone: 0, bytesTotal: 0 }) }), ctx())!;
        expect(r.progress?.state).toBe('preparing'); expect(r.description).toBe('');
        expect(transferBannerView(snap('transferring', { transfer: t({ bytesDone: 1 }) }), ctx())!.progress?.state).toBe('moving');
    });
    it('shows an ETA only when given one, and Pause only when the engine reports it', () => {
        const v = transferBannerView(snap('transferring', { transfer: t() }), ctx({ eta: 'about 4 min left', controls: { pause: true, cancel: true, details: true } }))!;
        expect(v.description).toBe('38% · 38 MB of 100 MB · about 4 min left');
        expect(v.actions).toEqual(['pause', 'details', 'cancel']);
    });
    it('interrupted is neutral and says it resumes by itself', () => {
        const v = transferBannerView(snap('transfer_paused', { transfer: t({ interrupted: true }) }), ctx())!;
        expect(v.kind).toBe('interrupted'); expect(v.tone).toBe('neutral'); expect(v.title).toBe('Waiting for iPhone 16');
        expect(v.progress?.state).toBe('interrupted');
    });
    it('user pause (when it exists) offers Resume', () => {
        const v = transferBannerView(snap('transferring', { transfer: t({ paused: true }) }), ctx({ controls: { pause: true, cancel: true, details: true } }))!;
        expect(v.kind).toBe('paused'); expect(v.actions[0]).toBe('resume');
    });
    it('sender sees the matching text', () => {
        const v = transferBannerView(snap('transferring', { role: 'approver', transfer: t({ direction: 'send' }) }), ctx({ direction: 'send' }))!;
        expect(v.title).toBe('Sending your history to iPhone 16');
        const d = transferBannerView(snap('done', { role: 'approver' }), ctx({ direction: 'send' }))!;
        expect(d.title).toBe('History sent to iPhone 16'); expect(d.autoHideMs).toBe(8000);
    });
    it('receiver: applying, then done with counts (auto-hides after 8 s, dismissible)', () => {
        expect(transferBannerView(snap('done'), ctx({ applying: true }))!.kind).toBe('applying');
        const d = transferBannerView(snap('done'), ctx({ counts: { messages: 18204, attachments: 1180 } }))!;
        expect(d.tone).toBe('success'); expect(d.title).toBe('Your history is here'); expect(d.description).toBe('18,204 messages and 1,180 attachments from iPhone 16.');
        expect(d.autoHideMs).toBe(8000); expect(d.dismissible).toBe(true);
    });
    it('partial and stopped are neutral', () => {
        const p = transferBannerView(snap('failed', { partial: { recordsHeld: 8, recordsTotal: 10, bytesHeld: 5 } }), ctx())!;
        expect(p.kind).toBe('partial'); expect(p.description).toContain('2 attachments');
        expect(transferBannerView(snap('cancelled'), ctx({ stopped: true }))!.kind).toBe('stopped');
    });
    it('nothing to show outside a transfer', () => {
        expect(transferBannerView(snap('idle'), ctx())).toBeNull();
        expect(transferBannerView(snap('showing_code'), ctx())).toBeNull();
    });
    it('a pause the OTHER device made offers no Resume; mine does', () => {
        const c = ctx({ controls: { pause: true, cancel: true, details: true } });
        const mine = transferBannerView(snap('transfer_paused', { transfer: t({ paused: true, pausedBy: 'me' }) }), c)!;
        expect(mine.kind).toBe('paused');
        expect(mine.actions).toEqual(['resume', 'details', 'cancel']);
        const theirs = transferBannerView(snap('transfer_paused', { transfer: t({ paused: true, pausedBy: 'peer' }) }), c)!;
        expect(theirs.kind).toBe('paused');
        expect(theirs.actions).toEqual(['details', 'cancel']);
        // a dropped connection is not a pause
        expect(transferBannerView(snap('transfer_paused', { transfer: t({ interrupted: true }) }), c)!.kind).toBe('interrupted');
    });
});

describe('giving up on a dead transfer (B7)', () => {
    const dropped = (attempt: number, over: object = {}) => snap('transfer_paused', { role: 'own_sender', transfer: t({ direction: 'send', bytesDone: 0, interrupted: true, attempt, ...over }) });
    it('stays patient for the first attempts and a short outage', () => {
        const w = new InterruptWatch();
        expect(w.gaveUp(0, dropped(2))).toBe(false);
        expect(w.gaveUp(GIVE_UP_AFTER_MS - 1, dropped(GIVE_UP_ATTEMPTS - 1))).toBe(false);
    });
    it('gives up at the attempt bound', () => {
        expect(new InterruptWatch().gaveUp(0, dropped(GIVE_UP_ATTEMPTS))).toBe(true);
    });
    it('gives up once it has been interrupted for the time bound, even with few attempts', () => {
        const w = new InterruptWatch();
        expect(w.gaveUp(1000, dropped(1))).toBe(false);
        expect(w.remainingMs(1000 + 10_000)).toBe(GIVE_UP_AFTER_MS - 10_000);
        expect(w.gaveUp(1000 + GIVE_UP_AFTER_MS, dropped(1))).toBe(true);
    });
    it('progress or a reconnect resets the clock; a user pause and a finished transfer never count', () => {
        const w = new InterruptWatch();
        expect(w.gaveUp(0, dropped(1))).toBe(false);
        expect(w.gaveUp(GIVE_UP_AFTER_MS - 5, snap('transferring', { role: 'own_sender', transfer: t({ direction: 'send' }) }))).toBe(false);
        expect(w.remainingMs(GIVE_UP_AFTER_MS)).toBeNull();
        expect(w.gaveUp(GIVE_UP_AFTER_MS, dropped(2))).toBe(false);
        expect(w.gaveUp(0, snap('transfer_paused', { transfer: t({ paused: true, interrupted: true, attempt: 9 }) }))).toBe(false);
        expect(w.gaveUp(0, snap('done', { transfer: t({ attempt: 9, interrupted: true }) }))).toBe(false);
        expect(w.gaveUp(0, null)).toBe(false);
    });
    it('the banner says it stopped, names the other device, and offers only Discard', () => {
        const v = transferBannerView(dropped(5), ctx({ direction: 'send', gaveUp: true }))!;
        expect(v.kind).toBe('gave_up');
        expect(v.title).toBe('Transfer stopped');
        expect(v.description).toBe('iPhone 16 stopped waiting. Start it again from iPhone 16.');
        expect(v.actions).toEqual(['discard']);
        expect(v.progress).toBeNull();
    });
});
