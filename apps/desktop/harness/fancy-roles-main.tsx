/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/theme-light-kit.css';
import '../src/styles/layout-drift.css';
import '../src/styles/theme-light.css';
import { loadWebFonts } from '../src/utils/webFonts';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import { ToastProvider } from '../src/contexts/ToastContext';
import { RolesTabContainer } from '../src/components/server/roles/RolesTabContainer';
import { CreateServerModal } from '../src/components/server/CreateServerModal';
import { DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';

/**
 * Server Settings -> Roles with decorative role names (the real RolesTabContainer),
 * or the Create a Server dialog (?scene=create).
 *   ?theme=dark|light   ?scene=roles|create
 * Shot by harness/fancy-names-shots.mjs.
 */
const q = new URLSearchParams(location.search);
const themeParam = q.get('theme') ?? 'dark';
const setPref = (engine as any).setThemePreference as undefined | ((p: string, host: object) => Promise<void>);
if (setPref) void setPref(themeParam, {}); else engine.applyTheme(themes.resolveTheme(themeParam));

const roles = [
  { role_id: 'ev', name: '@everyone', position: 0, is_everyone: true, hoisted: false, mentionable: false, color: -1, permissions: DEFAULT_EVERYONE_PERMISSIONS.toString() },
  { role_id: 'r1', name: '『 𝓐𝓮𝓼𝓽𝓱𝓮𝓽𝓲𝓬 』', position: 5, is_everyone: false, hoisted: true, mentionable: true, color: 0x25e0c8, permissions: '0' },
  { role_id: 'r2', name: '🌙✨ ᴀʀᴛɪꜱᴛꜱ ♡', position: 4, is_everyone: false, hoisted: true, mentionable: true, color: 0xa78bfa, permissions: '0' },
  { role_id: 'r3', name: '꒰ Night Owls ꒱ ˚ ₊ ‧', position: 3, is_everyone: false, hoisted: false, mentionable: true, color: 0xec4899, permissions: '0' },
];
axios.defaults.adapter = (config: any) => {
  const url = String(config.url ?? '').replace(/^.*\/v1/, '');
  let data: any = [];
  if (/\/servers\/s1\/roles$/.test(url)) data = roles;
  return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config });
};
const SERVER: any = { server_id: 's1', name: '✦ ꒰ Moonlit Café ꒱ ✦', owner_user_id: 'me', description: null };

loadWebFonts();
const App = () => q.get('scene') === 'create'
  ? <CreateServerModal onClose={() => {}} onCreateServer={async () => {}} initialMode="scratch" />
  : (
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto', color: 'var(--cl-text)' }}>
      <RolesTabContainer server={SERVER} token="harness" canManage={true} />
    </div>
  );
createRoot(document.getElementById('root')!).render(<ToastProvider><App /></ToastProvider>);
setTimeout(() => { (window as any).__booted = true; }, 600);
