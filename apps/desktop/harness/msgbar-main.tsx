/* eslint-disable -- visual/geometry harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import React, { useRef, useState } from 'react';
import { SmilePlus, Reply, Pin, Archive, Save, Edit2, Trash2 } from 'lucide-react';
import { MsgBarBtn } from '../src/components/primitives/MsgBarBtn';
import { MsgActionBar } from '../src/components/primitives/MsgActionBar';

/**
 * Mock feed whose ROW MARKUP mirrors ChatPane's message row (same class strings
 * for the row, avatar gutter, content column, header line, text body) and whose
 * hover/focus handlers are the same shape (160 ms enter, 200 ms leave grace,
 * focus pins it, blur releases). The bar is the REAL MsgActionBar + MsgBarBtn.
 *
 * Query: ?old=1   -> the original placement (absolute -top-11 right-14, a full bar
 *                    above the row) for before/after comparison.
 *        ?pad=<px> -> the feed's top padding (default 16 = ChatPane's py-4).
 *        ?first=cont -> start the feed with a continuation row (no header, no mt-3).
 *        ?show=all|<rowId> -> force every row's (or one row's) bar on (static screenshots).
 *        ?w=<px>  -> feed width (default 760).
 */
const q = new URLSearchParams(location.search);
const OLD = q.get('old') === '1';
const SHOW = q.get('show');
const W = Number(q.get('w') ?? 760);
const PAD = Number(q.get('pad') ?? 16);

type Row = { id: string; header: boolean; name?: string; time?: string; text?: string; image?: boolean; wideImage?: boolean; reply?: string; mine?: boolean };
const LONG = 'This is a deliberately long single paragraph of chat text that keeps going well past the middle of the pane so that its trailing words land underneath the bottom-right corner of the row where the action bar sits when it is shown, which is the worst realistic case for overlap.';
const ROWS: Row[] = [
    ...(q.get('first') === 'cont' ? [{ id: 'z0', header: false, text: 'first row of the list, a continuation' } as Row] : []),
    { id: 'a1', header: true, name: 'Mira', time: 'Today at 9:41 AM', text: 'morning all' },
    { id: 'a2', header: false, text: 'single line continuation' },
    { id: 'a3', header: false, text: 'another one right under it, still one line' },
    { id: 'b1', header: true, name: 'Dawson', time: 'Today at 9:43 AM', text: 'Multi-line message.\nSecond line of the same message.\nThird line, and the bar should sit beside this one.', mine: true },
    { id: 'c1', header: true, name: 'Mira', time: 'Today at 9:44 AM', text: LONG },
    { id: 'd1', header: true, name: 'Jun', time: 'Today at 9:45 AM', image: true },
    { id: 'd2', header: false, image: true, wideImage: true },
    { id: 'e1', header: true, name: 'Dawson', time: 'Today at 9:46 AM', reply: 'morning all', text: 'replying to the first message', mine: true },
    { id: 'f1', header: false, text: 'last continuation row' },
];

const Avatar = () => <div className="w-10 h-10 shrink-0 mt-0.5 rounded-full ring-1 ring-white/5 bg-cl-surface" />;

const Bar = ({ mine, header, onEnter }: { mine?: boolean; header?: boolean; onEnter: () => void }) => {
    const bar = (
        <>
            <MsgBarBtn icon={<SmilePlus />} label="React" onClick={() => {}} />
            <MsgBarBtn icon={<Reply />} label="Reply" onClick={() => {}} />
            <MsgBarBtn icon={<Pin />} label="Pin" onClick={() => {}} />
            <MsgBarBtn icon={<Archive />} label="Save to server" warm onClick={() => {}} />
            <MsgBarBtn icon={<Save />} label="Save for me" onClick={() => {}} />
            {mine && <MsgBarBtn icon={<Edit2 />} label="Edit" onClick={() => {}} />}
            <MsgBarBtn icon={<Trash2 />} label="Delete" danger onClick={() => {}} />
        </>
    );
    if (OLD) {
        // Tailwind only scans src/, and the old -top-11/-top-9 right-14 classes are gone from it,
        // so the previous placement is spelled out as inline styles (-top-11 = -44px, -top-9 = -36px, right-14 = 56px).
        return <div className="msgbar" style={{ position: 'absolute', top: header ? -44 : -36, right: 56, zIndex: 30 }} onClick={e => e.stopPropagation()} onMouseEnter={onEnter}>{bar}</div>;
    }
    return <MsgActionBar onPointerEnterBar={onEnter}>{bar}</MsgActionBar>;
};

