/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, SendHorizontal, Hash } from 'lucide-react';
import type { MessageFont, MessageSize } from '@cipherline/shared';
import { renderFormatted } from '../src/components/formatting/FormattedText';
import { renderTextWithMentions } from '../src/components/ChatPane';
import { FormatToolbar } from '../src/components/composer/FormatToolbar';
import { MarkdownPastePrompt } from '../src/components/composer/MarkdownPastePrompt';
import { SuggestionMenu } from '../src/components/composer/SuggestionMenu';
import { RichComposer, type RichComposerHandle, type ActiveFormats } from '../src/components/composer/RichComposer';
import { mentionsToDisplayText } from '../src/utils/mentionTokens';
import { fontStackFor } from '../src/utils/formatting/messageFont';
import { scaledPx, sizeScaleFor } from '../src/utils/formatting/messageSize';
import { shortcutAction } from '../src/utils/formatting/composerFormat';
import { extractUniformSize } from '../src/utils/formatting/richWire';
import { composerPastePrompt, type ComposerPastePrompt } from '../src/utils/formatting/composerPaste';
import { detectChannelTrigger } from '../src/utils/channelRefs';

/**
 * The WYSIWYG composer in a pill styled exactly like ChatPane's
 * <form className="cl-composer">: the REAL RichComposer, FormatToolbar,
 * MarkdownPastePrompt and SuggestionMenu, wired the way ChatPane wires them
 * (shortcutAction on keydown, newline() on Shift+Enter, enterShortcut() then
 * "send" on Enter, the # trigger read from the PLAIN text, font / size reset
 * after a send). Feed rows use the REAL renderFormatted at ChatPane's 15px x
 * message scale.
 *
 *   ?scene=composer          the composer (empty)
 *   ?scene=sizes             Small / Normal / Large messages in the feed (per-message field)
 *   ?scene=mixed             one message mixing [small] / normal / [large] spans
 */
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'composer';
const W = Number(q.get('w') ?? 760);

const noop = () => {};
const renderLeaf = (leaf: string, _k: string, ctx: { inLink: boolean }) =>
    ctx.inLink ? mentionsToDisplayText(leaf) : renderTextWithMentions(leaf, 'me', undefined, undefined, undefined, null, false, true, () => true, noop, undefined);
const renderBody = (t: string) => renderFormatted(t, { renderLeaf, codeText: mentionsToDisplayText });

type Row = { id: string; name: string; text: string; size?: MessageSize | null; font?: MessageFont | null; hue: string };

const RowView = ({ r }: { r: Row }) => (
    <div data-row={r.id} className="group relative flex gap-3 py-0.5 pr-2 pl-3 mt-3">
        <div className="w-10 h-10 shrink-0 mt-0.5 rounded-full ring-1 ring-white/5" style={{ background: `linear-gradient(135deg, ${r.hue}, #1C2542)` }} />
        <div className="relative flex flex-col min-w-0 flex-1">
            <div className="flex items-baseline gap-2 mb-0.5">
                <span className="text-[14px] font-semibold leading-tight">{r.name}</span>
                <span className="text-[11px] text-cl-faint leading-tight">Today at 4:20 PM</span>
            </div>
            <div className="text-white/90 break-words whitespace-pre-wrap overflow-hidden" data-msg-size={r.size ?? undefined}
                style={{ fontSize: scaledPx(15, r.size ?? null), lineHeight: 'normal', wordBreak: 'break-word', fontFamily: fontStackFor(r.font ?? null), ...(r.size ? { ['--cl-msg-scale' as string]: String(sizeScaleFor(r.size)) } : {}) }}>
                {renderBody(r.text)}
            </div>
        </div>
    </div>
);

const SAMPLE = '**Small change**, big reads: `npm run build` then\n- check the *feed*\n- ship it\n```js\nconst ok = true;\n```';
const SIZES: Row[] = [
    { id: 's-small', name: 'Jun · Small', text: SAMPLE, size: 'small', hue: '#FFC94D' },
    { id: 's-normal', name: 'Mira · Normal', text: SAMPLE, size: null, hue: '#25E0C8' },
    { id: 's-large', name: 'Dawson · Large', text: SAMPLE, size: 'large', hue: '#FF6B5E' },
];

const MIXED: Row[] = [
    { id: 'm-mixed', name: 'Dawson', hue: '#FF6B5E', text: '[small]psst, small print:[/small] the meeting moved to [large]**3 PM**[/large] — [large]bring `npm run build`[/large] [small]and snacks[/small]\n# [large]Big heading[/large]\n- [small]a small item[/small]\n- a [large]large[/large] item' },
    { id: 'm-old', name: 'Jun · old Large (field)', hue: '#FFC94D', text: 'sent before spans: the whole message is Large', size: 'large' },
];

const CHANNELS = ['general', 'gaming', 'gear-talk', 'design'];

