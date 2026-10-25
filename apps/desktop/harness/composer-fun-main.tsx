/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import { loadWebFonts } from '../src/utils/webFonts';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { playIco } from '../src/utils/clPhysics';
import { extractMentionsFromText } from '../src/utils/mentionTokens';
import { assignRowKeys, createEntranceTracker } from '../src/utils/messageEntrance';
import {
    needsEveryoneConfirm, massMentionOf, isBigRoom, createImpactSlot, ownRowKey, createSendSpamTracker,
    charCounter, SEND_SPAM_LINES, ARROW_UP_NOTHING_LINES, BIG_PASTE_LINES, ON_THE_HOUR_LINES, FIRST_TODAY_MORNING_LINES,
    type SpamStage,
} from '../src/utils/composerFun';
import { EveryoneConfirmDialog } from '../src/components/composer/EveryoneConfirmDialog';
import { ImpactFx, SendSpamReaction, SendChime, ComposerRipple } from '../src/components/composer/ComposerFun';

/**
 * Composer touches harness. The feed rows and the composer form mirror ChatPane's markup
 * class-for-class; everything that is NEW in this change is the real module.
 *
 * Query:  ?members=<n>   server size (default 1284)   ?canMention=0   no MENTION_EVERYONE
 *         ?max=<n>       character cap for the counter demo (default 100000, the real cap)
 * Window: __fun.type(text), __fun.send(), __fun.chime(), __fun.ripple(), __fun.shrug(), __fun.paste(n)
 *         __fun.state() -> { draft, rows, ask }
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const MEMBERS = Number(q.get('members') ?? 1284);
const CAN_MENTION = q.get('canMention') !== '0';
const MAX = Number(q.get('max') ?? 100000);
const ME_DEV = 'dev-1';

type Row = { id: string; ts: number; dev: string; name: string; text: string; cid?: string };
const T0 = Date.now() - 600_000;
const SEED: Row[] = [
    { id: 's1', ts: T0, dev: 'x', name: 'Mira', text: 'is the release build up yet?' },
    { id: 's2', ts: T0 + 1000, dev: 'x', name: 'Mira', text: 'staging looks fine on my side' },
    { id: 's3', ts: T0 + 60_000, dev: 'y', name: 'Jun', text: 'yep, 1.0.23 is on the staging channel. changelog is in #releases' },
    { id: 's4', ts: T0 + 120_000, dev: 'z', name: 'Sana', text: 'tested calls + screen share on Windows, all good' },
    { id: 's5', ts: T0 + 180_000, dev: 'x', name: 'Mira', text: 'great — someone should tell the whole server' },
];

const tracker = createEntranceTracker();
const slot = createImpactSlot();
const spam = createSendSpamTracker();

const Avatar = ({ me }: { me?: boolean }) => (
    <div className="w-10 h-10 shrink-0 mt-0.5 rounded-full ring-1 ring-white/5 shadow-sm"
        style={{ background: me ? 'linear-gradient(135deg,#25E0C8,#1C2542)' : 'linear-gradient(135deg,#FF6B5E,#243056)' }} />
);

const App = () => {
    const [rows, setRows] = useState<Row[]>(SEED);
    const [draft, setDraft] = useState('');
    const [ask, setAsk] = useState<{ kind: 'everyone' | 'here'; count: number } | null>(null);
    const [spamR, setSpamR] = useState<{ stage: SpamStage; line: string; n: number } | null>(null);
    const [chime, setChime] = useState(0);
    const [ripple, setRipple] = useState(0);
    const [chip, setChip] = useState<string | null>(null);
    const [ph, setPh] = useState<string | null>(null);
    const feedRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const formRef = useRef<HTMLFormElement>(null);
    const icoRef = useRef<SVGSVGElement>(null);
    const lastH = useRef(0);
    const spamN = useRef(0);
    const draftRef = useRef(draft); draftRef.current = draft;

    // ChatPane's revealNewMessage FLIP, verbatim in effect.
    useLayoutEffect(() => {
        const el = feedRef.current, c = contentRef.current;
        if (!el) return;
        const delta = el.scrollHeight - lastH.current;
        lastH.current = el.scrollHeight;
        el.scrollTop = el.scrollHeight;
        if (!c || delta <= 2 || delta >= el.clientHeight) return;
        c.style.transition = 'none';
        c.style.transform = `translateY(${delta}px)`;
        void c.offsetHeight;
        c.style.transition = 'transform .42s cubic-bezier(.22, 1, .36, 1)';
        c.style.transform = 'translateY(0)';
        const done = () => { c.style.transition = ''; c.style.transform = ''; c.removeEventListener('transitionend', done); };
        c.addEventListener('transitionend', done);
    }, [rows.length]);

    const flashPh = (line: string) => { setPh(line); setTimeout(() => setPh(null), 2400); };
    const replay = (el: Element | null, cls: string) => {
        if (!el) return;
        el.classList.remove(cls); void (el as HTMLElement).offsetWidth; el.classList.add(cls);
        const done = (e: Event) => { if (e.target !== el) return; el.classList.remove(cls); el.removeEventListener('animationend', done); };
        el.addEventListener('animationend', done);
    };

    const send = (confirmed = false) => {
        const text = draftRef.current;
        if (!text.trim()) return;
        const mentions = extractMentionsFromText(text);
        if (needsEveryoneConfirm({ mentions, memberCount: MEMBERS, isServerChannel: true, canMention: CAN_MENTION, isEdit: false, alreadyConfirmed: confirmed })) {
            setAsk({ kind: massMentionOf(mentions) ?? 'everyone', count: MEMBERS });
            return;
        }
        if (massMentionOf(mentions) && !CAN_MENTION) { (window as any).__refused = ((window as any).__refused ?? 0) + 1; return; }
        const cid = crypto.randomUUID();
        if (CAN_MENTION && isBigRoom(MEMBERS) && massMentionOf(mentions)) slot.arm(ownRowKey(cid));
        playIco(icoRef.current, 'play-send');
        setRows(r => [...r, { id: cid, cid, ts: Date.now(), dev: ME_DEV, name: 'Dawson', text }]);
        setDraft('');
    };

    const onDisabledClick = () => {
        const stage = spam.click(Date.now());
        if (!stage) return;
        const n = ++spamN.current;
        setSpamR({ stage, line: SEND_SPAM_LINES[stage][0], n });
        setTimeout(() => setSpamR(s => (s?.n === n ? null : s)), stage === 'keys' ? 3400 : stage === 'sulk' ? 2600 : 1800);
    };

    (window as any).__fun = {
        type: (t: string) => setDraft(t),
        send: () => send(),
        chime: () => { setChime(c => c + 1); setTimeout(() => setChime(0), 1300); flashPh(ON_THE_HOUR_LINES[0]); },
        ripple: () => { setRipple(c => c + 1); setTimeout(() => setRipple(0), 1300); flashPh(FIRST_TODAY_MORNING_LINES[0]); },
        shrug: () => { flashPh(ARROW_UP_NOTHING_LINES[0]); replay(formRef.current, 'cmp-pill-shrug'); },
        paste: () => { setChip(BIG_PASTE_LINES[0]); setTimeout(() => setChip(null), 2700); },
        state: () => ({ draft: draftRef.current, rows: rows.length, ask: !!ask }),
    };

    const keys = assignRowKeys(rows.map(r => ({ id: r.id, timestamp: r.ts, sender_device_id: r.dev, content: { client_msg_id: r.cid } })), ME_DEV);
    const entering = tracker.decide(rows.map(r => ({ id: r.id, timestamp: r.ts, sender_device_id: r.dev, content: { client_msg_id: r.cid } })), keys);
    const emptyOnly = !draft.trim();
    const counter = charCounter(draft.length, MAX);
    const sulking = spamR?.stage === 'sulk' || spamR?.stage === 'keys';

    return (
        <div className="bg-cl-abyss text-white font-sans" style={{ width: 900, height: '100vh', margin: '0 auto', display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 48, display: 'flex', alignItems: 'center', padding: '0 20px', borderBottom: '1px solid var(--cl-border)' }}>
                <span className="font-display" style={{ fontSize: 16 }}># announcements</span>
                <span className="text-cl-faint" style={{ fontSize: 12, marginLeft: 12 }}>{MEMBERS.toLocaleString('en-US')} members</span>
            </div>
            <div className="relative flex-1 min-h-0 flex flex-col min-w-0">
                <div ref={feedRef} data-chat-feed="" className="flex-1 overflow-y-auto overflow-x-hidden pl-6 pr-2 py-5 flex flex-col min-w-0" style={{ overflowAnchor: 'none' }}>
                    <div ref={contentRef} className="mt-auto flex flex-col">
                        {rows.map((r, i) => {
                            const k = keys[i];
                            const ent = entering.has(k);
                            const impacting = slot.isImpacting(k, ent);
                            const showHeader = i === 0 || rows[i - 1].name !== r.name;
                            const isMe = r.dev === ME_DEV;
                            return (
                                <div key={k} id={`msg-${r.id}`} data-row={r.id}
                                    className={`group relative flex gap-3 py-0.5 pr-2 pl-3 ${showHeader ? 'mt-3' : ''} hover:bg-white/[0.015] ${ent ? (impacting ? 'cl-msg-enter-impact' : isMe ? 'cl-msg-enter-sent' : 'cl-msg-enter-recv') : ''}`}
                                    onAnimationStart={impacting ? (e) => { if (e.target === e.currentTarget && e.animationName === 'cl-msg-in-impact') replay(e.currentTarget.closest('[data-chat-feed]'), 'cl-feed-nudge'); } : undefined}
                                    onAnimationEnd={(e) => {
                                        if (e.target === e.currentTarget && e.animationName.startsWith('cl-msg-in')) {
                                            tracker.finish(k);
                                            e.currentTarget.classList.remove('cl-msg-enter-sent', 'cl-msg-enter-recv', 'cl-msg-enter-impact');
                                            slot.spend(k);
                                            (window as any).__landed = ((window as any).__landed ?? 0) + (impacting ? 1 : 0);
                                        }
                                    }}>
                                    {impacting && <ImpactFx />}
                                    {showHeader ? <Avatar me={isMe} /> : <div className="w-10 shrink-0" />}
                                    <div className="relative flex flex-col min-w-0 flex-1">
                                        {showHeader && (
                                            <div className="flex items-baseline gap-2 mb-0.5">
                                                <span className="text-[14px] font-semibold leading-tight" style={{ color: isMe ? 'var(--cl-lume)' : undefined }}>{r.name}</span>
                                                <span className="text-[11px] text-cl-faint leading-tight">Today at 10:{String(i).padStart(2, '0')} AM</span>
                                            </div>
                                        )}
                                        <div className="text-white/90 break-words whitespace-pre-wrap" style={{ fontSize: 15 }}>
                                            {r.text.split(/(@everyone|@here)/).map((p, j) => (p === '@everyone' || p === '@here')
                                                ? <span key={j} className="px-1 rounded" style={{ background: 'rgba(255,201,77,.16)', color: 'var(--cl-glow)', fontWeight: 700 }}>{p}</span>
                                                : <React.Fragment key={j}>{p.length > 400 ? p.slice(0, 400) + '…' : p}</React.Fragment>)}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        <div style={{ height: 90 }} />
                    </div>
                </div>
                <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16, zIndex: 50 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, position: 'relative', width: '100%' }}>
                        {chip && <div className="cmp-chip" aria-hidden="true" data-paste-chip="">{chip}</div>}
                        <form ref={formRef} className="cl-composer" onSubmit={(e) => { e.preventDefault(); send(); }}
                            style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, background: 'var(--cl-surface)', border: '1.5px solid var(--cl-border)', borderRadius: 26, padding: '6px 6px 6px 8px', boxShadow: '0 2px 12px rgba(0,0,0,.22)' }}>
                            {ripple > 0 && <ComposerRipple key={ripple} />}
                            <textarea data-chat-input rows={1} value={draft} maxLength={MAX}
                                placeholder={ph ?? 'Message #announcements'}
                                onChange={(e) => { setDraft(e.target.value); if (e.target.value.trim()) { spam.reset(); setSpamR(null); } }}
                                onKeyDown={(e) => {
                                    if (e.key === 'ArrowUp' && !draft) { (window as any).__fun.shrug(); return; }
                                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                                }}
                                className="flex-1 min-w-0 bg-transparent border-none outline-none ring-0 text-[14.5px] font-medium resize-none text-white/90 placeholder-white/25"
                                style={{ display: 'block', padding: '2px 4px', lineHeight: '22px', minHeight: 22, maxHeight: 260, overflow: 'hidden', outline: 'none', boxShadow: 'none', border: 0 }} />
                            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                {counter && (
                                    <span className={`cmp-counter ${counter.full ? 'is-full' : counter.remaining <= MAX * 0.02 ? 'is-near' : ''}`} aria-hidden="true" data-char-counter="">
                                        {counter.full ? 'Limit reached' : `${counter.remaining.toLocaleString('en-US')} left`}
                                    </span>
                                )}
                                <span className="cmp-send-wrap">
                                    {chime > 0 && <SendChime key={chime} />}
                                    {spamR && <SendSpamReaction key={spamR.n} stage={spamR.stage} line={spamR.line} />}
                                    <button type={emptyOnly ? 'button' : 'submit'} aria-disabled={emptyOnly ? true : undefined}
                                        onClick={emptyOnly ? onDisabledClick : undefined}
                                        className={`cl-send-btn${spamR?.stage === 'wobble' ? ' spam-wobble' : ''}${sulking ? ' spam-sulk' : ''}`} aria-label="Send" title="Send">
                                        <Send ref={icoRef} className="cl-ico w-[17px] h-[17px]" style={{ marginRight: 1, marginTop: 1 }} />
                                    </button>
                                </span>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
            {ask && (
                <EveryoneConfirmDialog kind={ask.kind} memberCount={ask.count}
                    onCancel={() => setAsk(null)}
                    onConfirm={() => { setAsk(null); send(true); }} />
            )}
        </div>
    );
};

createRoot(document.getElementById('root')!).render(<App />);
