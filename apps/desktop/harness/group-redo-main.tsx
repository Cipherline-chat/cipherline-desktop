/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import React from 'react';
import axios from 'axios';
import { Users } from 'lucide-react';
import { GroupContextHeader } from '../src/components/GroupContextHeader';
import { GroupMembersHeading } from '../src/components/GroupMembersHeading';
import { GroupSettingsModal } from '../src/components/GroupSettingsModal';
import { EncryptedAvatar } from '../src/components/EncryptedAvatar';

/**
 * ?view=ctx|settings
 *   &pic=colorful|bright|none     the group picture (stub ids img-colorful / img-bright)
 *   &stall=1                      the picture never resolves (the "loading" look)
 *   &n=1|3|8                      member count (ctx + settings)
 *   &old=1                        ctx only: the previous markup, for the "before" shot
 */
const q = new URLSearchParams(location.search);
const VIEW = q.get('view') ?? 'ctx';
const PIC = q.get('pic') ?? 'colorful';
const N = Number(q.get('n') ?? '3');
const picId = PIC === 'none' ? null : `img-${PIC}`;
const NAMES = ['Dawson', 'Mira', 'Jun', 'Tobias', 'Sana', 'Okoye', 'Leif', 'Elena'];
const MEMBERS = NAMES.slice(0, N).map((u, i) => ({ user_id: i === 0 ? 'me' : `u-${u.toLowerCase()}`, username: u, avatar_url: null }));

axios.defaults.adapter = async (config: any) => {
    const url = String(config.url);
    if (/\/devices$/.test(url)) return { data: MEMBERS, status: 200, statusText: 'OK', headers: {}, config };
    if (/\/friends$/.test(url)) return { data: { accepted: [] }, status: 200, statusText: 'OK', headers: {}, config };
    if (config.method === 'patch') { ((window as any).__patches ||= []).push(config.data); return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config }; }
    throw new Error('unexpected ' + url);
};

const Panel = () => (
    <div style={{ width: 300, padding: '16px 0', background: 'var(--cl-deep, #131A30)', minHeight: 320 }}>
        <div className="px-2 pt-1 shrink-0">
            {q.get('old') === '1' ? (
                <div className="mb-3.5 text-center" style={{ background: 'var(--cl-surface)', border: '1px solid var(--cl-border)', borderRadius: 14, padding: 16 }}>
                    <div className="font-display" style={{ fontWeight: 600, fontSize: 17, color: 'var(--cl-text)' }}>Sheesh</div>
                    <div className="inline-flex items-center justify-center gap-1.5" style={{ marginTop: 6, color: 'var(--cl-muted)', fontSize: 11.5, fontWeight: 700 }}>
                        <Users size={12} /> {N} members
                    </div>
                </div>
            ) : (
                <GroupContextHeader title="Sheesh" memberCount={N} avatarUrl={picId} token="harness-token" />
            )}
        </div>
        <div className="px-2">
            <GroupMembersHeading count={N} canAdd onAdd={() => {}} />
            <div className="flex flex-col gap-0.5">
                {MEMBERS.slice(0, 3).map(m => (
                    <div key={m.user_id} className="flex items-center gap-3 px-2 py-2 rounded-lg w-full">
                        <div className="relative w-9 h-9 shrink-0 rounded-full overflow-hidden">
                            <EncryptedAvatar attachmentId={null} userId={m.user_id} token="t" className="w-full h-full" fallbackSize={16} bypassFriendGate />
                        </div>
                        <span className="text-sm font-semibold text-cl-text">{m.username}</span>
                    </div>
                ))}
            </div>
        </div>
    </div>
);

createRoot(document.getElementById('root')!).render(
    VIEW === 'settings'
        ? <GroupSettingsModal conversationId="conv-1" conversationTitle="Sheesh" avatarUrl={picId ?? undefined} onClose={() => {}} onGroupLeft={() => {}} />
        : <Panel />,
);
