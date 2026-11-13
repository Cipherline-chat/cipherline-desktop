import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    PROBE_TIMEOUT_MS, classifyKWallet, createKWallet, classifySecretService, decideKeyringPlan, isSafeWalletName, openKWallet,
    parseBool, parseInteger, parseObjectPath, parseString, parseStringArray, probeWallet, serviceForBackend,
    type BusExec, type WalletProbe, type WalletService,
} from './keyring-probe';

afterEach(() => { vi.useRealTimers(); });

describe('busctl output parsers', () => {
    it('bool', () => {
        expect(parseBool('b true\n')).toBe(true);
        expect(parseBool('b false')).toBe(false);
        expect(parseBool('s "true"')).toBeNull();
        expect(parseBool('')).toBeNull();
    });
    it('string', () => {
        expect(parseString('s "kdewallet"\n')).toBe('kdewallet');
        expect(parseString('s ""')).toBe('');
        expect(parseString('s "a \\"b\\" c"')).toBe('a "b" c');
        expect(parseString('b true')).toBeNull();
        expect(parseString('s kdewallet')).toBeNull();
    });
    it('object path', () => {
        expect(parseObjectPath('o "/"')).toBe('/');
        expect(parseObjectPath('o "/org/freedesktop/secrets/collection/login"\n')).toBe('/org/freedesktop/secrets/collection/login');
        expect(parseObjectPath('s "/"')).toBeNull();
    });
    it('string array, with the count checked', () => {
        expect(parseStringArray('as 0\n')).toEqual([]);
        expect(parseStringArray('as 1 "kdewallet"')).toEqual(['kdewallet']);
        expect(parseStringArray('as 2 "a" "b c"')).toEqual(['a', 'b c']);
        expect(parseStringArray('as 2 "a"')).toBeNull();
        expect(parseStringArray('as x')).toBeNull();
        expect(parseStringArray('s "a"')).toBeNull();
    });
    it('integer', () => {
        expect(parseInteger('i -1\n')).toBe(-1);
        expect(parseInteger('i 1962296406')).toBe(1962296406);
        expect(parseInteger('x 0')).toBe(0);
        expect(parseInteger('b true')).toBeNull();
    });
    it('wallet names: plain words only', () => {
        for (const ok of ['kdewallet', 'My Wallet', 'a.b-c_d']) expect(isSafeWalletName(ok)).toBe(true);
        for (const bad of ['', '-x', '--help', 'a"b', 'a;b', '../x', '\n', null, undefined, 'x'.repeat(65)]) expect(isSafeWalletName(bad as string)).toBe(false);
    });
});

describe('serviceForBackend', () => {
    it('maps every real keyring backend and nothing else', () => {
        expect(serviceForBackend('kwallet6')).toEqual({ service: 'kwallet', bus: 'org.kde.kwalletd6', path: '/modules/kwalletd6' });
        expect(serviceForBackend('kwallet5')).toEqual({ service: 'kwallet', bus: 'org.kde.kwalletd5', path: '/modules/kwalletd5' });
        expect(serviceForBackend('kwallet')).toEqual({ service: 'kwallet', bus: 'org.kde.kwalletd', path: '/modules/kwalletd' });
        expect(serviceForBackend('gnome_libsecret')).toEqual({ service: 'secret-service' });
        for (const b of ['basic_text', 'x', '', null, undefined]) expect(serviceForBackend(b)).toBeNull();
    });
});

describe('KWallet decision table', () => {
    const base = { isEnabled: true, wallets: ['kdewallet'], networkWallet: 'kdewallet', isOpen: false as boolean | null };
    it('locked: a wallet exists and is closed', () => {
        expect(classifyKWallet(base)).toEqual({ kind: 'locked' });
    });
    it('unlocked: the network wallet is open', () => {
        expect(classifyKWallet({ ...base, isOpen: true })).toEqual({ kind: 'unlocked' });
    });
    it('no wallet: wallets() is empty (fresh Plasma account; networkWallet fails here)', () => {
        expect(classifyKWallet({ ...base, wallets: [], networkWallet: null, isOpen: null })).toEqual({ kind: 'no-wallet', walletName: null });
        expect(classifyKWallet({ ...base, wallets: [], isOpen: null })).toEqual({ kind: 'no-wallet', walletName: 'kdewallet' });
    });
    it('no wallet: the network wallet is not among the existing ones', () => {
        expect(classifyKWallet({ ...base, wallets: ['other'], isOpen: null })).toEqual({ kind: 'no-wallet', walletName: 'kdewallet' });
    });
    it('service disabled: isEnabled false wins over everything', () => {
        expect(classifyKWallet({ ...base, isEnabled: false })).toEqual({ kind: 'disabled' });
        expect(classifyKWallet({ isEnabled: false, wallets: [], networkWallet: null, isOpen: null })).toEqual({ kind: 'disabled' });
    });
    it('unknown: anything unreadable', () => {
        expect(classifyKWallet({ ...base, isEnabled: null })).toEqual({ kind: 'unknown' });
        expect(classifyKWallet({ ...base, wallets: null })).toEqual({ kind: 'unknown' });
        expect(classifyKWallet({ ...base, networkWallet: null })).toEqual({ kind: 'unknown' });
        expect(classifyKWallet({ ...base, isOpen: null })).toEqual({ kind: 'unknown' });
        expect(classifyKWallet({ ...base, networkWallet: '--bad' })).toEqual({ kind: 'unknown' });
    });
});

