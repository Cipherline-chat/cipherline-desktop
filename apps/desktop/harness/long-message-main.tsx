/* eslint-disable -- visual/perf harness, not shipped */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import React, { useState } from 'react';
import { renderTextWithMentions } from '../src/components/ChatPane';
import { LongMessageBody } from '../src/components/LongMessage';
import { isLongMessage, longMessageExpansion } from '../src/utils/longMessage';

/**
 * A feed whose row markup mirrors ChatPane's message row (same class strings
 * for the row, avatar gutter, content column, header, text body). The text is
 * drawn by the REAL renderTextWithMentions and the long ones by the REAL
 * LongMessageBody + reader, so this measures what ships.
 *
 * Query:
 *   ?scene=feed          (default) short rows + long rows of several sizes
 *   ?scene=many&n=60     n collapsed 12k-character messages (scroll smoothness)
 *   ?w=<px>              feed width (default 860)
 *   ?open=<rowId>        start with that row expanded
 *   ?openall=1           start with every long row expanded (what a feed costs WITHOUT the collapse)
 *   ?reader=<rowId>      open that row's full-screen reader after load
 *
 * Window API for the driver:
 *   __lm.bench(chars)    -> ms to build the React nodes for a message of that size
 *                           (renderTextWithMentions only, no DOM)
 *   __lm.setText(id, t)  -> edit a row's text (threshold re-evaluation)
 */
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 860);
const scene = q.get('scene') ?? 'feed';

const PARA = [
    'The rollout plan has three phases. First we freeze the schema, then we backfill the new columns behind a flag, and only after that do we flip reads over. If anything looks off in the canary we stop and revert the flag; nothing here is irreversible until phase three.',
    'Notes from the call with <@u:u-ann:Ann> and <@u:u-bob:Bob>: the vendor will not ship the fix before the 14th, so we carry the workaround. Details are in https://example.com/postmortem/2026-10-02?section=timeline and the follow-ups live in https://example.com/tracker/CL-1042.',
    'Open questions: who owns the pager during the freeze? do we need a second reviewer for the backfill script? @everyone please add your answers below, even a one-word reply helps. 🙂 Thanks all, this is long but it is the whole picture.',
    'Appendix: the raw numbers.\n  p50 = 41ms\n  p95 = 212ms\n  p99 = 903ms\nThe tail is dominated by cold caches after a deploy; see the graph at https://example.com/graphs/latency for the shape.',
];
function longText(chars: number, tag: string): string {
    let out = `${tag}\n\n`;
    for (let i = 0; out.length < chars; i++) out += PARA[i % PARA.length] + (i % 3 === 2 ? '\n\n' : '\n');
    return out.slice(0, chars);
}

type Row = { id: string; header: boolean; name?: string; time?: string; text: string; mine?: boolean };
const base: Row[] = [
    { id: 'a1', header: true, name: 'Mira', time: 'Today at 9:41 AM', text: 'morning all, can someone read the rollout write-up before standup?' },
    { id: 'a2', header: false, text: 'it is long, I know. I collapsed nothing, the app did.' },
    { id: 'b1', header: true, name: 'Jun', time: 'Today at 9:44 AM', text: longText(12_345, 'Rollout plan v3 (long)') },
    { id: 'b2', header: false, text: 'thanks Jun, reading now' },
    { id: 'c1', header: true, name: 'Dawson', time: 'Today at 9:51 AM', mine: true, text: longText(100_000, 'Full incident log (100k)') },
    { id: 'c2', header: false, text: 'that is the whole thing, copy it from the reader if you need it' },
    { id: 'd1', header: true, name: 'Mira', time: 'Today at 9:58 AM', text: 'x'.repeat(5000) },
    { id: 'd2', header: true, name: 'Mira', time: 'Today at 9:58 AM', text: longText(5001, 'Just over the line') },
];
const ROWS: Row[] = scene === 'many'
    ? Array.from({ length: Number(q.get('n') ?? 60) }, (_, i) => ({
        id: `m${i}`, header: i % 3 === 0, name: ['Mira', 'Jun', 'Dawson'][i % 3], time: 'Today at 10:00 AM', text: longText(12_000, `Long message ${i}`),
    }))
    : base;