const Composer = () => {
    const [value, setValue] = useState(q.get('text') ?? '');
    const [bar, setBar] = useState(q.get('bar') === '1');
    const [font, setFont] = useState<MessageFont | null>(null);
    const [formats, setFormats] = useState<ActiveFormats | null>(null);
    const [focused, setFocused] = useState(true);
    const [channels, setChannels] = useState<{ items: string[]; start: number; end: number } | null>(null);
    const [md, setMd] = useState<{ start: number; inserted: string; offer: ComposerPastePrompt } | null>(null);
    const [sent, setSent] = useState<{ text: string; font: MessageFont | null; size: MessageSize | null }[]>([]);
    const ed = useRef<RichComposerHandle>(null);

    useEffect(() => { ed.current?.focus(); }, []);
    (window as any).__cw = {
        value: () => value,
        plain: () => ed.current!.getPlain(),
        sel: () => ed.current!.getSelection(),
        select: (a: number, b: number) => { ed.current!.focus(); ed.current!.setSelection(a, b); },
        sent: () => sent,
        state: () => ({ font, size: formats?.size ?? null, formats }),
    };
    const send = () => {
        ed.current?.commitPending();
        setTimeout(() => {
            // ChatPane: one size for the whole message -> the per-message field with clean text.
            const sized = extractUniformSize((window as any).__cw.value());
            setSent(s => [...s, { text: sized.text, font, size: sized.size }]);
            // ChatPane: the box clears and nothing sticks after a send.
            setValue('');
            setFont(null);
        }, 0);
    };

    return (
        <>
            <div data-feed style={{ padding: '12px 8px 140px 16px' }}>
                {sent.map((m, i) => <RowView key={i} r={{ id: `sent-${i}`, name: 'You', text: m.text, size: m.size, font: m.font, hue: '#8B5CF6' }} />)}
            </div>
            <div style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
                {md && <MarkdownPastePrompt kind={md.offer.kind} lang={md.offer.kind === 'code' ? md.offer.lang : null} onFormat={() => {
                    const e = ed.current!;
                    const end = md.start + md.inserted.length;
                    if (md.offer.kind === 'code') e.replaceWithCodeBlock(md.start, end, md.offer.lang); else e.replaceWithWire(md.start, end, md.offer.wire);
                    setMd(null);
                }} onKeep={() => setMd(null)} />}
                <form className="cl-composer" onSubmit={e => { e.preventDefault(); send(); }} style={{
                    position: 'relative', display: 'flex', alignItems: 'center', gap: 4,
                    background: 'var(--cl-surface)', border: `1.5px solid ${focused ? 'var(--cl-lume)' : 'var(--cl-border)'}`,
                    borderRadius: 26, padding: '6px 6px 6px 8px', boxShadow: '0 2px 12px rgba(0,0,0,.22)',
                }}>
                    <button type="button" className="cmp-ico" title="Attach File"><Paperclip className="w-[18px] h-[18px]" /></button>
                    <FormatToolbar open={bar} onOpenChange={setBar} active={formats} font={font} onFontChange={setFont} size={formats?.size ?? null} onSizeChange={(sz) => { ed.current?.applySize(sz); ed.current?.focus(); }} isMac={false}
                        focusComposer={() => ed.current?.focus()}
                        onAction={(a) => { ed.current?.applyFormat(a); ed.current?.focus(); }} />
                    <RichComposer ref={ed} value={value} placeholder="Message…" autoFocus
                        onChange={(v, { plain, caret }) => {
                            setValue(v);
                            const t = ed.current?.caretInCode() ? null : detectChannelTrigger(plain.slice(0, caret));
                            const items = t ? CHANNELS.filter(c => c.startsWith(t.query)) : [];
                            setChannels(t && items.length ? { items, start: t.start, end: caret } : null);
                        }}
                        onPasted={(start, inserted, original) => { const offer = composerPastePrompt(original); setMd(offer ? { start, inserted, offer } : null); }}
                        onFormats={setFormats}
                        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
                        onKeyDown={e => {
                            if (channels && (e.key === 'Enter' || e.key === 'Tab')) {
                                e.preventDefault();
                                ed.current!.replaceRange(channels.start, channels.end, `#${channels.items[0]} `);
                                setChannels(null);
                                return;
                            }
                            const a = shortcutAction(e, false);
                            if (a) { e.preventDefault(); ed.current!.applyFormat(a); return; }
                            if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); ed.current!.newline(); return; }
                            if (e.key === 'Enter' && !e.shiftKey && ed.current!.enterShortcut()) { e.preventDefault(); return; }
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                        }}
                        dataFont={font ?? undefined}
                        fontFamily={fontStackFor(font)}
                        maxLength={100000}
                        className="flex-1 min-w-0 bg-transparent font-medium text-white/90"
                        style={{ padding: '2px 4px' }} />
                    <button type="submit" className="cmp-ico cmp-ico--send"><SendHorizontal className="w-[18px] h-[18px]" /></button>
                    {channels && ed.current?.element && (
                        <SuggestionMenu anchorEl={ed.current.element} sectionLabel="Channels" selectedIndex={0}
                            items={channels.items.map(c => ({ key: c, icon: <Hash className="w-4 h-4 text-cl-faint" aria-hidden="true" />, label: c, onSelect: () => {} }))} />
                    )}
                </form>
            </div>
        </>
    );
};

const App = () => (
    <div style={{ width: W, margin: '0 auto', minHeight: '100vh', position: 'relative' }} className="bg-cl-abyss text-white font-sans">
        {scene === 'sizes' && <div data-feed style={{ padding: '12px 8px 20px 16px' }}>{SIZES.map(r => <RowView key={r.id} r={r} />)}</div>}
        {scene === 'mixed' && <div data-feed style={{ padding: '12px 8px 20px 16px' }}>{MIXED.map(r => <RowView key={r.id} r={r} />)}</div>}
        {scene === 'composer' && <Composer />}
    </div>
);

createRoot(document.getElementById('root')!).render(<App />);
