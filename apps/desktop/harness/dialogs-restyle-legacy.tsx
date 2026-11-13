/* eslint-disable -- visual harness, not shipped */
// Verbatim copies of the INLINE dialogs the dialogs-restyle change removed (they lived inside
// Dashboard.tsx / ChatPane.tsx / ServerSettingsModal.tsx / ServerContextPanel.tsx and cannot be
// imported). Used only for the "before" screenshots; nothing in src/ imports this file.
import React from 'react';
import { AlertCircle, Crown } from 'lucide-react';
import { ClButton, ClModal, ClInput } from '../src/components/cl';

/** Dashboard.tsx — the block-user confirm behind every "Block" menu item (sidebarBlockConfirm). */
export const LegacyBlock: React.FC<{ username: string; onCancel: () => void; onConfirm: () => void }> = ({ username, onCancel, onConfirm }) => (
    <ClModal open onClose={onCancel} width={400} cardStyle={{ padding: '32px' }}>
        <h2 className="text-xl font-bold text-cl-text mt-0 mb-2">Block {username}?</h2>
        <p className="text-sm text-cl-muted mb-6" style={{ lineHeight: 1.5 }}>
            {username} won't be able to send you friend requests or messages. They won't be notified that you blocked them.
        </p>
        <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ flex: 1 }}>
                <ClButton variant="ghost" fullWidth onClick={onCancel}>Cancel</ClButton>
            </div>
            <div style={{ flex: 1 }}>
                <ClButton variant="danger" fullWidth onClick={onConfirm}>Block</ClButton>
            </div>
        </div>
    </ClModal>
);

/** ChatPane.tsx — the local ConfirmDialog (DM header menu: Block User / Remove Friend). */
export const LegacyChatConfirm: React.FC<{ title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }> = ({ title, message, confirmLabel, onCancel, onConfirm }) => (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="bg-cl-deep border border-white/10 rounded-2xl shadow-2xl fade-pop-enter overflow-hidden" style={{ width: '400px', padding: '32px' }}>
            <h2 className="text-xl font-bold text-white mb-2" style={{ marginTop: 0 }}>{title}</h2>
            <p className="text-cl-muted" style={{ fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '24px' }}>{message}</p>
            <div style={{ display: 'flex', gap: '12px' }}>
                <div style={{ flex: 1 }}>
                    <ClButton variant="ghost" fullWidth onClick={onCancel}>Cancel</ClButton>
                </div>
                <div style={{ flex: 1 }}>
                    <ClButton variant="danger" fullWidth onClick={onConfirm}>{confirmLabel}</ClButton>
                </div>
            </div>
        </div>
    </div>
);

/** DevicesPane.tsx — window.confirm() is an OS dialog and cannot be screenshotted; this is a stand-in. */
export const LegacyNativeConfirm: React.FC<{ message: string; onCancel: () => void; onConfirm: () => void }> = ({ message, onCancel, onConfirm }) => (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 70, zIndex: 1000, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
        <div data-shot style={{ width: 420, background: '#f3f3f3', color: '#111', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,.5)', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', fontSize: 13, background: '#fff' }}>cipherline.chat says</div>
            <div style={{ padding: '14px 14px 18px', fontSize: 14, background: '#fff' }}>{message}</div>
            <div style={{ padding: 12, display: 'flex', justifyContent: 'flex-end', gap: 8, background: '#f3f3f3' }}>
                <button onClick={onConfirm} style={{ padding: '6px 22px', background: '#0067c0', color: '#fff', border: 0, borderRadius: 4 }}>OK</button>
                <button onClick={onCancel} style={{ padding: '6px 22px', background: '#fdfdfd', border: '1px solid #ccc', borderRadius: 4 }}>Cancel</button>
            </div>
        </div>
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 12, textAlign: 'center', color: '#8fa0c8', font: '600 12px sans-serif' }}>
            native window.confirm() &mdash; approximation, the real one is drawn by the OS
        </div>
    </div>
);

/** ServerSettingsModal.tsx — Danger Zone → Delete server (showDeleteDialog). */
export const LegacyDeleteServer: React.FC<{ name: string; error?: string; onCancel: () => void }> = ({ name, error, onCancel }) => {
    const [pw, setPw] = React.useState('');
    return (
        <ClModal open onClose={onCancel} width={448} overlayStyle={{ zIndex: 1100 }} cardStyle={{ padding: 0, overflow: 'hidden' }}>
            <div className="px-6 pt-6 pb-4 border-b border-cl-border/40">
                <p className="text-[18px] font-bold text-cl-text mt-0 mb-0">Delete <span className="text-cl-flash">{name}</span>?</p>
                <p className="text-[13px] text-cl-faint mt-1.5 leading-relaxed">
                    This will permanently delete all channels, messages, roles, and members.
                    This action <span className="font-semibold text-cl-muted">cannot be undone</span>.
                </p>
            </div>
            <div className="px-6 py-5 space-y-4">
                <div>
                    <label className="block text-[12px] font-semibold text-cl-faint uppercase tracking-wider mb-2">Enter your password to confirm</label>
                    <ClInput type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Your account password" autoFocus />
                </div>
                {error && (
                    <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-cl-flash/10 border border-cl-flash/25">
                        <AlertCircle size={14} className="text-cl-flash shrink-0" />
                        <p className="text-[13px] text-cl-flash">{error}</p>
                    </div>
                )}
            </div>
            <div className="px-6 pb-6 flex gap-3 justify-end">
                <ClButton variant="ghost" onClick={onCancel}>Cancel</ClButton>
                <ClButton variant="danger" disabled={!pw.trim()}>Delete Server</ClButton>
            </div>
        </ClModal>
    );
};

