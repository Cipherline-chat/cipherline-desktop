/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import axios from 'axios';
import { ServerSettingsModal } from '../src/components/server/ServerSettingsModal';

/**
 * Server Settings → Overview: the REAL settings dock, to check the banner preview's shape.
 *   banner=1   the server already has a banner (a 1200x480 edge-labelled test card, server-banner-avatar-stub)
 *   (default)  no banner; the shots script uploads one through the real cropper
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const hasBanner = q.get('banner') === '1';
(window as any).electronAPI = { platform: 'windows' };
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    const ok = (data: any) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    ((window as any).__http ||= []).push([config.method, url]);
    if (/\/channels$|\/members$|\/roles$|\/emojis$|\/bans$/.test(url)) return ok([]);
    return ok({});
};
const SERVER: any = {
    server_id: 's-1', name: 'Game night', description: 'Weekly board games.',
    icon_attachment: 'img-elena', icon_key_b64: 'k', icon_nonce_b64: 'n',
    banner_attachment: hasBanner ? 'banner-1' : null, banner_key_b64: hasBanner ? 'k' : null, banner_nonce_b64: hasBanner ? 'n' : null,
    owner_user_id: 'me', created_at: new Date().toISOString(), default_notification_level: 'all', system_channel_id: null,
};
createRoot(document.getElementById('root')!).render(
    <ServerSettingsModal server={SERVER} token="t" userId="me" myPermissions={(1n << 40n) - 1n}
        onClose={() => {}} onServerUpdated={() => {}} tabRequest={{ tab: 'overview', nonce: 1 }} />,
);