describe('Secret Service decision table', () => {
    it('locked / unlocked from the default collection', () => {
        expect(classifySecretService({ defaultAlias: '/org/freedesktop/secrets/collection/login', locked: true })).toEqual({ kind: 'locked' });
        expect(classifySecretService({ defaultAlias: '/org/freedesktop/secrets/collection/login', locked: false })).toEqual({ kind: 'unlocked' });
    });
    it('no default collection: the service is up but there is no keyring yet', () => {
        expect(classifySecretService({ defaultAlias: '/', locked: null })).toEqual({ kind: 'no-wallet', walletName: null });
    });
    it('service missing / Locked unreadable: unknown', () => {
        expect(classifySecretService({ defaultAlias: null, locked: null })).toEqual({ kind: 'unknown' });
        expect(classifySecretService({ defaultAlias: '/org/freedesktop/secrets/collection/login', locked: null })).toEqual({ kind: 'unknown' });
    });
});

const KW: WalletService = { service: 'kwallet', bus: 'org.kde.kwalletd6', path: '/modules/kwalletd6' };
const SS: WalletService = { service: 'secret-service' };

describe('decideKeyringPlan (both services)', () => {
    const P = (kind: WalletProbe['kind'], extra: object = {}) => ({ kind, ...extra }) as WalletProbe;
    it('unlocked and disabled: nothing before the call, no notice, no delay', () => {
        for (const svc of [KW, SS]) {
            expect(decideKeyringPlan(svc, P('unlocked'))).toEqual({ action: 'none' });
            expect(decideKeyringPlan(svc, P('disabled'))).toEqual({ action: 'none' });
        }
    });
    it('unknown (service missing, parse failure): the previous behaviour; a TIMEOUT shows the notice at once', () => {
        for (const svc of [KW, SS, null]) {
            expect(decideKeyringPlan(svc, P('unknown'))).toEqual({ action: 'legacy', immediate: false });
            expect(decideKeyringPlan(svc, P('unknown', { timedOut: true }))).toEqual({ action: 'legacy', immediate: true });
        }
    });
    it('locked: notice first, then the call', () => {
        for (const svc of [KW, SS]) expect(decideKeyringPlan(svc, P('locked'))).toEqual({ action: 'notice-first', mode: 'unlock' });
    });
    it('no wallet, KWallet: create it ourselves, behind the notice', () => {
        expect(decideKeyringPlan(KW, P('no-wallet', { walletName: 'kdewallet' }))).toEqual({ action: 'create-wallet', mode: 'create', walletName: 'kdewallet' });
        expect(decideKeyringPlan(KW, P('no-wallet', { walletName: null }))).toEqual({ action: 'create-wallet', mode: 'create', walletName: 'kdewallet' });
        expect(decideKeyringPlan(KW, P('no-wallet', { walletName: '--evil' }))).toEqual({ action: 'create-wallet', mode: 'create', walletName: 'kdewallet' });
    });
    it('no wallet, Secret Service: libsecret creates its own keyring inside the call; the notice is the whole job', () => {
        expect(decideKeyringPlan(SS, P('no-wallet', { walletName: null }))).toEqual({ action: 'notice-first', mode: 'create' });
    });
});

/** A bus that answers by method name. */
function bus(answers: Record<string, string | null>): { exec: BusExec; calls: string[][] } {
    const calls: string[][] = [];
    const exec: BusExec = async (args) => {
        calls.push(args);
        const method = args.find(a => ['isEnabled', 'wallets', 'networkWallet', 'isOpen', 'open', 'ReadAlias', 'get-property'].includes(a)) ?? '';
        const out = answers[method];
        return out == null ? { ok: false, stdout: '' } : { ok: true, stdout: out };
    };
    return { exec, calls };
}

