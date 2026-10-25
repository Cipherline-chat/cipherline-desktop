/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React, { useState } from 'react';
import { ConfirmDialog } from '../src/components/primitives/ConfirmDialog';
import { EncryptedAvatar } from '../src/components/EncryptedAvatar';

/**
 * Kick / ban dialogs over a dimmed, app-like backdrop. Renders MemberActionDialog when the
 * working tree has it (the "after" build), otherwise the ConfirmDialog ServerContextPanel used
 * to open for these two actions, with the exact title/message/label it passed (the "before").
 *
 * Query: d = kick | ban     s = long   (a long display name + server name)
 * window.__confirmed counts onConfirm calls; window.__closed counts onClose/onCancel.
 */
loadWebFonts();

const mods = import.meta.glob('../src/components/server/MemberActionDialog.tsx', { eager: true }) as Record<string, any>;
const MemberActionDialog = (new URLSearchParams(location.search).get('old') === '1' ? undefined : Object.values(mods)[0]?.MemberActionDialog) as React.FC<any> | undefined;

const q = new URLSearchParams(location.search);
const D = (q.get('d') ?? 'kick') as 'kick' | 'ban';
const LONG = q.get('s') === 'long';
const NAME = LONG ? 'Alexandrina the Magnificent of Westmarch' : 'Alex';
const SERVER = LONG ? 'Thursday Night Strategy Game Society (EU)' : 'Game night';
(window as any).__confirmed = 0;
(window as any).__closed = 0;

const Backdrop = () => (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Nunito, sans-serif', color: '#F4F7FF' }}>
        <div style={{ width: 72, background: '#070A15', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 14 }}>
            {['#25E0C8', '#243056', '#243056', '#243056'].map((c, i) => (
                <div key={i} style={{ width: 46, height: 46, borderRadius: i === 0 ? 16 : 23, background: c }} />
            ))}
        </div>
        <div style={{ width: 268, background: '#0F1528', borderRight: '1px solid #1E2848', padding: '16px 10px' }}>
            <div style={{ height: 36, borderRadius: 10, background: '#1C2542', marginBottom: 18, padding: '8px 12px', fontWeight: 800 }}>{SERVER}</div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', color: '#5E6B8F', textTransform: 'uppercase', padding: '0 8px 8px' }}>Members — 4</div>
            {[['Mira', 'img-mira'], ['Jun', 'img-jun'], [NAME, 'img-sana'], ['Priya', 'img-elena']].map(([n, av]) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px', borderRadius: 12, background: n === NAME ? '#1C2542' : undefined }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', overflow: 'hidden', flex: 'none' }}><EncryptedAvatar attachmentId={av} userId={'u-' + n} token="t" className="w-full h-full" disableClickProfile /></div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#A7B3D4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n}</div>
                </div>
            ))}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#0B0F1E' }}>
            <div style={{ height: 56, borderBottom: '1px solid #1E2848', display: 'flex', alignItems: 'center', padding: '0 20px', fontFamily: 'Fredoka, sans-serif', fontWeight: 600, fontSize: 16 }}># general</div>
            <div style={{ flex: 1, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
                {[['Mira', 'who is up for a round tonight?', 'img-mira'], [NAME, 'count me in', 'img-sana'], ['Jun', 'same, 9pm?', 'img-jun']].map(([who, text, av], i) => (
                    <div key={i} style={{ display: 'flex', gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', overflow: 'hidden', flex: 'none' }}><EncryptedAvatar attachmentId={av} userId={'u-' + who} token="t" className="w-full h-full" disableClickProfile /></div>
                        <div><div style={{ fontWeight: 800, fontSize: 14 }}>{who}</div><div style={{ color: '#A7B3D4', fontSize: 14 }}>{text}</div></div>
                    </div>
                ))}
            </div>
        </div>
    </div>
);

const App = () => {
    const [open, setOpen] = useState(true);
    const onConfirm = () => { (window as any).__confirmed++; };
    const onClose = () => { (window as any).__closed++; setOpen(false); };
    const old = {
        kick: { title: `Kick ${NAME}?`, message: `${NAME} will be removed from the server but can rejoin with an invite.`, confirmLabel: 'Kick' },
        ban: { title: `Ban ${NAME}?`, message: `${NAME} will be permanently banned and cannot rejoin unless unbanned.`, confirmLabel: 'Ban' },
    }[D];
    return (
        <>
            <Backdrop />
            {open && (MemberActionDialog
                ? <MemberActionDialog kind={D} serverName={SERVER} memberId="u-alex" memberName={NAME} avatarUrl="img-sana" token="t" onConfirm={onConfirm} onClose={onClose} />
                : <ConfirmDialog {...old} onConfirm={() => { onConfirm(); setOpen(false); }} onCancel={onClose} />)}
            {!open && <button id="reopen" onClick={() => setOpen(true)} style={{ position: 'fixed', top: 8, right: 8 }}>reopen</button>}
        </>
    );
};

createRoot(document.getElementById('root')!).render(<App />);
