/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import React from 'react';
import { applyTheme } from '../src/theme/engine';
import { DARK_THEME, LIGHT_THEME } from '../src/theme/themes';
import { renderFormatted } from '../src/components/formatting/FormattedText';
import { mentionsToDisplayText } from '../src/utils/mentionTokens';
import { MESSAGE_BODY_CLASS } from '../src/utils/formatting/messageSize';
import { handleMessageCopy } from '../src/utils/formatting/linkDisplay';

/**
 * A message row mirroring ChatPane's markup; the body is the REAL renderFormatted with ChatPane's REAL
 * renderTextWithMentions as its leaf renderer and the same onCopy ChatPane puts on the body.
 *   ?before=1  uses a copy of ChatPane.tsx from the base commit (untracked ChatPane.before.tsx) = the old behaviour
 *   ?theme=light|dark
 */
const q = new URLSearchParams(location.search);
const before = q.get('before') === '1';
const light = q.get('theme') === 'light';
applyTheme(light ? LIGHT_THEME : DARK_THEME);
document.body.style.background = 'var(--cl-abyss)';

const { renderTextWithMentions } = before
    ? await import('../src/components/ChatPane.before')
    : await import('../src/components/ChatPane');

const noop = () => {};
const renderLeaf = (leaf: string, _k: string, ctx: { inLink: boolean }) =>
    ctx.inLink ? mentionsToDisplayText(leaf) : renderTextWithMentions(leaf, 'me', undefined, undefined, undefined, null, false, true, () => true, noop, undefined);

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=7&t=43s&pp=iAQB';
const DOCS = 'https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg/edit?usp=sharing&tab=t.0';
const AMAZON = 'https://www.amazon.com/Some-Very-Long-Product-Title-With-Many-Words-Here/dp/B08N5WRWNW/ref=sr_1_3?crid=2K&keywords=thing&qid=1699999999&sprefix=thi%2Caps%2C150&sr=8-3';
const ROWS = [
    { id: 'a', name: 'Dawson', time: 'Today at 12:02 PM', hue: '#FF6B5E', text: `this is the doc, read it before the call ${DOCS}` },
    { id: 'b', name: 'Jun', time: 'Today at 12:03 PM', hue: '#FFC94D', text: `${YT}\nlol` },
    { id: 'c', name: 'Mira', time: 'Today at 12:04 PM', hue: '#25E0C8', text: `got it for ${AMAZON} and a short one https://example.com/ok` },
    { id: 'd', name: 'Jun', time: 'Today at 12:05 PM', hue: '#FFC94D', text: `masked stays: [my label](${YT})\ncode stays: \`${DOCS}\`\nangle: <${AMAZON}>` },
];

const Row = ({ r }: { r: typeof ROWS[number] }) => (
    <div data-row={r.id} className="group relative flex gap-3 py-0.5 pr-2 pl-3 mt-3">
        <div className="w-10 h-10 shrink-0 mt-0.5 rounded-full ring-1 ring-white/5" style={{ background: `linear-gradient(135deg, ${r.hue}, #1C2542)` }} />
        <div className="relative flex flex-col min-w-0 flex-1">
            <div className="flex items-baseline gap-2 mb-0.5">
                <span className="text-[14px] font-semibold leading-tight">{r.name}</span>
                <span className="text-[11px] text-cl-faint leading-tight">{r.time}</span>
            </div>
            <div data-body className={MESSAGE_BODY_CLASS} onCopy={handleMessageCopy as never}
                style={{ fontSize: '15px', lineHeight: 'normal', wordBreak: 'break-word' }}>
                {renderFormatted(r.text, { renderLeaf, codeText: mentionsToDisplayText })}
            </div>
        </div>
    </div>
);

createRoot(document.getElementById('root')!).render(
    <div className="bg-cl-abyss text-cl-text font-sans" style={{ minHeight: '100vh', padding: '12px 8px 20px 16px' }}>
        {ROWS.map(r => <Row key={r.id} r={r} />)}
    </div>,
);