describe('probeWallet', () => {
    const kwAll = { isEnabled: 'b true', wallets: 'as 1 "kdewallet"', networkWallet: 's "kdewallet"' };

    it('KWallet locked / unlocked / no wallet / disabled', async () => {
        expect(await probeWallet('kwallet6', bus({ ...kwAll, isOpen: 'b false' }).exec)).toEqual({ kind: 'locked' });
        expect(await probeWallet('kwallet6', bus({ ...kwAll, isOpen: 'b true' }).exec)).toEqual({ kind: 'unlocked' });
        // fresh account: networkWallet FAILS, wallets() is empty
        expect(await probeWallet('kwallet6', bus({ isEnabled: 'b true', wallets: 'as 0', networkWallet: null }).exec)).toEqual({ kind: 'no-wallet', walletName: null });
        expect(await probeWallet('kwallet6', bus({ isEnabled: 'b false', wallets: 'as 0', networkWallet: null }).exec)).toEqual({ kind: 'disabled' });
    });

    it('KWallet isOpen=true but the Secret Service view says Locked (stale handle after a cancelled dialog): LOCKED', async () => {
        const alias = 'o "/org/freedesktop/secrets/collection/kdewallet"';
        expect(await probeWallet('kwallet6', bus({ ...kwAll, isOpen: 'b true', ReadAlias: alias, 'get-property': 'b true' }).exec)).toEqual({ kind: 'locked' });
        // both agree it is open: unlocked
        expect(await probeWallet('kwallet6', bus({ ...kwAll, isOpen: 'b true', ReadAlias: alias, 'get-property': 'b false' }).exec)).toEqual({ kind: 'unlocked' });
        // no Secret Service at all (older kwalletd5): isOpen stands
        expect(await probeWallet('kwallet5', bus({ ...kwAll, isOpen: 'b true' }).exec)).toEqual({ kind: 'unlocked' });
        // NEGATIVE CONTROL: a Secret Service that says unlocked never turns a closed wallet into an open one
        expect(await probeWallet('kwallet6', bus({ ...kwAll, isOpen: 'b false', ReadAlias: alias, 'get-property': 'b false' }).exec)).toEqual({ kind: 'locked' });
    });

    it('KWallet service missing: every call fails -> unknown', async () => {
        expect(await probeWallet('kwallet5', bus({}).exec)).toEqual({ kind: 'unknown' });
    });

    it('Secret Service locked / unlocked / no keyring / service missing', async () => {
        const alias = 'o "/org/freedesktop/secrets/collection/login"';
        expect(await probeWallet('gnome_libsecret', bus({ ReadAlias: alias, 'get-property': 'b true' }).exec)).toEqual({ kind: 'locked' });
        expect(await probeWallet('gnome_libsecret', bus({ ReadAlias: alias, 'get-property': 'b false' }).exec)).toEqual({ kind: 'unlocked' });
        expect(await probeWallet('gnome_libsecret', bus({ ReadAlias: 'o "/"' }).exec)).toEqual({ kind: 'no-wallet', walletName: null });
        expect(await probeWallet('gnome_libsecret', bus({}).exec)).toEqual({ kind: 'unknown' });
    });

    it('only ever issues read-only calls (no Unlock/CreateCollection/open) and no shell metacharacters', async () => {
        const b = bus({ ...kwAll, isOpen: 'b false' });
        await probeWallet('kwallet6', b.exec);
        const b2 = bus({ ReadAlias: 'o "/org/freedesktop/secrets/collection/login"', 'get-property': 'b true' });
        await probeWallet('gnome_libsecret', b2.exec);
        const all = [...b.calls, ...b2.calls].flat().join(' ');
        expect(all).not.toMatch(/\b(open|Unlock|CreateCollection|Lock|Delete|CreateItem)\b/);
        for (const c of [...b.calls, ...b2.calls]) expect(c[0]).toBe('--user');
    });

    it('a call that throws is unknown, never a rejection', async () => {
        const exec: BusExec = async () => { throw new Error('spawn ENOENT'); };
        expect(await probeWallet('kwallet6', exec)).toEqual({ kind: 'unknown' });
        expect(await probeWallet('gnome_libsecret', exec)).toEqual({ kind: 'unknown' });
    });

    it('TIMEOUT: a bus that never answers resolves to unknown at the deadline', async () => {
        vi.useFakeTimers();
        const exec: BusExec = () => new Promise(() => { /* never */ });
        const p = probeWallet('kwallet6', exec);
        let done: WalletProbe | null = null;
        void p.then(v => { done = v; });
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
        expect(done).toBeNull();
        await vi.advanceTimersByTimeAsync(2);
        expect(done).toEqual({ kind: 'unknown', timedOut: true });
        expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(1500);
    });

    it('NEGATIVE CONTROL: a non-keyring backend is never probed', async () => {
        const exec = vi.fn<BusExec>(async () => ({ ok: true, stdout: 'b true' }));
        for (const b of ['basic_text', null, '', 'unknown_thing']) expect(await probeWallet(b, exec)).toEqual({ kind: 'unknown' });
        expect(exec).not.toHaveBeenCalled();
    });
});

