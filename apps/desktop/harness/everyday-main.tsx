/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useEffect, useState } from 'react';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import { loadWebFonts } from '../src/utils/webFonts';
import { ToastProvider } from '../src/contexts/ToastContext';
import { AppLoadingScreen } from '../src/components/AppLoadingScreen';
import { ReactionPill } from '../src/components/ChatPane';
import { ShortcutsSheetHost } from '../src/components/ShortcutsSheet';
import { WhatsNewDialog, WhatsNewHost } from '../src/components/WhatsNewDialog';
import { BackOnlineHost } from '../src/components/BackOnlineHost';
import { TitleBarWordmark } from '../src/components/TitleBarWordmark';
import { useKeybinds } from '../src/hooks/useKeybinds';
import { typingLabel } from '../src/utils/typingLabel';
import whatsNewData from 'virtual:whats-new';

/**
 * Everything in the "everyday touches" set that can be seen without a call.
 *   ?scene=loading                 the real loading screen (tips rotate every 3 s)
 *   ?scene=typing                  the typing line for 1, 2, 3, 4, 7, 8 people and a full small room
 *   ?scene=reaction                a real ReactionPill; window.__setCount(n)
 *   ?scene=shortcuts               press ? (the real host) or window.__open()
 *   ?scene=whatsnew                the real dialog with the CHANGELOG [Unreleased] draft
 *   ?scene=backonline              the real host; window.__online(bool), window.__jump(ms) skews Date.now
 *   ?scene=titlebar                the real title-bar wordmark in a 34px drag-region bar
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'loading';

// A clock we can skip forward (Back online needs "two minutes offline").
let skew = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + skew;
(window as any).__jump = (ms: number) => { skew += ms; };

const noop = () => {};
const Scene: React.FC = () => {
    if (scene === 'loading') return <AppLoadingScreen stage="sync" progress={0.4} />;

    if (scene === 'typing') {
        const names = (n: number) => Array.from({ length: n }, (_, i) => ['Mira', 'Jun', 'Sana', 'Okoye', 'Priya', 'Tomas', 'Lena', 'Ade'][i % 8]);
        const rows: Array<[string, string]> = [
            ['1 typing', typingLabel(names(1))],
            ['2 typing', typingLabel(names(2))],
            ['3 typing', typingLabel(names(3))],
            ['4 typing, big server', typingLabel(names(4), 40)],
            ['7 typing, big server', typingLabel(names(7), 40)],
            ['8 typing', typingLabel(names(8), 40)],
            ['all 5 of a 5-person channel', typingLabel(names(5), 5)],
        ];
        return (
            <div style={{ padding: 28, display: 'grid', gap: 14, width: 560 }}>
                {rows.map(([k, label]) => (
                    <div key={k} data-row={k}>
                        <div style={{ fontSize: 11, color: '#6B7799', marginBottom: 2 }}>{k}</div>
                        {/* the same classes ChatPane gives the line */}
                        <div className="text-[12px] text-cl-muted mb-2 italic pl-4 font-medium h-4 truncate">{label}</div>
                    </div>
                ))}
            </div>
        );
    }

    if (scene === 'reaction') {
        const Demo = () => {
            const [count, setCount] = useState(Number(q.get('start') ?? 9));
            useEffect(() => { (window as any).__setCount = setCount; }, []);
            return (
                <div style={{ padding: 60 }}>
                    <ReactionPill emoji={'\u{1F389}'} animKey="m1:party" msgId="m1" count={count} hasMine={false} canReact
                        resolveEmoji={undefined} token={null} onClick={noop} onHoverStart={noop} onHoverEnd={noop} onContextMenuShow={noop} />
                </div>
            );
        };
        return <Demo />;
    }

    if (scene === 'shortcuts') {
        const Demo = () => {
            const keybinds = useKeybinds({});
            return (
                <div style={{ padding: 40, color: '#8892B0', fontFamily: 'Nunito, sans-serif' }}>
                    Press <b>?</b> (not in a text box).
                    <input data-testid="field" placeholder="typing here does not open it" style={{ marginLeft: 12, padding: 6 }} />
                    <ShortcutsSheetHost keybinds={keybinds} pushToTalkKey={q.get('ptt')} />
                </div>
            );
        };
        return <ToastProvider><Demo /></ToastProvider>;
    }

    if (scene === 'whatsnew') {
        const notes = whatsNewData.unreleased ?? Object.values(whatsNewData.releases)[0];
        return <WhatsNewDialog notes={{ ...notes, version: q.get('version') ?? '1.0.23', date: '2026-10-20' }} onClose={noop} />;
    }

    if (scene === 'backonline') {
        const Demo = () => {
            const [online, setOnline] = useState(true);
            useEffect(() => { (window as any).__online = setOnline; }, []);
            return (
                <ToastProvider>
                    <div style={{ padding: 40, color: '#8892B0', fontFamily: 'Nunito, sans-serif' }}>The app. Connection: {online ? 'online' : 'offline'}</div>
                    <BackOnlineHost isOnline={online} />
                </ToastProvider>
            );
        };
        return <Demo />;
    }

    if (scene === 'titlebar') {
        return (
            <div style={{ width: '100vw', height: '100vh', background: '#0B0F1E' }}>
                <div className="drag-region h-[34px] w-full shrink-0 flex items-center px-3 bg-cl-abyss" style={{ borderBottom: '1px solid #1E2848' }}>
                    <TitleBarWordmark />
                </div>
                <div style={{ padding: 30, color: '#8892B0', fontFamily: 'Nunito, sans-serif' }}>The app, below the title bar.</div>
            </div>
        );
    }
    return <div>unknown scene</div>;
};

createRoot(document.getElementById('root')!).render(<Scene />);
