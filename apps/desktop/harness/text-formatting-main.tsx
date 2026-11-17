/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, SendHorizontal } from 'lucide-react';
import type { MessageFont } from '@cipherline/shared';
import { renderTextWithMentions } from '../src/components/ChatPane';
import { renderFormatted, renderFormattedPreview } from '../src/components/formatting/FormattedText';
import { LongMessageBody } from '../src/components/LongMessage';
import { isLongMessage } from '../src/utils/longMessage';
import { FormatToolbar } from '../src/components/composer/FormatToolbar';
import { MarkdownPastePrompt } from '../src/components/composer/MarkdownPastePrompt';
import { mentionsToDisplayText } from '../src/utils/mentionTokens';
import { fontStackFor } from '../src/utils/formatting/messageFont';
import { applyFormat, enterAction, shortcutAction, type ComposerEdit } from '../src/utils/formatting/composerFormat';
import { convertMarkdown } from '../src/utils/formatting/markdownPaste';
import { fenceCode, pastePromptFor, type PastePrompt } from '../src/utils/formatting/codePaste';

/**
 * Message rows mirror ChatPane's row markup (avatar gutter, header, the
 * `whitespace-pre-wrap` body at 15px); the body is the REAL renderFormatted
 * with ChatPane's REAL renderTextWithMentions as its leaf renderer, exactly as
 * ChatPane wires it. The composer pill copies ChatPane's form styles and uses
 * the REAL FormatToolbar / MarkdownPastePrompt and the same pure edit
 * functions ChatPane calls (applyFormat, continueList, shortcutAction,
 * shouldOfferMarkdownConversion, convertMarkdown).
 *
 *   ?scene=feed       every format, blocks, fonts
 *   ?scene=code       code blocks in several languages
 *   ?scene=composer   the composer (&bar=1 opens the bar, &text=... prefills)
 *   ?scene=pasted     a ChatGPT answer after "Format" (table -> code block…)
 */
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'feed';
const W = Number(q.get('w') ?? 880);

const noop = () => {};
const renderLeaf = (leaf: string, _k: string, ctx: { inLink: boolean }) =>
    ctx.inLink ? mentionsToDisplayText(leaf) : renderTextWithMentions(leaf, 'me', undefined, undefined, undefined, null, false, true, () => true, noop, undefined);
const fmtOpts = { renderLeaf, codeText: mentionsToDisplayText };
const renderBody = (t: string) => renderFormatted(t, fmtOpts);
const renderPreview = (t: string) => renderFormattedPreview(t, fmtOpts);

type Row = { id: string; header: boolean; name?: string; time?: string; text: string; font?: MessageFont; hue?: string };

const EVERY_INLINE = [
    '**bold**, *italic* (or _italic_), __underline__, ~~strikethrough~~, `inline code`, and a ||spoiler|| you click to reveal.',
    'Stack them: ***bold italic***, __*underline italic*__, ~~**struck bold**~~. Escape with a backslash: \\*not italic\\*.',
    'Links: a [masked link](https://example.com/docs) shows where it really goes on hover, <https://example.com/quiet> skips the preview, and https://cipherline.chat stays a plain link.',
    'Mentions and emoji keep working inside formatting: **hey <@u:u-ann:Ann>**, ||<@u:u-bob:Bob> is the killer|| 🎉',
].join('\n');

const BLOCKS = [
    '# Release notes',
    'Headings add weight and colour, never size — this line is the same size as the heading above.',
    '## What changed',
    '- A formatting bar next to the paperclip',
    '- Markdown paste that asks first',
    '  - tables turn into aligned code blocks',
    '  - `__bold__` from GitHub stays bold',
    '1. Pick some text',
    '2. Press **Ctrl+B**',
    '> Quotes for the bits worth repeating,',
    '> across as many lines as you like.',
    '### Known issues',
    'None **yet**.',
    '-# subtext — the small print, same size, quieter colour',
].join('\n');

