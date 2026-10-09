/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import { ReactionPill } from '../src/components/ChatPane';
import FileViewer from '../src/components/FileViewer';

/**
 * The reaction chip as ChatPane lays it out, in the message shapes the owner
 * compares. The row / column / reactions-row wrappers below are copied
 * class-for-class from ChatPane's message row; the chip is the REAL
 * ReactionPill and the image is the REAL FileViewer.
 *
 *   ?off=<px>   fractional y offset above each case (a scroll phase)
 *   ?emoji=...  reaction glyph (default a red circle: symmetric ink)
 */
const q = new URLSearchParams(location.search);
const off = Number(q.get('off') ?? 0);
const scene = q.get('scene') ?? 'static';
const willChange = q.get('wc') !== '0'; // ChatPane's content column is permanently will-change:transform
const grow = Number(q.get('grow') ?? 0); // extra px on the follow-up row
const enter = q.get('enter'); // 'sent' | 'recv': leave the row's entrance class on (its fill-forward end state)
const emoji = q.get('emoji') ?? '\u{1F534}';

// 600x400 image -> 320px wide, 213.33px tall (a FRACTIONAL height, as real
// photos have).
const c = document.createElement('canvas'); c.width = 600; c.height = 400;
const g = c.getContext('2d')!; g.fillStyle = '#2a6'; g.fillRect(0, 0, 600, 400); g.fillStyle = '#fc3'; g.fillRect(100, 80, 300, 200);
const IMG = c.toDataURL('image/png');

const noop = () => {};
const Pill = ({ k, count = 1, mine = false }: { k: string; count?: number; mine?: boolean }) => (
    <ReactionPill emoji={emoji} animKey={`${k}:${emoji}`} msgId={k} count={count} hasMine={mine} canReact
        resolveEmoji={undefined} token={null} onClick={noop} onHoverStart={noop} onHoverEnd={noop} onContextMenuShow={noop} />
);
const Reactions = ({ k, mine }: { k: string; mine?: boolean }) => (
    <div className="flex flex-wrap gap-1.5 mt-1.5"><Pill k={k} mine={mine} /></div>
);
const Row = ({ header, children }: { header?: boolean; children: React.ReactNode }) => (
    <div className={`group relative flex gap-3 py-0.5 pr-2 pl-3 ${header ? 'mt-3' : ''} ${enter ? `cl-msg-enter-${enter}` : ''}`}>
        {header ? <div className="w-10 h-10 rounded-full bg-white/10 shrink-0" /> : <div className="w-10 shrink-0" />}
        <div className="relative flex flex-col min-w-0 flex-1">{children}</div>
    </div>
);
const Text = ({ t }: { t: string }) => <div className="text-[14px] leading-relaxed">{t}</div>;
const Img = () => (
    <div className="flex flex-col w-full items-start">
        <FileViewer objectUrl={IMG} filename="p.png" mime="image/png" />
    </div>
);

function Case({ id, children }: { id: string; children: React.ReactNode }) {
    return <div data-case={id} style={{ width: 520, display: 'flow-root', marginTop: off, marginBottom: 12, paddingBottom: 12, background: '#0b1020', color: '#dfe6f5' }}>{children}</div>;
}


/**
 * scene=feed: ChatPane's real feed shell (scroller classes, the permanent
 * `will-change: transform` content column, the same FLIP slide as
 * revealNewMessage) with an image message that has a reaction, and a
 * follow-up message appended on demand by window.__follow().
 */