const App = () => {
    const [hovered, setHovered] = useState<string | null>(null);
    const enterT = useRef<any>(null), leaveT = useRef<any>(null), pressed = useRef(false);
    return (
        <div style={{ width: W, margin: '0 auto' }} className="bg-cl-abyss text-white font-sans">
        {/* ChatPane's feed: flex-1 overflow-y-auto overflow-x-hidden pl-6 pr-2 py-4 */}
        <div data-feed style={{ overflowY: 'auto', overflowX: 'hidden', padding: `${PAD}px 8px 16px 24px` }}>
            {ROWS.map(r => {
                const show = SHOW === 'all' || SHOW === r.id || hovered === r.id;
                return (
                    <div
                        key={r.id}
                        id={`msg-${r.id}`}
                        data-row={r.id}
                        className={`group relative flex gap-3 py-0.5 pr-2 pl-3 ${r.header ? 'mt-3' : ''} hover:bg-white/[0.015] cursor-pointer`}
                        onMouseEnter={() => {
                            clearTimeout(leaveT.current); clearTimeout(enterT.current);
                            enterT.current = setTimeout(() => setHovered(r.id), 160);
                        }}
                        onMouseLeave={() => {
                            clearTimeout(enterT.current); clearTimeout(leaveT.current);
                            leaveT.current = setTimeout(() => setHovered(null), 200);
                        }}
                        onMouseDown={() => { pressed.current = true; setTimeout(() => { pressed.current = false; }, 0); }}
                        tabIndex={0}
                        onFocus={(e) => {
                            if (pressed.current && e.target === e.currentTarget) return;
                            clearTimeout(leaveT.current); clearTimeout(enterT.current);
                            setHovered(r.id);
                        }}
                        onBlur={() => { clearTimeout(leaveT.current); leaveT.current = setTimeout(() => setHovered(null), 0); }}
                    >
                        {r.header ? <Avatar /> : <div className="w-10 shrink-0" />}
                        <div className="relative flex flex-col min-w-0 flex-1">
                            {r.header && (
                                <div className="flex items-baseline gap-2 mb-0.5">
                                    <span className="text-[14px] font-semibold leading-tight">{r.name}</span>
                                    <span className="text-[11px] text-cl-faint leading-tight">{r.time}</span>
                                </div>
                            )}
                            {r.reply && (
                                <div className="text-[12px] p-2 rounded-lg mb-1 opacity-70 border-l-2 border-cl-lume/50 bg-white/[0.03] w-fit max-w-full min-w-0 overflow-hidden whitespace-nowrap text-ellipsis">{r.reply}</div>
                            )}
                            {r.text && (
                                <div className="text-white/90 break-words whitespace-pre-wrap overflow-hidden" style={{ fontSize: '15px', lineHeight: 'normal', wordBreak: 'break-word' }}>{r.text}</div>
                            )}
                            {r.image && (
                                <div className="flex flex-col w-full items-start">
                                    <div style={{ width: r.wideImage ? '100%' : 360, height: r.wideImage ? 140 : 220, background: 'linear-gradient(135deg,#25E0C8,#3b2a7a)', borderRadius: 8, marginTop: 4 }} data-image />
                                </div>
                            )}
                        </div>
                        {show && <Bar mine={r.mine} header={r.header} onEnter={() => { clearTimeout(leaveT.current); }} />}
                    </div>
                );
            })}
        </div>
        </div>
    );
};

createRoot(document.getElementById('root')!).render(<App />);