const CODE_JS = '```ts\n// Debounce a function — the classic.\nexport function debounce<T extends (...a: unknown[]) => void>(fn: T, ms = 200) {\n    let t: ReturnType<typeof setTimeout> | null = null;\n    return (...args: Parameters<T>) => {\n        if (t) clearTimeout(t);\n        t = setTimeout(() => fn(...args), ms);\n    };\n}\nconst ready = true, retries = 3;\n```';
const CODE_PY = '```python\n@dataclass\nclass Message:\n    sender: str\n    body: str = ""\n\n    def preview(self, n: int = 40) -> str:\n        # One line, cut at n characters\n        return self.body[:n] if self.body else None\n```';
const CODE_JSON = '```json\n{\n  "channel": "general",\n  "encrypted": true,\n  "members": 42,\n  "topic": null\n}\n```';
const CODE_DIFF = '```diff\n@@ -1,3 +1,3 @@\n-const limit = 5;\n+const limit = 20;\n const window = 10;\n```';
const CODE_SQL = '```sql\nSELECT id, created_at FROM messages\nWHERE channel_id = $1 AND deleted_at IS NULL\nORDER BY created_at DESC LIMIT 50;\n```';

const FEED: Row[] = [
    { id: 'f1', header: true, name: 'Mira', time: 'Today at 9:41 AM', text: EVERY_INLINE, hue: '#25E0C8' },
    { id: 'f2', header: true, name: 'Jun', time: 'Today at 9:44 AM', text: BLOCKS, hue: '#FFC94D' },
    { id: 'f3', header: true, name: 'Dawson', time: 'Today at 9:47 AM', text: 'quick one before standup:\n' + CODE_JS, hue: '#FF6B5E' },
    { id: 'f4', header: true, name: 'Mira', time: 'Today at 9:50 AM', text: 'Default font — **Nunito**, the app font.', hue: '#25E0C8' },
    { id: 'f5', header: false, text: 'Serif — a *classic*, bookish look for longer notes.', font: 'serif' },
    { id: 'f6', header: false, text: 'Mono — even columns, typewriter feel.', font: 'mono' },
    { id: 'f7', header: false, text: 'Handwritten — like a note on the fridge. **bold**, *italic*, `code`', font: 'hand' },
    { id: 'f7b', header: false, text: 'Typewriter — *inky* keys for a **dramatic** memo. `code` stays mono.', font: 'typewriter' },
    { id: 'f7c', header: false, text: 'Marker — loud colours, NOT loud size. **bold** *italic* 🎉', font: 'marker' },
    { id: 'f7d', header: false, text: 'Readable — Atkinson Hyperlegible: Il1 O0 rn m, **bold** and *italic*.', font: 'readable' },
    { id: 'f8', header: true, name: 'Not Your Bank', time: 'Today at 9:55 AM', text: 'Urgent: verify your account at [https://paypal.com/login](https://paypa1-secure.example/login)', hue: '#5E6B8F' },
];

export const CHATGPT = [
    '## Quick setup',
    '',
    'Here are the steps:',
    '',
    '1. Install the __CLI__ with `npm i -g thing`',
    '2. Run `thing init` — it asks _two_ questions',
    '3. Read the [docs](https://example.com/docs)',
    '',
    '| Option | Default | Notes |',
    '|:-------|:-------:|------:|',
    '| `port` | 3000 | HTTP port |',
    '| `debug` | false | Verbose logs |',
    '',
    '#### Checklist',
    '* [x] Node 20+',
    '* [ ] A free port',
    '',
    '```bash',
    'thing start --port 3000',
    '```',
].join('\n');

const LONG_CODE = 'pasted the whole migration, **careful** with step 3:\n```ts\n' + Array.from({ length: 64 }, (_, i) => i % 8 === 0
    ? `// step ${i / 8 + 1}: ${['load rows', 'dedupe', 'backfill keys', 'swap tables', 'verify', 'index', 'analyze', 'done'][i / 8]}`
    : `const rows${i} = await db.page(cursor, ${i * 500});`).join('\n') + '\n```';
export const PY_SNIPPET = 'def retry(fn, attempts=3):\n    for i in range(attempts):\n        try:\n            return fn()\n        except TimeoutError:\n            print(f"retry {i + 1}")\n    raise RuntimeError("gave up")\n';