function Feed() {
    const feedRef = React.useRef<HTMLDivElement>(null);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const lastH = React.useRef(0);
    const [followed, setFollowed] = React.useState(false);
    const pendingReveal = React.useRef(false);
    React.useLayoutEffect(() => { // initial: land on the bottom, as the app does
        const el = feedRef.current!; el.scrollTop = el.scrollHeight; lastH.current = el.scrollHeight;
    }, []);
    React.useLayoutEffect(() => {
        if (!pendingReveal.current) return;
        pendingReveal.current = false;
        const el = feedRef.current!, c = contentRef.current!;
        const delta = el.scrollHeight - lastH.current; lastH.current = el.scrollHeight;
        el.scrollTop = el.scrollHeight;
        if (!c || delta <= 2 || delta >= el.clientHeight) return;
        c.style.transition = 'none'; c.style.transform = `translateY(${delta}px)`; void c.offsetHeight;
        c.style.transition = 'transform .42s cubic-bezier(.22, 1, .36, 1)'; c.style.transform = 'translateY(0)';
        const onEnd = () => { c.style.transition = ''; c.style.transform = ''; c.removeEventListener('transitionend', onEnd); (window as any).__flipDone = true; };
        c.addEventListener('transitionend', onEnd);
    }, [followed]);
    (window as any).__follow = () => { pendingReveal.current = true; (window as any).__flipDone = false; (window as any).__enterDone = false; setFollowed(true); };
    return (
        <div style={{ width: 560, height: 380, display: 'flex', flexDirection: 'column', background: '#0b1020', color: '#dfe6f5' }}>
            <div ref={feedRef} data-feed className="flex-1 overflow-y-auto overflow-x-hidden pl-6 pr-2 py-4 flex flex-col min-w-0" style={{ overflowAnchor: 'none' }}>
                <div className="flex-1" />
                <div ref={contentRef} className="flex flex-col" style={willChange ? { willChange: 'transform' } : undefined}>
                    <Row header><Text t="earlier" /></Row>
                    <Row header><Text t="a first message" /></Row>
                    <Row><div data-target-wrap><Img /><Reactions k="f1" /></div></Row>
                    {followed && (
                        // The follow-up row enters exactly like ChatPane's: the entrance class
                        // (will-change + animation) until its own animationend strips it.
                        <div className={`group relative flex gap-3 py-0.5 pr-2 pl-3 ${q.get('fe') === '0' ? '' : 'cl-msg-enter-sent'}`}
                            onAnimationEnd={(e) => { if (e.target === e.currentTarget && e.animationName.startsWith('cl-msg-in')) { e.currentTarget.classList.remove('cl-msg-enter-sent', 'cl-msg-enter-recv'); (window as any).__enterDone = true; } }}>
                            <div className="w-10 shrink-0" />
                            <div className="relative flex flex-col min-w-0 flex-1" style={{ paddingBottom: grow }}><Text t="the follow-up under the image" /></div>
                        </div>
                    )}
                </div>
                <div style={{ height: 64 }} />
            </div>
        </div>
    );
}

/**
 * scene=phase: N bare chips, each in a slot 40 + 1/16 px tall, so successive
 * chips sit at successive 1/16-px fractional offsets (every sub-pixel phase a
 * scrolling feed can put a chip at). The unit under test is the chip alone.
 */
function Phases() {
    const n = Number(q.get('n') ?? 32);
    return (
        <div style={{ padding: 8, width: 120, background: '#0b1020' }}>
            {Array.from({ length: n }, (_, i) => (
                <div key={i} data-slot style={{ height: Number(q.get('sh') ?? 40) + 1 / 16, display: 'flex', alignItems: 'flex-start' }}>
                    <Pill k={`p${i}`} />
                </div>
            ))}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    scene === 'phase' ? <Phases /> : scene === 'feed' ? <Feed /> : (
    <div style={{ padding: 8 }}>
        <Case id="text"><Row header><Text t="hello there" /><Reactions k="t1" /></Row></Case>
        <Case id="text-mine"><Row header><Text t="hello there" /><Reactions k="t1m" mine /></Row></Case>
        <Case id="image-alone"><Row header><Img /><Reactions k="i1" /></Row></Case>
        <Case id="image-followed"><Row header><Img /><Reactions k="i2" /></Row><Row><Text t="a follow-up message" /></Row></Case>
        <Case id="continuation-text"><Row header><Text t="first" /></Row><Row><Text t="second, reacted" /><Reactions k="c1" /></Row></Case>
    </div>)
);
(window as any).__ready = true;
