/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/formatting.css';
import React from 'react';
import type { CardStyle, MessageSize } from '@cipherline/shared';
import { renderFormatted, renderFormattedPreview } from '../src/components/formatting/FormattedText';
import { renderTextWithMentions } from '../src/components/ChatPane';
import { LongMessageBody } from '../src/components/LongMessage';
import { MessageCard } from '../src/components/messageCard/MessageCard';
import { ComposerCardSurface } from '../src/components/messageCard/ComposerCardSurface';
import { RichComposer } from '../src/components/composer/RichComposer';
import { ToastProvider } from '../src/contexts/ToastContext';
import { mentionsToDisplayText } from '../src/utils/mentionTokens';
import { fontStackFor } from '../src/utils/formatting/messageFont';
import { MESSAGE_BODY_CLASS, MESSAGE_BODY_LINE_HEIGHT, MESSAGE_BODY_PX, scaledPx, sizeScaleFor } from '../src/utils/formatting/messageSize';
import { resolveCard, composerCardMode, cardTextColor, composerTextStyle } from '../src/utils/cardStyle/cardStyleReact';
import { CARD_STYLE_TEMPLATES } from '../src/utils/cardStyle/cardStyleTemplates';
import { isEmojiOnly, countEmojis } from '../src/utils/emojiText';

/**
 * Inline emoji beside text, in every message-body shape ChatPane draws, so the
 * driver (harness/emoji-inline-check.mjs) can compare each emoji's ink with
 * every clipping ancestor. Row markup mirrors ChatPane's message row; the body
 * div uses ChatPane's own class (MESSAGE_BODY_CLASS) and metrics; text is drawn
 * by the REAL renderFormatted + renderTextWithMentions (so native emoji get
 * ChatPane's own 1.25em span and custom emoji its 1.375em image box), the REAL
 * MessageCard, LongMessageBody, RichComposer and ComposerCardSurface.
 *
 *   ?w=<px>       feed width (default 760)
 *   ?tall=1       Windows stand-in: the emoji face drawn 118% (size-adjust), so
 *                 the glyph's ink reaches higher above the baseline than Noto's
 *   ?oldbody=1    POSITIVE CONTROL: the body class as it was before the fix
 *                 (Tailwind overflow-hidden), so the driver must see the clip
 */
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 760);
const TALL = q.get('tall') === '1';
const BODY = q.get('oldbody') === '1' ? 'text-white/90 break-words whitespace-pre-wrap overflow-hidden' : MESSAGE_BODY_CLASS;

const noop = () => {};
/** ChatPane's renderLeaf with a DM's context: no server emoji list (custom tokens resolve to the
 *  "unavailable" glyph, same 1.375em box as the image), or a server channel whose list is loading. */
const leafFor = (loading: boolean) => (leaf: string, _k: string, ctx: { inLink: boolean }) =>
    ctx.inLink ? mentionsToDisplayText(leaf) : renderTextWithMentions(leaf, 'me', undefined, undefined, () => undefined, null, loading, !loading, () => true, noop, undefined);
const bodyFor = (loading = false) => (t: string) => renderFormatted(t, { renderLeaf: leafFor(loading), codeText: mentionsToDisplayText });

type Probe = {
    id: string; label: string; text: string; size?: MessageSize | null; card?: CardStyle | null;
    reply?: string; loading?: boolean; long?: boolean;
};

const TIGHT_CARD: CardStyle = { v: 1, background: { type: 'solid', color: '#1d2b64' }, padding: 'tight', radius: 8 } as CardStyle;
const tpl = (id: string) => CARD_STYLE_TEMPLATES.find(t => t.id === id)!.style;
const LOREM = 'The rollout plan has three phases. First we freeze the schema, then we backfill the new columns behind a flag, and only after that do we flip reads over. ';