const CODE_FEED: Row[] = [
    { id: 'c1', header: true, name: 'Dawson', time: 'Today at 10:02 AM', text: 'here\'s the helper:\n' + CODE_JS, hue: '#FF6B5E' },
    { id: 'c2', header: true, name: 'Jun', time: 'Today at 10:04 AM', text: CODE_PY + '\nand the payload looks like\n' + CODE_JSON, hue: '#FFC94D' },
    { id: 'c3', header: true, name: 'Mira', time: 'Today at 10:06 AM', text: CODE_DIFF + '\n' + CODE_SQL, hue: '#25E0C8' },
];

const Avatar = ({ hue }: { hue?: string }) => (
    <div className="w-10 h-10 shrink-0 mt-0.5 rounded-full ring-1 ring-white/5" style={{ background: `linear-gradient(135deg, ${hue ?? '#1C2542'}, #1C2542)` }} />
);

const RowView = ({ r }: { r: Row }) => {
    const long = isLongMessage(r.text);
    return (
    <div data-row={r.id} className={`group relative flex gap-3 py-0.5 pr-2 pl-3 ${r.header ? 'mt-3' : ''} hover:bg-white/[0.015]`}>
        {r.header ? <Avatar hue={r.hue} /> : <div className="w-10 shrink-0" />}
        <div className="relative flex flex-col min-w-0 flex-1">
            {r.header && (
                <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-[14px] font-semibold leading-tight">{r.name}</span>
                    <span className="text-[11px] text-cl-faint leading-tight">{r.time}</span>
                </div>
            )}
            <div className="text-white/90 break-words whitespace-pre-wrap overflow-hidden" data-msg-font={r.font}
                style={{ fontSize: '15px', lineHeight: 'normal', wordBreak: 'break-word', fontFamily: fontStackFor(r.font) }}>
                {long
                    ? <LongMessageBody id={r.id} text={r.text} renderText={renderBody} renderPreview={renderPreview} renderDeps={[]} senderName={r.name ?? 'Dawson'} timestamp={r.time ?? ''} />
                    : renderBody(r.text)}
            </div>
        </div>
    </div>
    );
};

const Feed = ({ rows }: { rows: Row[] }) => (
    <div data-feed style={{ padding: '12px 8px 20px 16px' }}>
        {rows.map(r => <RowView key={r.id} r={r} />)}
    </div>
);

