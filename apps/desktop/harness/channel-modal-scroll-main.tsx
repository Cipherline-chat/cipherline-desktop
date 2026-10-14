/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import React from 'react';
import axios from 'axios';
import { ChannelSettingsDialog } from '../src/components/server/ChannelSettingsDialog';
import { CategoryFormDialog } from '../src/components/server/CategoryFormDialog';

/**
 * Renders the REAL ChannelSettingsDialog / CategoryFormDialog with a stubbed network.
 *
 * Query: ?dlg=call-edit (default)  Calls channel, edit      ?dlg=text-edit  text channel, edit
 *        ?dlg=call-create          create a Calls channel   ?dlg=cat-edit   category, edit
 *        &tab=permissions          open on the Permissions tab (channel dialog)
 */
const q = new URLSearchParams(location.search);
const dlg = q.get('dlg') ?? 'call-edit';
const tab = q.get('tab');

const roles = [
    { role_id: 'r-admin', name: 'Admin', color: 0xff7a59, position: 3, permissions: '0', mentionable: true, hoisted: true, is_everyone: false },
    { role_id: 'r-mod', name: 'Moderator', color: 0x59c2ff, position: 2, permissions: '0', mentionable: true, hoisted: true, is_everyone: false },
    { role_id: 'r-mem', name: 'Member', color: -1, position: 1, permissions: '0', mentionable: true, hoisted: false, is_everyone: false },
    { role_id: 'r-ev', name: '@everyone', color: -1, position: 0, permissions: '3', mentionable: false, hoisted: false, is_everyone: true },
];
const members = [
    { user_id: 'me', username: 'Dawson', nickname: null, role_ids: ['r-admin'], muted_until: null },
    { user_id: 'u2', username: 'Mira', nickname: null, role_ids: ['r-mod'], muted_until: null },
    { user_id: 'u3', username: 'Kenji', nickname: null, role_ids: ['r-mem'], muted_until: null },
];

// Every request the dialogs make is answered locally; nothing leaves the page.
axios.defaults.adapter = async (config: any) => {
    const url: string = config.url ?? '';
    let data: unknown = [];
    if (/\/roles$/.test(url)) data = roles;
    else if (/\/members$/.test(url)) data = members;
    else if (/\/me\/permissions$/.test(url)) data = { permissions: '1099511627775' };
    else if (/\/overrides$/.test(url)) data = [];
    return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

const categories: any[] = [
    { category_id: 'cat-t', server_id: 'S1', name: 'Text channels', position: 0, kind: 'text', icon_name: null },
    { category_id: 'cat-h', server_id: 'S1', name: 'Voice lounges', position: 0, kind: 'huddle', icon_name: null },
];
const callCh: any = {
    channel_id: 'ch-call', server_id: 'S1', kind: 'huddle', name: 'game-night', topic: null, icon_emoji: null, icon_name: 'Volume2',
    position: 0, parent_category_id: 'cat-h', active_call_session_id: null, member_limit: 10, max_calls: 2,
};
const textCh: any = { ...callCh, channel_id: 'ch-text', kind: 'text', name: 'general', topic: 'Anything goes.', icon_name: null, parent_category_id: 'cat-t' };
const channels: any[] = [callCh, textCh];

const common = { serverId: 'S1', token: 'harness-token', ownerUserId: 'me', currentUserId: 'me', myPermissions: 1099511627775n };
const noop = () => {};

function App() {
    if (dlg === 'cat-edit') {
        return <CategoryFormDialog {...common} category={categories[1]} kind="huddle" categories={categories} channels={channels}
            onClose={noop} onSaved={noop} onDelete={noop} initialTab={tab === 'permissions' ? 'permissions' : undefined} />;
    }
    const isCall = dlg.startsWith('call');
    const create = dlg.endsWith('create');
    return <ChannelSettingsDialog {...common} channel={create ? null : isCall ? callCh : textCh} defaultKind={isCall ? 'huddle' : 'text'}
        categories={categories} channels={channels} canManage onClose={noop} onSaved={noop} onDelete={noop} onCreated={noop}
        onCreatedKeepOpen={noop} />;
}

createRoot(document.getElementById('root')!).render(<App />);
(window as any).__ready = true;
