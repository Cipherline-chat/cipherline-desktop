import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import React, { useState, useCallback } from 'react';
import { RoleEditorPane } from '../src/components/server/roles/RoleEditorPane';
import type { Role } from '../src/components/server/roles/types';
import { DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';

const EVERYONE: Role = {
    role_id: 'everyone', name: '@everyone', color: -1, position: 0,
    permissions: DEFAULT_EVERYONE_PERMISSIONS.toString(10),
    mentionable: false, hoisted: false, is_everyone: true,
};
const MOD: Role = {
    role_id: 'mod', name: 'Moderator', color: 0x25E0C8, position: 5,
    // Role already explicitly holds SEND_MESSAGES (bit 17) + KICK (bit 4)
    permissions: ((1n << 17n) | (1n << 4n)).toString(10),
    mentionable: true, hoisted: false, is_everyone: false,
};

function Harness() {
    const [roles, setRoles] = useState<Role[]>([MOD, EVERYONE]);
    const [sel, setSel] = useState('mod');
    const role = roles.find(r => r.role_id === sel)!;
    const everyonePerms = BigInt(roles.find(r => r.is_everyone)!.permissions);
    const onSaved = useCallback((next: Role) => {
        setRoles(prev => prev.map(r => r.role_id === next.role_id ? next : r));
    }, []);
    return (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: 8, display: 'flex', gap: 8 }}>
                <button id="sel-mod" onClick={() => setSel('mod')}>Moderator</button>
                <button id="sel-everyone" onClick={() => setSel('everyone')}>@everyone</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <RoleEditorPane
                    role={role} serverId="s1" token={null} canManage
                    onSaved={onSaved} onDelete={() => {}} onError={(m) => console.log('ERR', m)}
                    everyonePerms={everyonePerms} onDirtyChange={() => {}}
                />
            </div>
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Harness />);