/** ServerSettingsModal.tsx — Members → Transfer ownership. */
export const LegacyTransfer: React.FC<{ server: string; member: string; onCancel: () => void }> = ({ server, member, onCancel }) => {
    const [pw, setPw] = React.useState('');
    return (
        <ClModal open onClose={onCancel} width={448} overlayStyle={{ zIndex: 1100 }} cardStyle={{ padding: 0, overflow: 'hidden' }}>
            <div className="px-6 pt-6 pb-4 border-b border-cl-border/40">
                <div className="flex items-center gap-2.5 mb-3">
                    <div className="w-8 h-8 rounded-full bg-amber-400/15 flex items-center justify-center">
                        <Crown size={16} className="text-amber-400" />
                    </div>
                    <p className="text-[18px] font-bold text-cl-text mt-0 mb-0">Transfer Ownership</p>
                </div>
                <p className="text-[13px] text-cl-faint leading-relaxed">
                    You are about to transfer ownership of <span className="text-cl-muted font-medium">{server}</span> to{' '}
                    <span className="text-amber-400 font-semibold">{member}</span>.
                </p>
                <p className="text-[13px] text-cl-faint leading-relaxed mt-2">You will become a regular member. Only {member} can transfer it back.</p>
            </div>
            <div className="px-6 py-5 space-y-4">
                <div>
                    <label className="block text-[12px] font-semibold text-cl-faint uppercase tracking-wider mb-2">Enter your password to confirm</label>
                    <ClInput type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Your account password" autoFocus />
                </div>
            </div>
            <div className="px-6 pb-6 flex gap-3 justify-end">
                <ClButton variant="ghost" onClick={onCancel}>Cancel</ClButton>
                <ClButton disabled={!pw.trim()} style={{ background: undefined, color: '#fff' }}>Transfer Ownership</ClButton>
            </div>
        </ClModal>
    );
};

/** ServerContextPanel.tsx — Rename call. */
export const LegacyRename: React.FC<{ name: string; onCancel: () => void }> = ({ name, onCancel }) => {
    const [v, setV] = React.useState(name);
    return (
        <ClModal open onClose={onCancel} width={380} label="Rename call">
            <h3 className="text-[17px]" style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, color: 'var(--cl-text)', margin: 0 }}>Rename call</h3>
            <p className="text-[12.5px] mb-4 mt-1" style={{ color: 'var(--cl-muted)' }}>Everyone in the call sees the new name.</p>
            <ClInput value={v} onChange={e => setV(e.target.value)} maxLength={60} placeholder="Call name" autoFocus />
            <div className="flex justify-end gap-2 mt-5">
                <ClButton variant="ghost" size="sm" onClick={onCancel}>Cancel</ClButton>
                <ClButton size="sm">Rename</ClButton>
            </div>
        </ClModal>
    );
};

/** ServerContextPanel.tsx — Change nickname. */
export const LegacyNickname: React.FC<{ onCancel: () => void }> = ({ onCancel }) => {
    const [v, setV] = React.useState('Alexandrina');
    return (
        <ClModal open onClose={onCancel} width={320} overlayStyle={{ zIndex: 10020 }} label="Change Nickname" cardStyle={{ padding: 20 }} cardClassName="flex flex-col gap-4">
            <div>
                <h3 className="text-[15px] font-bold text-cl-text m-0">Change Nickname</h3>
                <p className="text-[12px] text-cl-faint mt-0.5">Your nickname in this server</p>
            </div>
            <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-cl-faint uppercase tracking-widest">Nickname</label>
                <ClInput autoFocus value={v} onChange={e => setV(e.target.value)} maxLength={32} placeholder="Leave blank to reset to username" />
                <p className="text-[11px] text-cl-faint">Leave blank to reset to account username</p>
            </div>
            <div className="flex gap-2 justify-end">
                <ClButton size="sm" variant="ghost" onClick={onCancel}>Cancel</ClButton>
                <ClButton size="sm">Save</ClButton>
            </div>
        </ClModal>
    );
};
