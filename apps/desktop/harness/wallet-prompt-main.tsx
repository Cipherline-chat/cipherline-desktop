/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import { ClBannerStack } from '../src/components/ClBanner';
import StorageLockedScreen from '../src/components/StorageLockedScreen';
import { KeyringWalletBanner } from '../src/components/KeyringWalletBanner';

/**
 * ?scene=existing   the "Cipherline couldn't open your wallet" screen, keys already stored (KDE Wallet)
 * ?scene=first      same, first run (nothing lost yet)
 * ?scene=gnome      existing keys, GNOME Keyring
 * ?scene=recovery   existing keys, "Use my recovery key" expanded
 * ?scene=generic    the generic locked screen (not a wallet problem): unchanged, still has Start fresh
 * ?scene=banner     the "Unlock wallet" banner in the Dashboard banner stack
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'existing';
const status = (over: Record<string, unknown>) => ({ state: 'denied', walletName: 'KDE Wallet', firstRun: false, degraded: false, ...over });
const byScene: Record<string, unknown> = {
    existing: status({}),
    first: status({ firstRun: true }),
    gnome: status({ walletName: 'GNOME Keyring' }),
    recovery: status({}),
    generic: { state: 'not-applicable', walletName: null, firstRun: false, degraded: false },
    banner: status({ degraded: true }),
};
(window as any).__retried = 0;
(window as any).electronAPI = {
    getKeyringStatus: async () => byScene[scene],
    retryKeyringUnlock: async () => { (window as any).__retried++; return new Promise(() => {}); },
    recoverWithKey: async () => false,
    factoryResetSecureStore: async () => false,
};

const App = () => scene === 'banner'
    ? (
        <div style={{ minHeight: '100vh', background: 'var(--cl-abyss)' }}>
            <div style={{ height: 36, background: 'var(--cl-deep)', borderBottom: '1px solid var(--cl-border)', color: 'var(--cl-faint)', fontSize: 12, display: 'flex', alignItems: 'center', padding: '0 14px' }}>Cipherline</div>
            <ClBannerStack><KeyringWalletBanner /></ClBannerStack>
        </div>
    )
    : <StorageLockedScreen />;

createRoot(document.getElementById('root')!).render(<App />);
