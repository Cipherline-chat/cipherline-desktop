import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    isWalletRefused, normalizeKeyringStatus, safeWalletName, walletBannerCopy, walletScreenCopy,
    type KeyringStatus,
} from './walletPrompt';

const kde = (over: Partial<KeyringStatus> = {}): KeyringStatus => ({ state: 'denied', walletName: 'KDE Wallet', firstRun: false, degraded: false, ...over });

describe('normalizeKeyringStatus: whatever crosses the bridge is validated', () => {
    it('accepts the main-process shape', () => {
        expect(normalizeKeyringStatus({ state: 'denied', walletName: 'KDE Wallet', firstRun: true, degraded: false }))
            .toEqual({ state: 'denied', walletName: 'KDE Wallet', firstRun: true, degraded: false });
        expect(normalizeKeyringStatus({ state: 'not-applicable', walletName: null, firstRun: false, degraded: false }))
            .toEqual({ state: 'not-applicable', walletName: null, firstRun: false, degraded: false });
    });

    it('NEGATIVE CONTROLS: junk is "no wallet problem", never a wallet screen', () => {
        for (const bad of [undefined, null, 1, 'denied', [], {}, { state: 'DENIED' }, { state: 'locked' }, { state: 1 }]) {
            expect(normalizeKeyringStatus(bad)).toBeNull();
        }
        expect(isWalletRefused(null)).toBe(false);
    });

    it('flags are strict booleans (truthy strings do not turn the banner on)', () => {
        const s = normalizeKeyringStatus({ state: 'denied', walletName: 'KDE Wallet', firstRun: 'true', degraded: 1 })!;
        expect(s.firstRun).toBe(false);
        expect(s.degraded).toBe(false);
    });

    it('only known wallet names are ever shown (the name crosses IPC)', () => {
        expect(safeWalletName('GNOME Keyring')).toBe('GNOME Keyring');
        expect(safeWalletName('<img src=x onerror=alert(1)>')).toBe('system wallet');
        expect(normalizeKeyringStatus({ state: 'denied', walletName: 'Evil Wallet', firstRun: false, degraded: false })!.walletName).toBe('system wallet');
    });

    it('only a refused wallet is the wallet screen', () => {
        expect(isWalletRefused(kde())).toBe(true);
        for (const state of ['unlocked', 'no-service', 'not-applicable'] as const) expect(isWalletRefused(kde({ state }))).toBe(false);
    });
});

describe('screen copy: existing keys vs first run', () => {
    it('existing keys: says what it means and that without the wallet they would be lost, and that nothing was deleted', () => {
        const c = walletScreenCopy(kde());
        expect(c.title).toBe('Cipherline couldn’t open your wallet');
        expect(c.body).toContain('KDE Wallet');
        expect(c.consequence).toContain('already on this device can’t be opened');
        expect(c.consequence).toContain('would be lost');
        expect(c.consequence).toContain('Nothing has been changed or deleted');
        expect(c.tryAgain).toBe('Try again');
        expect(c.useRecoveryKey).toBe('Use my recovery key');
    });

    it('first run: nothing is lost yet, but keys created now would not be protected', () => {
        const c = walletScreenCopy(kde({ firstRun: true }));
        expect(c.consequence).toContain('Nothing has been saved on this device yet');
        expect(c.consequence).toContain('nothing is lost');
        expect(c.consequence).toContain('wouldn’t be protected');
        expect(c.consequence).not.toContain('would be lost');
    });

    it('names the right wallet', () => {
        expect(walletScreenCopy(kde({ walletName: 'GNOME Keyring' })).body).toContain('GNOME Keyring');
        expect(walletScreenCopy(kde({ walletName: 'GNOME Keyring' })).body).not.toContain('KDE');
    });
});

describe('banner copy', () => {
    it('warns, names the wallet, and offers Unlock wallet; dismissal is for this launch only', () => {
        const c = walletBannerCopy(kde({ degraded: true }));
        expect(c.title).toBe('KDE Wallet is locked');
        expect(c.action).toBe('Unlock wallet');
        expect(c.dismiss).toBe('Dismiss until next launch');
        expect(c.description).toContain('this session');
    });
});

describe('wiring (source scan: components are not rendered under vitest)', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'components', f), 'utf8');

    it('StorageLockedScreen shows the wallet view only for a refused wallet and waits for the answer', () => {
        const s = src('StorageLockedScreen.tsx');
        expect(s).toContain('getKeyringStatus');
        expect(s).toContain('if (wallet === undefined) return null;');
        expect(s).toContain('if (isWalletRefused(wallet)) return <WalletLockedView status={wallet} />;');
    });

    it('the wallet view has Try again + recovery key, and NO "Start fresh" / erase', () => {
        const s = src('WalletLockedView.tsx').replace(/\/\*[\s\S]*?\*\//g, ''); // code, not the doc comment that explains why
        expect(s).toContain('retryKeyringUnlock');
        expect(s).toContain('copy.tryAgain');
        expect(s).toContain('copy.useRecoveryKey');
        expect(s).not.toMatch(/Start fresh|factoryReset|wipeLocalData|Erase/);
    });

    it('the Dashboard mounts the banner inside the banner stack, next to the other key notices', () => {
        const d = fs.readFileSync(path.join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
        expect(d).toContain("import { KeyringWalletBanner } from './KeyringWalletBanner';");
        const stackEnd = d.indexOf('</ClBannerStack>', d.indexOf('<EncryptionAtRestNotice />'));
        const at = d.indexOf('<KeyringWalletBanner />');
        expect(at).toBeGreaterThan(d.indexOf('<EncryptionAtRestNotice />'));
        expect(at).toBeLessThan(stackEnd);
    });

    it('the banner is a warning, dismissible for the session only, with an Unlock action and no persistence', () => {
        const b = src('KeyringWalletBanner.tsx');
        expect(b).toContain('tone="warning"');
        expect(b).toContain('copy.action');
        expect(b).toContain('setDismissed(true)');
        expect(b).not.toMatch(/localStorage|secureLocalStore|ackKeyProtection/);
    });
});

describe('auto-retry note', () => {
    it('is shown only when the main process reports it is watching the wallet', async () => {
        const { walletScreenCopy, normalizeKeyringStatus } = await import('./walletPrompt');
        const base = { state: 'denied', walletName: 'KDE Wallet', firstRun: false, degraded: false };
        expect(walletScreenCopy(normalizeKeyringStatus({ ...base, watching: true })!).autoRetryNote).toMatch(/reopens on its own/);
        expect(walletScreenCopy(normalizeKeyringStatus(base)!).autoRetryNote).toBeNull();
        expect(normalizeKeyringStatus({ ...base, watching: 'yes' })).toEqual(normalizeKeyringStatus(base));
    });
});