const PROBES: Probe[] = [
    { id: 'plain', label: 'DM · plain', text: 'hey 😀 what is up' },
    { id: 'plain-end', label: 'DM · emoji at the end', text: 'shipping it tonight 🎉' },
    { id: 'multiline', label: 'DM · two lines', text: 'first line 🔥 here\nsecond line 😂 too' },
    { id: 'wrap', label: 'DM · wrapped paragraph', text: 'a long first line that wraps around the column more than once so the emoji 🚀 lands on a later line, and then another 🍕 for good measure, plus more words after it to wrap again 😎' },
    { id: 'bold', label: 'bold', text: '**big news** 🚀 we ship today' },
    { id: 'italic-code', label: 'italic + code', text: '*so* 🙌 run `npm test` first' },
    { id: 'heading', label: 'heading first', text: '# Launch day 🚀\nbody text 🎉 below' },
    { id: 'h2', label: 'subheading', text: '## Agenda 📅\n- one' },
    { id: 'quote', label: 'quote first', text: '> quoted 😂 text\nreply below' },
    { id: 'list', label: 'list first', text: '- item 🍕 one\n- item two 🎈' },
    { id: 'olist', label: 'numbered list', text: '1. first 🥇\n2. second 🥈' },
    { id: 'spoiler', label: 'spoiler + emoji', text: '||secret|| 🤫 revealed later' },
    { id: 'custom', label: 'custom emoji (DM, unavailable glyph)', text: 'nice <:party:abcdef1234> work' },
    { id: 'custom-loading', label: 'custom emoji (server, list loading)', text: 'nice <:party:abcdef1234> work', loading: true },
    { id: 'mixed', label: 'native + custom', text: 'gg 😀 <:party:abcdef1234> wp' },
    { id: 'large', label: 'Large message', text: 'big 😀 words', size: 'large' },
    { id: 'small', label: 'Small message', text: 'small 😀 words', size: 'small' },
    { id: 'span-large', label: '[large] span', text: '[large]huge 🎉 news[/large] and normal 😀' },
    { id: 'reply', label: 'reply', text: 'agreed 👍 totally', reply: 'the original 🙂 message' },
    { id: 'card-tight', label: 'card · tight padding', text: 'card 😀 text', card: TIGHT_CARD },
    { id: 'card-event', label: 'card · Event template', text: 'party 🎉 at 8', card: tpl('event') },
    { id: 'card-large', label: 'card · tight + Large', text: 'big 🎉 card', size: 'large', card: TIGHT_CARD },
    { id: 'long', label: 'long message (collapsed)', text: 'Long one 😀 starts here\n' + LOREM.repeat(24), long: true },
    { id: 'jumbo1', label: 'jumbo (1 emoji)', text: '😀' },
    { id: 'jumbo3', label: 'jumbo (3 emoji)', text: '😀🎉🔥' },
    { id: 'jumbo6', label: 'jumbo (6 emoji)', text: '😀🎉🔥🚀🍕😂' },
    { id: 'noemoji', label: 'no emoji (line-height control)', text: 'plain words only here' },
    { id: 'noemoji2', label: 'no emoji, two lines', text: 'plain words only here\nand a second line' },
];