const noop = () => {};
const renderBody = (t: string) => renderTextWithMentions(t, 'me', undefined, undefined, undefined, null, false, true, () => true, noop, undefined);

const Avatar = () => <div className="w-10 h-10 shrink-0 mt-0.5 rounded-full ring-1 ring-white/5 bg-cl-surface" />;

const RowView = ({ r }: { r: Row }) => {
    const long = isLongMessage(r.text);
    return (
        <div id={`msg-${r.id}`} data-row={r.id}
            className={`group relative flex gap-3 py-0.5 pr-2 pl-3 ${r.header ? 'mt-3' : ''} hover:bg-white/[0.015] cursor-pointer`} tabIndex={0}>
            {r.header ? <Avatar /> : <div className="w-10 shrink-0" />}
            <div className="relative flex flex-col min-w-0 flex-1">
                {r.header && (
                    <div className="flex items-baseline gap-2 mb-0.5">
                        <span className="text-[14px] font-semibold leading-tight">{r.name}</span>
                        <span className="text-[11px] text-cl-faint leading-tight">{r.time}</span>
                    </div>
                )}
                <div className="text-white/90 break-words whitespace-pre-wrap overflow-hidden" style={{ fontSize: '15px', lineHeight: 'normal', wordBreak: 'break-word' }}>
                    {long
                        ? <LongMessageBody id={r.id} text={r.text} renderText={renderBody} renderDeps={[]} senderName={r.name ?? 'Mira'} timestamp={r.time ?? ''} />
                        : renderBody(r.text)}
                </div>
            </div>
        </div>
    );
};

const App = () => {
    const [rows, setRows] = useState(ROWS);
    (window as any).__lm = {
        bench: (chars: number) => {
            const t = longText(chars, 'bench');
            const t0 = performance.now();
            renderBody(t);
            return performance.now() - t0;
        },
        /** Where the time of a full render goes: React commit vs style+layout vs paint. */
        breakdown: async (chars: number) => {
            const t = longText(chars, 'bd');
            const host = document.createElement('div');
            host.style.cssText = 'width:760px;white-space:pre-wrap;font-size:15px;position:absolute;left:0;top:0';
            document.body.appendChild(host);
            const r = createRoot(host);
            const t0 = performance.now();
            flushSync(() => r.render(<div>{renderBody(t)}</div>));
            const t1 = performance.now();
            const h = host.getBoundingClientRect().height;
            const t2 = performance.now();
            await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
            const t3 = performance.now();
            const nodes = host.getElementsByTagName('*').length;
            r.unmount(); host.remove();
            return { commit: t1 - t0, layout: t2 - t1, paint: t3 - t2, h, nodes };
        },
        setText: (id: string, text: string) => setRows(rs => rs.map(r => (r.id === id ? { ...r, text } : r))),
        longText,
    };
    return (
        <div style={{ width: W, margin: '0 auto', height: '100vh' }} className="bg-cl-abyss text-white font-sans">
            <div data-feed style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '16px 8px 16px 24px' }}>
                {rows.map(r => <RowView key={r.id} r={r} />)}
            </div>
        </div>
    );
};

const openId = q.get('open');
if (openId) longMessageExpansion.set(openId, true);
if (q.get('openall') === '1') for (const r of ROWS) longMessageExpansion.set(r.id, true); // the "no collapse" baseline
createRoot(document.getElementById('root')!).render(<App />);

const readerId = q.get('reader');
if (readerId) {
    const tryOpen = () => {
        const b = Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-row="${readerId}"] button`)).find(x => x.textContent?.includes('Open full screen'));
        if (b) b.click(); else setTimeout(tryOpen, 100);
    };
    setTimeout(tryOpen, 300);
}
