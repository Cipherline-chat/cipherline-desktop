/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import ScreenLockSettings from '../src/components/ScreenLockSettings';
import { useScreenLock } from '../src/hooks/useScreenLock';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { NotificationProvider, useNotificationPrefs } from '../src/contexts/NotificationContext';

/**
 * REAL Screen Lock settings card + REAL notification prefs. `?preview=hidden|sender_only`
 * seeds the preview setting (default 'full'). The readout under the card is the same
 * context NotificationsTab's "Message preview" select reads.
 */
const seed = new URLSearchParams(location.search).get('preview');
const Page = () => {
    const screenLock = useScreenLock();
    const { prefs, updatePrefs } = useNotificationPrefs();
    React.useEffect(() => { if (seed) updatePrefs({ show_preview: seed as any }); }, []);
    return (
        <div className="sd-root sd-arrived" style={{ width: 640, margin: '40px auto' }}>
            <ScreenLockSettings screenLock={screenLock} keybinds={{ binds: {} } as any} />
            <p id="readout" style={{ color: '#9fb0d0', font: '12px monospace', marginTop: 12 }}>show_preview = {prefs.show_preview}</p>
        </div>
    );
};

(async () => {
    await secureLocalStore.hydrate();   // main.tsx does this before render in the app
    createRoot(document.getElementById('root')!).render(<NotificationProvider><Page /></NotificationProvider>);
})();