/** The composer pill, styled exactly like ChatPane's <form className="cl-composer">. */
const Composer = () => {
    const [text, setText] = useState(q.get('text') ?? '');
    const [bar, setBar] = useState(q.get('bar') === '1');
    const [font, setFont] = useState<MessageFont | null>((q.get('font') as MessageFont) || null);
    const [focused, setFocused] = useState(true);
    const [md, setMd] = useState<{ start: number; inserted: string; source: string; offer: PastePrompt; landed?: boolean } | null>(null);
    const ta = useRef<HTMLTextAreaElement>(null);

    const apply = (el: HTMLTextAreaElement, next: ComposerEdit) => {
        setText(next.value);
        requestAnimationFrame(() => {
            el.setSelectionRange(next.selStart, next.selEnd);
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
        });
    };
    useEffect(() => {
        if (!md) return;
        const here = text.slice(md.start, md.start + md.inserted.length) === md.inserted;
        if (!md.landed) { if (here) setMd({ ...md, landed: true }); } else if (!here) setMd(null);
    }, [text, md]);
    useEffect(() => {
        const el = ta.current!;
        el.focus();
        const sel = q.get('sel');
        if (sel) { const [a, b] = sel.split(',').map(Number); el.setSelectionRange(a, b); }
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
    }, []);
    (window as any).__tf = {
        select: (a: number, b: number) => { ta.current!.focus(); ta.current!.setSelectionRange(a, b); },
        value: () => ta.current!.value,
        sample: CHATGPT,
        py: PY_SNIPPET,
    };

    return (
        <div style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
            {md?.landed && <MarkdownPastePrompt kind={md.offer.kind} lang={md.offer.kind === 'code' ? md.offer.lang : null} onFormat={() => {
                const el = ta.current!;
                const converted = md.offer.kind === 'code' ? fenceCode(md.inserted, md.offer.lang) : convertMarkdown(md.source);
                apply(el, { value: el.value.slice(0, md.start) + converted + el.value.slice(md.start + md.inserted.length), selStart: md.start + converted.length, selEnd: md.start + converted.length });
                setMd(null);
            }} onKeep={() => setMd(null)} />}
            <form className="cl-composer" onSubmit={e => e.preventDefault()} style={{
                position: 'relative', display: 'flex', alignItems: 'center', gap: 4,
                background: 'var(--cl-surface)', border: `1.5px solid ${focused ? 'var(--cl-lume)' : 'var(--cl-border)'}`,
                borderRadius: 26, padding: '6px 6px 6px 8px', boxShadow: '0 2px 12px rgba(0,0,0,.22)',
            }}>
                <button type="button" className="cmp-ico" title="Attach File"><Paperclip className="w-[18px] h-[18px]" /></button>
                <FormatToolbar open={bar} onOpenChange={setBar} font={font} onFontChange={setFont} isMac={false}
                    focusComposer={() => ta.current?.focus()}
                    onAction={(a) => { const el = ta.current!; apply(el, applyFormat(el.value, el.selectionStart, el.selectionEnd, a)); el.focus(); }} />
                <textarea ref={ta} data-chat-input value={text} rows={1} placeholder="Message…"
                    onChange={e => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 260)}px`; }}
                    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
                    onPaste={e => {
                        const t = e.clipboardData.getData('text');
                        const offer = t ? pastePromptFor(t) : null;
                        if (offer) setMd({ start: Math.min(e.currentTarget.selectionStart, e.currentTarget.selectionEnd), inserted: t.replace(/\r\n?/g, '\n'), source: t, offer });
                        else setMd(null);
                    }}
                    onKeyDown={e => {
                        const a = shortcutAction(e, false);
                        if (a) { e.preventDefault(); const el = e.currentTarget; apply(el, applyFormat(el.value, el.selectionStart, el.selectionEnd, a)); return; }
                        if (e.key === 'Enter' && e.shiftKey) { const c = enterAction(e, e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd); if (c?.kind === 'continue') { e.preventDefault(); apply(e.currentTarget, c.edit); } }
                    }}
                    className="flex-1 min-w-0 bg-transparent border-none outline-none ring-0 text-[14.5px] font-medium resize-none text-white/90 placeholder-white/25"
                    style={{ display: 'block', padding: '2px 4px', lineHeight: '22px', minHeight: 22, maxHeight: 260, overflowY: 'auto', outline: 'none', outlineWidth: 0, boxShadow: 'none', border: 0, background: 'transparent', WebkitAppearance: 'none', appearance: 'none', WebkitBoxShadow: 'none', fontFamily: fontStackFor(font) } as React.CSSProperties} />
                <button type="submit" className="cmp-ico cmp-ico--send"><SendHorizontal className="w-[18px] h-[18px]" /></button>
            </form>
        </div>
    );
};

const App = () => (
    <div style={{ width: W, margin: '0 auto', minHeight: '100vh', position: 'relative' }} className="bg-cl-abyss text-white font-sans">
        {scene === 'feed' && <Feed rows={FEED} />}
        {scene === 'code' && <Feed rows={CODE_FEED} />}
        {scene === 'long' && <Feed rows={[{ id: 'l1', header: true, name: 'Dawson', time: 'Today at 12:02 PM', text: LONG_CODE, hue: '#FF6B5E' }, { id: 'l2', header: true, name: 'Jun', time: 'Today at 12:03 PM', text: 'reading it now 👀', hue: '#FFC94D' }]} />}
        {scene === 'fonts' && (
            <>
                <Feed rows={FEED.filter(r => r.id.startsWith('f4') || r.id.startsWith('f5') || r.id.startsWith('f6') || r.id.startsWith('f7'))} />
                <Composer />
            </>
        )}
        {scene === 'pasted' && <Feed rows={[{ id: 'm1', header: true, name: 'Dawson', time: 'Today at 11:20 AM', text: convertMarkdown(CHATGPT), hue: '#FF6B5E' }]} />}
        {scene === 'composer' && (
            <>
                <Feed rows={[{ id: 'p1', header: true, name: 'Jun', time: 'Today at 11:12 AM', text: 'can you send the **setup steps**? ||and the wifi password||', hue: '#FFC94D' }]} />
                <Composer />
            </>
        )}
    </div>
);

createRoot(document.getElementById('root')!).render(<App />);
