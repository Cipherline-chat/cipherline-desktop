/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/styles/night-dive.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import secureLocalStore from '../src/utils/secureLocalStore';
import React from 'react';
import { ProfileModal } from '../src/components/ProfileModal';
import { DmProfileCard } from '../src/components/profile/DmProfileCard';

/**
 * Website screenshots of a REAL profile (apps/website "Make it yours" section).
 *
 * Renders the shipped profile surfaces with no props faked beyond the viewer's identity:
 *   ?scene=popout   ProfileModal in its preview-popover mode (what clicking a name opens)
 *   ?scene=full     ProfileModal opened full (the Overview tab)
 *   ?scene=dm       DmProfileCard, the card in a DM's right-hand panel
 * &uid=<user id> is the person shown; &me=<viewer id> is the signed-in viewer.
 *
 * Every byte of profile data comes from the API through the components' own fetches
 * (profile, Steam card, avatar/banner keys + encrypted blobs, decrypted by the app's
 * own AES-GCM path). The capture script answers those requests from a real signed-in
 * session (the harness itself holds no data and no credentials). Mutual friends and
 * servers are answered empty so nobody but the profile's owner appears.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'popout';
const uid = q.get('uid') ?? '';
const me = q.get('me') ?? 'viewer';
const status = (q.get('status') ?? 'online') as any;
const friendStatuses = { [uid]: { status, custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false } } as any;

function Popout() {
    return (
        <div data-testid="stage" style={{ position: 'relative', width: 400, height: 760 }}>
            <ProfileModal userId={uid} token="harness" currentUserId={me} friendStatuses={friendStatuses} isFriend
                onClose={() => {}} onMessage={() => {}} anchor={{ x: 40, y: 24 }} />
        </div>
    );
}

function Full() {
    return (
        <div data-testid="stage" style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            <ProfileModal userId={uid} token="harness" currentUserId={me} friendStatuses={friendStatuses} isFriend
                onClose={() => {}} onMessage={() => {}} startFull startTab={(q.get('tab') ?? 'overview') as any} />
        </div>
    );
}

function Dm() {
    return (
        <div data-testid="stage" className="app-pane4" style={{ width: Number(q.get('w') ?? 320), background: 'var(--cl-surface, #121A33)', borderRadius: 16, padding: '8px 8px 14px' }}>
            <DmProfileCard userId={uid} token="harness" currentUserId={me} status={friendStatuses[uid]} isFriend onOpenFull={() => {}} />
        </div>
    );
}

(async () => {
    try { await secureLocalStore.hydrate(); } catch { /* a cold store is fine for a harness */ }
    createRoot(document.getElementById('root')!).render(scene === 'full' ? <Full /> : scene === 'dm' ? <Dm /> : <Popout />);
})();
