/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-ext.css';
import secureLocalStore from '../src/utils/secureLocalStore';
import { GifPlayer } from '../src/components/GifPlayer';
import { bootMotion } from '../src/utils/a11y/motionPrefs';
import { SAMPLE_GIF } from './a11y-motion-sample-gif';

// ?images=always|hover|never  (stored exactly as Settings stores it)
const q = new URLSearchParams(location.search);
const images = q.get('images') ?? 'always';

async function boot() {
    await secureLocalStore.hydrate();
    secureLocalStore.setItem('cipherline_user_id', 'u-me');
    await secureLocalStore.whenAccountReady();
    secureLocalStore.setItem('cipherline_motion_prefs', JSON.stringify({ reduce: 'system', effects: true, images }));
    bootMotion();
    createRoot(document.getElementById('root')!).render(
        <div style={{ padding: 24, width: 560, color: '#F4F7FF', fontFamily: 'Nunito, system-ui, sans-serif' }}>
            <div style={{ display: 'flex', gap: 12 }}>
                <span style={{ flex: 'none', width: 36, height: 36, borderRadius: '50%', background: '#25E0C8', color: '#0B0F1E', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}>M</span>
                <div>
                    <div style={{ fontWeight: 800 }}>Mara <span style={{ fontWeight: 500, color: '#8B94B5', fontSize: 12 }}>Today at 9:41</span></div>
                    <div style={{ margin: '4px 0 8px' }}>Look at this one (Animated images: <b>{images}</b>)</div>
                    <GifPlayer src={SAMPLE_GIF} alt="a ball moving across the frame" imgStyle={{ width: 320, borderRadius: 12 }} />
                </div>
            </div>
        </div>,
    );
    (window as any).__booted = true;
}
boot();