/** A chat row like ChatPane's (avatar, name, time, reply quote, body). */
const Row: React.FC<{ p: Probe }> = ({ p }) => {
    const trimmed = p.text.trim();
    const emojiOnly = !p.long && isEmojiOnly(trimmed);
    let fontSize = scaledPx(MESSAGE_BODY_PX, p.size ?? null);
    let lineHeight: string | number = MESSAGE_BODY_LINE_HEIGHT;
    if (emojiOnly) {
        const n = countEmojis(trimmed);
        if (n <= 3) { fontSize = '3em'; lineHeight = 1.1; }
        else if (n <= 5) { fontSize = '2em'; lineHeight = 1.15; }
        else if (n <= 8) { fontSize = '1.5em'; lineHeight = 1.2; }
    }
    const card = p.card ? resolveCard(p.card, 'static') : null;
    const color = cardTextColor(card);
    const render = bodyFor(!!p.loading);
    return (
        <div data-probe={p.id} className="group relative flex gap-3 py-0.5 pr-2 pl-3 mt-3">
            <div className="w-10 h-10 shrink-0 mt-0.5 rounded-full ring-1 ring-white/5" style={{ background: 'linear-gradient(135deg, #25E0C8, #1C2542)' }} />
            <div className="relative flex flex-col min-w-0 flex-1">
                <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-[14px] font-semibold leading-tight">{p.label}</span>
                    <span className="text-[11px] text-cl-faint leading-tight">Today at 4:20 PM</span>
                </div>
                {p.reply && (
                    <div data-testid="reply-quote" className="flex flex-col gap-0.5 text-[12px] px-2 py-1.5 rounded-lg mb-1 opacity-80 border-l-2 border-cl-lume/50 bg-white/[0.03] w-fit max-w-full min-w-0 overflow-hidden cursor-pointer">
                        <span className="text-[11px] font-bold leading-tight text-cl-lume truncate">Jun</span>
                        <span className="leading-snug text-cl-text truncate">{p.reply}</span>
                    </div>
                )}
                <MessageCard resolved={card}>
                    <div data-body="" className={BODY}
                        style={{
                            fontSize, lineHeight, wordBreak: 'break-word', fontFamily: fontStackFor(null),
                            ...(!emojiOnly && p.size ? { ['--cl-msg-scale' as string]: String(sizeScaleFor(p.size)) } : {}),
                            ...(color ? { color } : {}),
                        }}>
                        {p.long
                            ? <LongMessageBody id={`lm-${p.id}`} text={p.text} renderText={render}
                                renderPreview={(t) => renderFormattedPreview(t, { renderLeaf: leafFor(false), codeText: mentionsToDisplayText })}
                                renderDeps={[]} senderName="Jun" timestamp="Today at 4:20 PM" />
                            : emojiOnly ? trimmed : render(p.text)}
                    </div>
                </MessageCard>
            </div>
        </div>
    );
};

/** The composer pill (ChatPane's .cl-composer) with the REAL RichComposer; `card` = the live card preview. */
const Composer: React.FC<{ id: string; text: string; card?: CardStyle | null }> = ({ id, text, card }) => {
    const resolved = card ? resolveCard(card, composerCardMode({ user: 'static', server: 'on', reducedMotion: false })) : null;
    return (
        <div data-probe={id} className="px-3 mt-4">
            <form className="cl-composer" data-card-preview={resolved ? '' : undefined} onSubmit={e => e.preventDefault()} style={{
                position: 'relative', display: 'flex', alignItems: 'center', gap: 4,
                background: 'var(--cl-surface)', border: '1.5px solid var(--cl-lume)', borderRadius: 26, padding: resolved ? '10px 8px 6px 10px' : '6px 6px 6px 8px',
            }}>
                <ComposerCardSurface resolved={resolved} columnWidth={W - 80}>
                    <RichComposer value={text} placeholder="Message" onChange={noop} maxLength={100000}
                        fontFamily={fontStackFor(null)}
                        className="flex-1 min-w-0 bg-transparent font-medium text-white/90"
                        style={composerTextStyle(resolved, { padding: '2px 4px' })} />
                </ComposerCardSurface>
            </form>
        </div>
    );
};

const App: React.FC = () => (
    <ToastProvider>
        {TALL && <style>{`
            @font-face{font-family:'Harness Tall Emoji';src:local('Noto Color Emoji');size-adjust:118%}
            :root{--cl-font-body:'Nunito','Harness Tall Emoji',sans-serif}
            [data-probe] [data-body], [data-probe] .rc-root{font-family:'Nunito','Harness Tall Emoji',sans-serif}
        `}</style>}
        <div id="feed" style={{ width: W, paddingBottom: 24 }} className="text-cl-text">
            {PROBES.map(p => <Row key={p.id} p={p} />)}
            <Composer id="composer" text="hey 😀 what is up" />
            <Composer id="composer-card" text="card 😀 text" card={TIGHT_CARD} />
        </div>
    </ToastProvider>
);

loadWebFonts();
createRoot(document.getElementById('root')!).render(<App />);
