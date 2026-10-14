/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import React, { useEffect, useState } from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import { AppLoadingScreen } from '../src/components/AppLoadingScreen';
import { HydrationGate } from '../src/components/HydrationGate';
import ScreenLockOverlay from '../src/components/ScreenLockOverlay';
import { HydrationProvider, useHydration } from '../src/contexts/HydrationContext';
import { useScreenLock } from '../src/hooks/useScreenLock';
import { secureLocalStore } from '../src/utils/secureLocalStore';

/**
 * The cold-start order with Screen Lock on, in the app's own shape:
 *   1. App.tsx's loading screen (auth restoring)  — "initializing"
 *   2. <Dashboard> (stand-in: the real useScreenLock + ScreenLockOverlay, plus
 *      a block of "decrypted" content) mounted BEFORE <HydrationGate>, siblings
 *      under .app-container, exactly as App.tsx lays them out.
 *
 * window.__lb: { settleAll(), lockNow(), phase, isLocked } for the driver.
 * Query: ?lock=0 starts with Screen Lock off; ?init=<ms> = how long step 1 lasts.
 */
const lb: any = { phase: 'initializing', settleAll: () => {}, lockNow: () => {}, isLocked: false };
(window as any).__lb = lb;

const Dashboard = () => {
    const screenLock = useScreenLock();
    lb.lockNow = screenLock.lockNow;
    lb.isLocked = screenLock.isLocked;
    return (<>
        <div data-layout="drift" className="w-screen h-screen flex flex-col bg-cl-abyss text-white overflow-hidden font-sans relative">
            {screenLock.isLocked && <ScreenLockOverlay screenLock={screenLock} />}
            <div id="app-content" style={{ padding: 60 }}>
                <h1 style={{ fontSize: 28 }}>SECRET-DM-CONTENT: meet at 9, bring the keys</h1>
                <p>Decrypted message preview that must never be visible behind the lock.</p>
                <textarea id="composer" data-chat-input placeholder="Message" style={{ color: '#000' }} />
                <button id="send">Send</button>
            </div>
        </div>
        {createPortal(<div id="portal-modal"><button id="portal-ok">Portal button</button></div>, document.body)}
    </>);
};

const Settle = () => {
    const h = useHydration();
    lb.settleAll = () => { h.markSettled('conversations'); h.markSettled('friends'); h.markSettled('servers'); };
    return null;
};

const Shell = () => {
    const [phase, setPhase] = useState<'initializing' | 'app'>('initializing');
    lb.phase = phase;
    useEffect(() => {
        const t = setTimeout(() => setPhase('app'), Number(new URLSearchParams(location.search).get('init') ?? 1200));
        return () => clearTimeout(t);
    }, []);
    if (phase === 'initializing') return <AppLoadingScreen />;
    return (
        <HydrationProvider>
            <Settle />
            <div className="app-container">
                <Dashboard />
                <HydrationGate />
            </div>
        </HydrationProvider>
    );
};

(async () => {
    await secureLocalStore.hydrate();
    if (new URLSearchParams(location.search).get('lock') !== '0') {
        secureLocalStore.setItem('cipherline_screenlock_settings', JSON.stringify({
            enabled: true, timeoutMinutes: 5, lockOnOsLock: true, pinLength: 4,
            verifier: { saltB64: 'AAAAAAAAAAAAAAAAAAAAAA==', ivB64: 'AAAAAAAAAAAAAAAA', ctB64: 'AAAA', iterations: 1000 },
        }));
    }
    createRoot(document.getElementById('root')!).render(<Shell />);
})();