describe('openKWallet', () => {
    it('opened / cancelled / failed', async () => {
        const mk = (out: string | null): BusExec => async () => (out === null ? { ok: false, stdout: '' } : { ok: true, stdout: out });
        expect(await openKWallet(KW as Extract<WalletService, { service: 'kwallet' }>, 'kdewallet', 'Cipherline', mk('i 1962296406'))).toBe('opened');
        expect(await openKWallet(KW as Extract<WalletService, { service: 'kwallet' }>, 'kdewallet', 'Cipherline', mk('i -1'))).toBe('cancelled');
        expect(await openKWallet(KW as Extract<WalletService, { service: 'kwallet' }>, 'kdewallet', 'Cipherline', mk(null))).toBe('failed');
        expect(await openKWallet(KW as Extract<WalletService, { service: 'kwallet' }>, 'kdewallet', 'Cipherline', mk('garbage'))).toBe('failed');
        expect(await openKWallet(KW as Extract<WalletService, { service: 'kwallet' }>, 'kdewallet', 'Cipherline', mk('i 0'))).toBe('failed');
    });
    it('passes the same call Chromium makes (wallet, wId 0, appid) and rejects an unsafe wallet name without calling', async () => {
        const exec = vi.fn<BusExec>(async () => ({ ok: true, stdout: 'i 5' }));
        const svc = KW as Extract<WalletService, { service: 'kwallet' }>;
        await openKWallet(svc, 'kdewallet', 'Cipherline', exec);
        expect(exec.mock.calls[0][0]).toEqual(['--user', '--no-pager', 'call', 'org.kde.kwalletd6', '/modules/kwalletd6', 'org.kde.KWallet', 'open', 'sxs', 'kdewallet', '0', 'Cipherline']);
        exec.mockClear();
        expect(await openKWallet(svc, '--help', 'Cipherline', exec)).toBe('failed');
        expect(exec).not.toHaveBeenCalled();
    });
});

describe('createKWallet (the measured kwalletd6 behaviour: first open() returns -1 even after the wizard was completed)', () => {
    const svc = KW as Extract<WalletService, { service: 'kwallet' }>;
    /** Scripted bus: answers per method, popped in order. */
    function scripted(script: Record<string, Array<string | null>>) {
        const calls: string[] = [];
        const exec: BusExec = async (args) => {
            const m = args.find(a => ['open', 'wallets'].includes(a)) ?? '?';
            calls.push(m);
            const out = script[m]?.shift();
            return out == null ? { ok: false, stdout: '' } : { ok: true, stdout: out };
        };
        return { exec, calls };
    }

    it('completed wizard: first open -1, but the wallet now exists -> open again -> opened', async () => {
        const b = scripted({ open: ['i -1', 'i 1316997398'], wallets: ['as 1 "kdewallet"'] });
        expect(await createKWallet(svc, 'kdewallet', 'Cipherline', b.exec)).toBe('opened');
        expect(b.calls).toEqual(['open', 'wallets', 'open']);
    });

    it('GENUINE cancel: first open -1 and NO wallet exists -> cancelled, and no second open is made', async () => {
        const b = scripted({ open: ['i -1', 'i 5'], wallets: ['as 0'] });
        expect(await createKWallet(svc, 'kdewallet', 'Cipherline', b.exec)).toBe('cancelled');
        expect(b.calls).toEqual(['open', 'wallets']);
    });

    it('wizard done but the password dialog of the second open is cancelled -> cancelled', async () => {
        const b = scripted({ open: ['i -1', 'i -1'], wallets: ['as 1 "kdewallet"'] });
        expect(await createKWallet(svc, 'kdewallet', 'Cipherline', b.exec)).toBe('cancelled');
    });

    it('first open succeeds: no extra calls; a bus error is "failed" (never "cancelled")', async () => {
        const ok = scripted({ open: ['i 9'] });
        expect(await createKWallet(svc, 'kdewallet', 'Cipherline', ok.exec)).toBe('opened');
        expect(ok.calls).toEqual(['open']);
        const bad = scripted({ open: [null] });
        expect(await createKWallet(svc, 'kdewallet', 'Cipherline', bad.exec)).toBe('failed');
    });

    it('wallets() unreadable after a -1: treated as a real cancel (the safe side: nothing is written)', async () => {
        const b = scripted({ open: ['i -1'], wallets: [null] });
        expect(await createKWallet(svc, 'kdewallet', 'Cipherline', b.exec)).toBe('cancelled');
    });
});
