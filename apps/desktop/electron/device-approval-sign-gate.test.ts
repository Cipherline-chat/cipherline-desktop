import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    APPROVAL_DECLINE_COOLDOWN_MS, approvalQuestion, createApprovalSignGate, platformDisplay, sanitizeDisplayName,
    type ApprovalSignGateDeps,
} from './device-approval-sign-gate';

/**
 * Signing an approval makes another device a recipient of everything on the
 * account. The IPC sender guard proves the caller is our renderer, not that a
 * person asked; so MAIN must show a native confirmation BEFORE it signs, the
 * way the recovery-key reveal does. These tests hold the line from both
 * sides: Cancel (or no dialog at all) must never produce a signature, and
 * Approve must.
 */

const USER = '11111111-2222-3333-4444-555555555555';
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const PENDING = 'bbbbbbbb-0000-4000-8000-000000000002';
const KEY = Buffer.alloc(32, 7).toString('base64'); // 44 chars, one '='
const TS = 1_800_000_000;
const SIGNED = { identityPub: 'IDPUB', sig: 'SIG' };

/** Hands back the spies the gate actually received (overrides included) — a
 *  `not.toHaveBeenCalled()` on a default nothing was wired to proves nothing. */
function gate(over: Partial<ApprovalSignGateDeps> = {}) {
    const deps: ApprovalSignGateDeps = {
        confirm: vi.fn(async () => true),
        signDecision: vi.fn(async () => SIGNED),
        signLink: vi.fn(async () => SIGNED),
        ...over,
    };
    return {
        g: createApprovalSignGate(deps),
        confirm: deps.confirm as ReturnType<typeof vi.fn>,
        signDecision: deps.signDecision as ReturnType<typeof vi.fn>,
        signLink: deps.signLink as ReturnType<typeof vi.fn>,
    };
}

const approve = (over: Record<string, unknown> = {}) => ({
    userId: USER, approverDeviceId: ME, pendingDeviceId: PENDING, pendingIdentityKeyB64: KEY,
    decision: 'approve', ts: TS, display: { deviceName: 'NEW-PC', platform: 'windows' }, ...over,
});
const deny = (over: Record<string, unknown> = {}) => approve({ decision: 'deny', display: undefined, ...over });
const link = (over: Record<string, unknown> = {}) => ({
    userId: USER, approverDeviceId: ME, linkId: 'Zm9vYmFyX2xpbmstaWQ', newIdentityKeyB64: KEY, ts: TS, ...over,
});

describe('approve — the confirmation is load-bearing', () => {
    it('Cancel → NO signature: the signer is never called', async () => {
        const g = gate({ confirm: vi.fn(async () => false) });
        await expect(g.g.signDecision(approve())).resolves.toEqual({ ok: false, reason: 'declined' });
        expect(g.confirm).toHaveBeenCalledTimes(1);
        expect(g.signDecision).not.toHaveBeenCalled();
    });

    it('Approve → a signature, and the signer saw exactly the validated message fields', async () => {
        const g = gate();
        await expect(g.g.signDecision(approve())).resolves.toEqual({ ok: true, ...SIGNED });
        expect(g.signDecision).toHaveBeenCalledWith({
            userId: USER, approverDeviceId: ME, pendingDeviceId: PENDING, pendingIdentityKeyB64: KEY, decision: 'approve', ts: TS,
        });
        // The display text is not part of what is signed.
        expect(JSON.stringify((g.signDecision.mock.calls[0] as unknown[])[0])).not.toContain('NEW-PC');
    });

    it('the dialog is told the sanitized name and the platform label from the request', async () => {
        const g = gate();
        await g.g.signDecision(approve({ display: { deviceName: 'Dawson\u2019s  PC', platform: 'mac' } }));
        expect(g.confirm).toHaveBeenCalledWith({ kind: 'device', deviceName: 'Dawson\u2019s PC', platform: 'macOS' });
    });

    it('asks every single time — approving once does not pre-approve the next device', async () => {
        const g = gate();
        await g.g.signDecision(approve());
        await g.g.signDecision(approve({ pendingDeviceId: 'cccccccc-0000-4000-8000-000000000003' }));
        expect(g.confirm).toHaveBeenCalledTimes(2);
        expect(g.signDecision).toHaveBeenCalledTimes(2);
    });

    it('fails closed when the dialog itself throws: no signature', async () => {
        const g = gate({ confirm: vi.fn(async () => { throw new Error('no window'); }) });
        await expect(g.g.signDecision(approve())).resolves.toEqual({ ok: false, reason: 'declined' });
        expect(g.signDecision).not.toHaveBeenCalled();
    });

    it('reports unavailable (not ok) when the human approved but the identity key could not sign', async () => {
        const g = gate({ signDecision: vi.fn(async () => null) });
        await expect(g.g.signDecision(approve())).resolves.toEqual({ ok: false, reason: 'unavailable' });
    });
});

