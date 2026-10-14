/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import React, { useState } from 'react';
import axios from 'axios';
import { GroupMembersHeading } from '../src/components/GroupMembersHeading';
import { AddGroupMembersModal } from '../src/components/AddGroupMembersModal';
import { EncryptedAvatar } from '../src/components/EncryptedAvatar';

/**
 * Query: ?view=panel|modal   (panel = the right-hand panel's Members block; modal = the open modal)
 *        &can=0              hide the + (a user who may not add)
 *
 * The heading and modal are the app's own components; the only fakes are the network (axios
 * adapter) and useAuth (vite alias -> group-add-auth-stub.ts).
 */
const q = new URLSearchParams(location.search);
const VIEW = q.get('view') ?? 'panel';
const CAN = q.get('can') !== '0';

const MEMBERS = [
    { user_id: 'me', username: 'Dawson' },
    { user_id: 'u-mira', username: 'Mira' },
    { user_id: 'u-jun', username: 'Jun' },
];
const FRIENDS = [
    { user_id: 'u-mira', username: 'Mira', avatar_url: null },
    { user_id: 'u-jun', username: 'Jun', avatar_url: null },
    { user_id: 'u-tobias', username: 'Tobias', avatar_url: null },
    { user_id: 'u-sana', username: 'Sana', avatar_url: null },
    { user_id: 'u-okoye', username: 'Okoye', avatar_url: null },
    { user_id: 'u-leif', username: 'Leif', avatar_url: null },
];

(window as any).__posts = [] as string[];
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url);
    if (/\/friends$/.test(url)) return { data: { accepted: FRIENDS }, status: 200, statusText: 'OK', headers: {}, config };
    if (/\/invite$/.test(url)) {
        (window as any).__posts.push(url + ' ' + String(config.data));
        return { data: { ok: true }, status: 201, statusText: 'Created', headers: {}, config };
    }
    throw new Error('unexpected ' + url);
};

const H = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--cl-faint)', padding: '2px 2px 8px' }}>{children}</div>
);

const Panel = () => {
    const [open, setOpen] = useState(VIEW === 'modal');
    return (
        <div style={{ width: 300, padding: '16px 0', background: 'var(--cl-deep, #0B0F1E)', minHeight: 360 }}>
            <div className="px-2 mb-5"><H>Shared</H>
                <div className="text-xs" style={{ color: 'var(--cl-faint)', padding: '0 2px' }}>No shared media yet</div>
            </div>
            <div className="mb-5 px-2" id="members-block">
                <GroupMembersHeading count={MEMBERS.length} canAdd={CAN} onAdd={() => setOpen(true)} />
                <div className="flex flex-col gap-0.5">
                    {MEMBERS.map(m => (
                        <div key={m.user_id} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors w-full">
                            <div className="relative w-9 h-9 shrink-0">
                                <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden">
                                    <EncryptedAvatar attachmentId={null} userId={m.user_id} token="t" className="w-full h-full" fallbackSize={16} bypassFriendGate />
                                </div>
                            </div>
                            <span className="text-sm font-semibold text-cl-text">{m.username}</span>
                        </div>
                    ))}
                </div>
            </div>
            {open && (
                <AddGroupMembersModal
                    conversationId="conv-1"
                    conversationTitle="Weekend Crew"
                    memberIds={MEMBERS.map(m => m.user_id)}
                    onClose={() => setOpen(false)}
                    onAdded={() => {}}
                />
            )}
        </div>
    );
};

createRoot(document.getElementById('root')!).render(<Panel />);