describe('deny / "Cancel reset" — the safe direction is never behind a dialog', () => {
    it('signs without any confirmation', async () => {
        const g = gate({ confirm: vi.fn(async () => false) });
        await expect(g.g.signDecision(deny())).resolves.toEqual({ ok: true, ...SIGNED });
        expect(g.confirm).not.toHaveBeenCalled();
        expect(g.signDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny' }));
    });

    it('still works right after the user declined an approve (the cooldown is for approvals only)', async () => {
        const g = gate({ confirm: vi.fn(async () => false) });
        await g.g.signDecision(approve());
        await expect(g.g.signDecision(deny())).resolves.toMatchObject({ ok: true });
    });
});

describe('dialog fatigue is bounded', () => {
    it('drops concurrent requests instead of stacking dialogs', async () => {
        let release!: (v: boolean) => void;
        const confirm = vi.fn(() => new Promise<boolean>(r => { release = r; }));
        const g = gate({ confirm });
        const first = g.g.signDecision(approve());
        await expect(g.g.signDecision(approve())).resolves.toEqual({ ok: false, reason: 'busy' });
        await expect(g.g.signLink(link())).resolves.toEqual({ ok: false, reason: 'busy' });
        expect(confirm).toHaveBeenCalledTimes(1);
        release(true);
        await expect(first).resolves.toMatchObject({ ok: true });
    });

    it('a decline silences further approval prompts for the cooldown, then allows a retry', async () => {
        let t = 1_000;
        const confirm = vi.fn(async () => false);
        const g = gate({ confirm, now: () => t });
        await g.g.signDecision(approve());
        t += APPROVAL_DECLINE_COOLDOWN_MS - 1;
        await expect(g.g.signDecision(approve())).resolves.toEqual({ ok: false, reason: 'declined' });
        await expect(g.g.signLink(link())).resolves.toEqual({ ok: false, reason: 'declined' });
        expect(confirm).toHaveBeenCalledTimes(1);

        t += 2;
        confirm.mockResolvedValue(true);
        await expect(g.g.signDecision(approve())).resolves.toMatchObject({ ok: true });
        expect(confirm).toHaveBeenCalledTimes(2);
    });
});

describe('the QR-link approval is an approval and is confirmed the same way', () => {
    it('Cancel → no signature', async () => {
        const g = gate({ confirm: vi.fn(async () => false) });
        await expect(g.g.signLink(link())).resolves.toEqual({ ok: false, reason: 'declined' });
        expect(g.signLink).not.toHaveBeenCalled();
    });

    it('Approve → a signature, with a name-less dialog (the phone has not registered yet)', async () => {
        const g = gate();
        await expect(g.g.signLink(link())).resolves.toEqual({ ok: true, ...SIGNED });
        expect(g.confirm).toHaveBeenCalledWith({ kind: 'link', deviceName: null, platform: null });
        expect(approvalQuestion({ kind: 'link', deviceName: null, platform: null })).toBe('Approve a new device to access your encrypted messages?');
    });

    it('accepts a null new-device key (the phone advertised none)', async () => {
        const g = gate();
        await expect(g.g.signLink(link({ newIdentityKeyB64: null }))).resolves.toMatchObject({ ok: true });
    });
});

describe('strict IPC validation — nothing is shown and nothing is signed for a malformed payload', () => {
    it.each([
        ['userId with a colon (message-field smuggling)', { userId: `${USER}:x` }],
        ['approverDeviceId with a colon', { approverDeviceId: 'a:b' }],
        ['pendingDeviceId empty', { pendingDeviceId: '' }],
        ['pendingDeviceId not a string', { pendingDeviceId: 5 }],
        ['identity key too short', { pendingIdentityKeyB64: 'AAAA' }],
        ['identity key with a colon', { pendingIdentityKeyB64: `${KEY.slice(0, 42)}:=` }],
        ['ts as a string', { ts: '1800000000' }],
        ['ts zero', { ts: 0 }],
        ['ts fractional', { ts: 1.5 }],
        ['decision outside approve|deny', { decision: 'approve:deny' }],
        ['decision missing', { decision: undefined }],
    ])('approve: %s', async (_name, over) => {
        const g = gate();
        await expect(g.g.signDecision(approve(over))).resolves.toEqual({ ok: false, reason: 'invalid' });
        expect(g.confirm).not.toHaveBeenCalled();
        expect(g.signDecision).not.toHaveBeenCalled();
    });

    it.each([
        ['no display at all', { display: undefined }],
        ['display null', { display: null }],
        ['name not a string', { display: { deviceName: 5, platform: 'windows' } }],
        ['name empty', { display: { deviceName: '', platform: 'windows' } }],
        ['name only control characters', { display: { deviceName: '\n\u202e\t', platform: 'windows' } }],
        ['platform not in the server enum', { display: { deviceName: 'PC', platform: 'plan9' } }],
        ['platform missing', { display: { deviceName: 'PC' } }],
    ])('approve with %s is refused rather than shown with nothing to say', async (_name, over) => {
        const g = gate();
        await expect(g.g.signDecision(approve(over))).resolves.toEqual({ ok: false, reason: 'invalid' });
        expect(g.confirm).not.toHaveBeenCalled();
        expect(g.signDecision).not.toHaveBeenCalled();
    });

    it.each([
        ['linkId with a colon', { linkId: 'a:b' }],
        ['linkId empty', { linkId: '' }],
        ['bad key', { newIdentityKeyB64: 'nope' }],
        ['key undefined (not null)', { newIdentityKeyB64: undefined }],
        ['ts not a number', { ts: NaN }],
    ])('link: %s', async (_name, over) => {
        const g = gate();
        await expect(g.g.signLink(link(over))).resolves.toEqual({ ok: false, reason: 'invalid' });
        expect(g.confirm).not.toHaveBeenCalled();
        expect(g.signLink).not.toHaveBeenCalled();
    });

    it('a rejected payload does not start the decline cooldown or hold the dialog slot', async () => {
        const g = gate();
        await g.g.signDecision(approve({ ts: 'x' }));
        await expect(g.g.signDecision(approve())).resolves.toMatchObject({ ok: true });
    });
});

describe('display sanitizing', () => {
    it('strips control, zero-width and bidi characters and collapses whitespace', () => {
        expect(sanitizeDisplayName('A\n\nApprove EVIL?\u202e  \u200bB')).toBe('A Approve EVIL? B');
    });

    it('truncates a long name with an ellipsis', () => {
        const out = sanitizeDisplayName('x'.repeat(500))!;
        expect(out).toHaveLength(64);
        expect(out.endsWith('…')).toBe(true);
    });

    it('a multi-line hostile name cannot add a line to the question', () => {
        const q = approvalQuestion({ kind: 'device', deviceName: sanitizeDisplayName('PC\n\nClick Approve to continue')!, platform: 'Windows' });
        expect(q).not.toContain('\n');
    });

    it('platforms are the server enum, with readable labels', () => {
        expect(['windows', 'mac', 'linux', 'ios', 'android', 'web'].map(platformDisplay)).toEqual(['Windows', 'macOS', 'Linux', 'iOS', 'Android', 'Web']);
        expect(platformDisplay('toString')).toBeNull(); // not an Object.prototype lookup
        expect(platformDisplay(undefined)).toBeNull();
    });

    it('the question reads exactly as the owner specified', () => {
        expect(approvalQuestion({ kind: 'device', deviceName: 'NEW-PC', platform: 'Windows' }))
            .toBe('Approve NEW-PC (Windows) to access your encrypted messages?');
    });
});

describe('the shipped code actually uses the gate', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const mainSrc = readFileSync(path.join(here, 'main.ts'), 'utf8');

    function handlerBody(channel: string): string {
        const at = mainSrc.indexOf(`ipcMain.handle('${channel}'`);
        expect(at, `${channel} handler missing`).toBeGreaterThan(-1);
        return mainSrc.slice(at, mainSrc.indexOf('\n  });', at));
    }

    it('both approval handlers delegate to the gate and never sign themselves', () => {
        for (const channel of ['crypto:device-approval-sign', 'crypto:link-approval-sign']) {
            const body = handlerBody(channel);
            expect(body, channel).toContain('approvalSignGate.');
            // The pre-gate bodies, verbatim. If either comes back the dialog is
            // bypassed while every test above still passes — so assert absence.
            expect(body, channel).not.toContain('signIdentityMessage');
            expect(body, channel).not.toContain('approvalDecisionMessage');
            expect(body, channel).not.toContain('linkApproveMessage');
        }
        expect(mainSrc).toContain('createApprovalSignGate');
    });

    it('the message is signed only from the gate\'s injected signers (one call site each)', () => {
        expect(mainSrc.match(/signIdentityMessage\(approvalDecisionMessage\(/g) ?? []).toHaveLength(1);
        expect(mainSrc.match(/signIdentityMessage\(linkApproveMessage\(/g) ?? []).toHaveLength(1);
    });

    it('the confirmation defaults to Cancel and only "Approve" (index 1) approves', () => {
        const at = mainSrc.indexOf('createApprovalSignGate({');
        const wiring = mainSrc.slice(at, mainSrc.indexOf("ipcMain.handle('crypto:device-approval-sign'", at));
        expect(wiring).toContain('defaultId: 0');
        expect(wiring).toContain('cancelId: 0');
        expect(wiring).toMatch(/buttons:\s*\['Cancel', 'Approve'\]/);
        expect(wiring).toContain('response === 1');
        expect(wiring).toContain('approvalQuestion(info)');
    });

    it('the history-request proof is NOT gated: it is the REQUESTER proving itself, not an approval', () => {
        const body = handlerBody('crypto:history-request-proof');
        expect(body).not.toContain('approvalSignGate');
    });
});
