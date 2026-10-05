import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, useAnimationControls } from 'framer-motion';
import { Camera, Trash2, Info, Copy, Check, Download, AlertTriangle, ChevronRight, Sparkles, Lock, ShieldCheck, KeyRound, Heart, MessageSquare, Save, FileUp, Users, MonitorUp, Code2, EyeOff, CupSoda, type LucideIcon } from 'lucide-react';
import { USERNAME_REGEX } from '@cipherline/shared';
import { ClButton } from './ClButton';
import { ClInput, ClTextarea, ClCheckbox, ClImageCropper } from './cl';
import { RetentionChoiceTable } from './RetentionChoiceTable';
import { RECOMMENDED_RETENTION } from '../utils/deviceStorageSetup';
import {
    type MessageRetention, type AttachmentRetention,
    ATTACHMENT_RETENTION_LABELS,
} from '../hooks/useRetentionPolicy';
import { AVATAR_OUTPUT } from '../utils/imageCrop';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../utils/imageUploadValidation';
import { bubbleCount, makeBubbles } from '../utils/deepField';
import { useSubscription } from '../contexts/SubscriptionContext';
import { Keys } from './mascot/Keys';
import { useEscape } from '../hooks/useEscape';

/* ─── Types ────────────────────────────────────────────────────────────────── */

export interface WizardResult {
    avatarBlob: Blob | null;
    displayName: string;
    bio: string;
    dmMessageRetention: MessageRetention;
    dmAttachmentRetention: AttachmentRetention;
    groupMessageRetention: MessageRetention;
    groupAttachmentRetention: AttachmentRetention;
    serverMessageRetention: MessageRetention;
    serverAttachmentRetention: AttachmentRetention;
}

interface RegistrationWizardProps {
    username: string;
    /** Persists the profile (avatar, bio, retention). Does NOT log in. */
    onComplete: (result: WizardResult) => Promise<void>;
    /** Called after the outro animation finishes — performs the deferred login. */
    onEnter: () => void;
    /** Live session token issued at email verification. */
    authToken?: string;
    /** Whether /auth/finalize actually started this account's free trial.
     *  `false` means the P2-BILL-6 anti-farming quota withheld it (shared
     *  network region with other recent signups) — the feature-showcase step
     *  must say so instead of presenting a trial that doesn't exist.
     *  `undefined` (older API build, or this prop simply not wired by a
     *  caller) means "say nothing", never "assume withheld". */
    trialGranted?: boolean;
}

// TOTAL_STEPS is 4 normally, 5 when the checkout step is inserted between the reel and profile.

// LUME/ABYSS/FAINT are exact duplicates of --cl-lume/--cl-abyss/--cl-faint
// (verified against index.css) — tokenized so the illustration actually
// tracks the real palette instead of a frozen copy of it. These render as
// inline SVG in the same document as the rest of the app (not inside an
// iframe/canvas), so var(--cl-*) resolves normally here. BLUE has no
// matching token — it's a deliberate secondary accent for visual variety
// in the feature-card grid below, left as its own literal.
const LUME  = 'var(--cl-lume)';
const BLUE  = '#5e8ee0';
const ABYSS = 'var(--cl-abyss)';
const FAINT = 'var(--cl-faint)';

/* ─── Logo lockup — mark + wordmark (single colour, no accent) ───────────────
   The mascot itself is the shared articulated Keys (components/mascot/Keys.tsx)
   everywhere in the wizard now — the old inline AnimatedMark SVG copy is gone.
   Sizes are ×1.25 the old square-viewBox sizes: Keys' wider 110-unit viewBox
   pads the sides, so the visible body width is unchanged. Display-only
   (interactive={false}) and never wave-on-mount — the session hello belongs to
   the home deck; celebrations use the controlled `wave` prop instead. */

const LogoLockup: React.FC<{ markSize?: number; textClass?: string }> = ({ markSize = 30, textClass = 'text-xl' }) => (
    <div className="flex items-center gap-2.5">
        <Keys size={Math.round(markSize * 1.25)} interactive={false} waveOnMount={false} />
        <span
            className={`${textClass} font-bold leading-none tracking-tight`}
            style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)' }}
        >
            Cipherline
        </span>
    </div>
);

/* ─── Cinematic background — cohesive depth + the sign-up's drifting dots ─────
   Shares the deep-field bubbles + aurora wash with AuthScreen (same CSS classes,
   same generator) so the floating dots appear to *persist* straight through the
   verify-email → wizard handoff rather than cutting to a different backdrop.
─────────────────────────────────────────────────────────────────────────── */

const CinematicBackground: React.FC = () => {
    const reduced = useReducedMotion();
    // Generated once — a stable field for the lifetime of the wizard.
    const [bubbles] = useState(() => makeBubbles(bubbleCount()));
    return (
        <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }} aria-hidden>
            <div
                className="absolute inset-0"
                style={{ background: 'radial-gradient(125% 90% at 50% -10%, #15203B 0%, #0B0F1E 52%, #070A14 100%)' }}
            />
            {/* aurora wash (same family as the sign-up backdrop) */}
            <div className="auth-aurora" />
            {/* floating dots — dissolve in so the handoff reads as continuous */}
            <motion.div
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.7, ease: 'easeOut' }}
            >
                {bubbles.map((b, i) => (
                    <span
                        key={i}
                        className="auth-bubble"
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        style={{ left: b.left, width: b.size, height: b.size, ['--dur' as any]: b.dur, ['--delay' as any]: b.delay, ['--sway' as any]: b.sway }}
                    />
                ))}
            </motion.div>
            <motion.div
                className="absolute"
                style={{
                    width: '78vw', height: '78vw', left: '50%', top: '-22%',
                    transform: 'translateX(-50%)', borderRadius: '50%', filter: 'blur(50px)',
                    background: 'radial-gradient(circle, rgba(37,224,200,0.10) 0%, rgba(37,224,200,0.03) 38%, transparent 62%)',
                }}
                animate={reduced ? {} : { opacity: [0.5, 0.85, 0.5], scale: [1, 1.06, 1] }}
                transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
            />
            <div
                className="absolute inset-0"
                style={{ background: 'radial-gradient(125% 105% at 50% 50%, transparent 58%, rgba(0,0,0,0.5) 100%)' }}
            />
        </div>
    );
};

/* ─── Step progress dots ────────────────────────────────────────────────────  */

const StepDots: React.FC<{ current: number; total: number }> = ({ current, total }) => (
    <div className="flex gap-2 items-center">
        {Array.from({ length: total }, (_, i) => (
            <motion.div
                key={i}
                className="rounded-full"
                animate={{
                    width: i + 1 === current ? 22 : 6,
                    background: i + 1 === current ? LUME : 'rgba(255,255,255,0.15)',
                }}
                transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                style={{ height: 6 }}
            />
        ))}
    </div>
);

/* ─── Scene chrome ──────────────────────────────────────────────────────────  */

const SceneStage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="w-full flex justify-center mb-1" style={{ height: 150 }}>
        <svg viewBox="0 0 340 150" style={{ width: '100%', maxWidth: 380 }} role="img">
            {children}
        </svg>
    </div>
);

/* ── Step-1 cinematic: "Keys" teaches the E2EE journey ───────────────────────
   A full-screen cutscene. Keys (the mascot) narrates six beats while one teal
   message travels through a skeleton of the app: it appears in YOUR chat, locks
   (the key stays behind on your device), slides down the line to a blind server
   that can't read it and deletes its copy once it's delivered, then arrives —
   identical — in your friend's chat. Timed + auto-advancing, with a ghost
   "Skip" control (fades in once Keys settles into place, ~1.5s in — not on
   mount, so it doesn't undercut the first beat) and Esc as a keyboard
   equivalent. Skipping calls the exact same onFinish() a natural finish does,
   so it lands on the same next state (and marks cutsceneSeen) with every
   pending timer explicitly cancelled first — no double-fire, no timer that
   outlives the skip and advances the wizard again. Motion-reduced users get a
   static, self-paced summary instead (forcing a timed animation on them would
   be an accessibility failure); its own "Got it" button already serves as
   that path's skip, so no redundant control is added there — Esc still works
   for it via the same handler.
─────────────────────────────────────────────────────────────────────────── */

interface CutBeat {
    station: 'you' | 'server' | 'them';   // where Keys narrates from this beat
    align: 'start' | 'center' | 'end';    // where the caption sits
    badge: 'greet' | 'send' | 'lock' | 'relay' | 'deliver' | 'keys';
    dur: number;
    caption: string;
    emphasis: string;                     // the phrase within `caption` to highlight
}

const CUT_BEATS: CutBeat[] = [
    { station: 'server', align: 'center', badge: 'greet',   dur: 3000, caption: 'Hi — I’m Keys. Watch a message make the trip.',                                          emphasis: 'make the trip' },
    { station: 'you',    align: 'start',  badge: 'send',    dur: 3300, caption: 'You send a message — here it is in your chat.',                                            emphasis: 'in your chat' },
    { station: 'you',    align: 'start',  badge: 'lock',    dur: 3600, caption: 'It locks on your device. The key to open it never leaves.',                                emphasis: 'never leaves' },
    { station: 'server', align: 'center', badge: 'relay',   dur: 4100, caption: 'Sealed, it reaches our server — we don’t have your key, so we can’t read it.',             emphasis: 'can’t read it' },
    { station: 'them',   align: 'end',    badge: 'deliver', dur: 4100, caption: 'We pass it on, then delete our copy. It opens on their device — just as you sent it.',     emphasis: 'delete our copy' },
    { station: 'server', align: 'center', badge: 'keys',    dur: 3800, caption: 'Your keys never leave your devices. Not even we have them.',                              emphasis: 'never leave your devices' },
];

// The distilled takeaways, shown as a persistent checklist that fills in as the
// matching beat is reached — so the key points stay readable even if a caption
// scrolls by faster than you can read it. `atBeat` maps to the CUT_BEATS index.
const KEY_POINTS: { atBeat: number; label: string; color: string }[] = [
    { atBeat: 1, label: 'It appears in your chat',            color: LUME },
    { atBeat: 2, label: 'Locked here — the key never leaves', color: LUME },
    { atBeat: 3, label: 'The server can’t read it',           color: LUME },
    { atBeat: 4, label: 'Delivered, then our copy is deleted', color: 'var(--cl-flash)' },
    { atBeat: 5, label: 'Your keys never leave your devices',  color: 'var(--cl-glow)' },
];

/** Render a caption with its key phrase emphasized (bold + the beat's accent),
 *  so the important bit catches the eye even on a quick read. */
function renderCaption(caption: string, emphasis: string, color: string): React.ReactNode {
    const i = caption.indexOf(emphasis);
    if (i < 0) return caption;
    return (
        <>
            {caption.slice(0, i)}
            <span style={{ color, fontWeight: 800 }}>{emphasis}</span>
            {caption.slice(i + emphasis.length)}
        </>
    );
}

// Reaction badge that pops beside Keys at each beat.
const BADGES: Record<CutBeat['badge'], { Icon: LucideIcon; color: string }> = {
    greet:   { Icon: Sparkles,      color: LUME },
    send:    { Icon: MessageSquare, color: LUME },
    lock:    { Icon: Lock,          color: LUME },
    relay:   { Icon: ShieldCheck,   color: LUME },
    deliver: { Icon: Heart,         color: 'var(--cl-flash)' },
    keys:    { Icon: KeyRound,      color: 'var(--cl-glow)' },
};

// Horizontal position of each station as a % of the stage width, aligned to the
// journey scene below: the sender window centres on 118/520, the server on
// 260/520, the recipient window on 402/520 — so Keys floats over the right spot.
const STATION_PCT: Record<CutBeat['station'], number> = { you: 22.7, server: 50, them: 77.3 };

const KeyGlyph: React.FC<{ cx: number; cy: number; scale?: number }> = ({ cx, cy, scale = 1 }) => (
    <g stroke="var(--cl-glow)" strokeWidth={2 * scale} strokeLinecap="round" fill="none"
        transform={`translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})`}>
        <circle cx={cx - 5} cy={cy} r="3.6" />
        <path d={`M${cx - 1.4} ${cy} H${cx + 8}`} />
        <path d={`M${cx + 4} ${cy} v3`} />
        <path d={`M${cx + 8} ${cy} v3.5`} />
    </g>
);

/* A skeleton of the app window — title bar, sidebar, chat column. The live
   message bubble is drawn separately so the journey can animate it. */
const AppWindow: React.FC<{ x: number }> = ({ x }) => {
    const W = 206, H = 158, y = 12, x2 = x + W;
    return (
        <g>
            <rect x={x} y={y} width={W} height={H} rx={15} fill="rgba(20,28,48,0.55)" stroke="rgba(37,224,200,0.22)" strokeWidth="2" />
            {/* title bar */}
            <line x1={x} y1={y + 26} x2={x2} y2={y + 26} stroke="rgba(167,179,212,0.14)" strokeWidth="1" />
            <circle cx={x + 16} cy={y + 13} r="2.6" fill="rgba(255,107,94,0.6)" />
            <circle cx={x + 26} cy={y + 13} r="2.6" fill="rgba(255,201,77,0.6)" />
            <circle cx={x + 36} cy={y + 13} r="2.6" fill="rgba(37,224,200,0.6)" />
            {/* sidebar */}
            <rect x={x + 10} y={y + 34} width="40" height={H - 46} rx="9" fill="rgba(255,255,255,0.03)" />
            {[0, 1, 2, 3].map(i => (
                <rect key={i} x={x + 17} y={y + 46 + i * 19} width="26" height="6.5" rx="3" fill="rgba(167,179,212,0.16)" />
            ))}
        </g>
    );
};

/* The blind server, drawn as a little rack: a top status "display" showing a
   struck-through eye (it holds the sealed message but can't see inside) over two
   blades with LEDs + vent slots. `scan` lights it up while it's being inspected. */
const ServerRack: React.FC<{ scan: boolean }> = ({ scan }) => {
    const cx = 260;
    return (
        <g>
            {/* chassis */}
            <rect x={cx - 34} y={196} width="68" height="80" rx="11" fill="rgba(18,26,46,0.78)" stroke="rgba(167,179,212,0.34)" strokeWidth="2" />
            {/* top blade = status display with a struck-through eye */}
            <rect x={cx - 27} y={203} width="54" height="22" rx="5" fill="rgba(8,12,26,0.7)" stroke="rgba(167,179,212,0.16)" strokeWidth="1" />
            <motion.g
                animate={{ opacity: scan ? [0.7, 1, 0.7] : 0.7 }}
                transition={{ duration: 1.4, repeat: scan ? Infinity : 0 }}
            >
                <path d={`M${cx - 9} 214 q9 -9.5 18 0 q-9 9.5 -18 0`} fill="none" stroke={scan ? 'var(--cl-flash)' : FAINT} strokeWidth="1.5" />
                <circle cx={cx} cy={214} r="2.3" fill={scan ? 'var(--cl-flash)' : FAINT} />
                <line x1={cx - 11} y1={207} x2={cx + 11} y2={221} stroke="var(--cl-flash)" strokeWidth="1.8" strokeLinecap="round" />
            </motion.g>
            {/* two rack blades — status LED + amber LED + vent slots */}
            {[0, 1].map(i => {
                const by = 231 + i * 22;
                return (
                    <g key={i}>
                        <rect x={cx - 27} y={by} width="54" height="18" rx="4" fill="rgba(255,255,255,0.035)" stroke="rgba(167,179,212,0.14)" strokeWidth="1" />
                        <motion.circle
                            cx={cx - 19} cy={by + 9} r="2.3" fill={LUME}
                            animate={{ opacity: scan ? [1, 0.25, 1] : 0.85 }}
                            transition={{ duration: 0.9, repeat: scan ? Infinity : 0, delay: i * 0.2 }}
                        />
                        <circle cx={cx - 11} cy={by + 9} r="2.3" fill="rgba(255,201,77,0.55)" />
                        {[0, 1, 2, 3].map(v => (
                            <line key={v} x1={cx + 3 + v * 6} y1={by + 4} x2={cx + 3 + v * 6} y2={by + 14} stroke="rgba(167,179,212,0.22)" strokeWidth="1.5" strokeLinecap="round" />
                        ))}
                    </g>
                );
            })}
        </g>
    );
};

// Coordinates the journey animation pivots around (viewBox 520 × 296).
const SEND_BUBBLE = { x: 176, y: 86 };    // your sent bubble (right side of your chat)
const RECV_BUBBLE = { x: 384, y: 86 };    // their received bubble (left side of theirs)
const SERVER_PT   = { x: 260, y: 238 };   // where the sealed message rests in the rack

const JourneyStage: React.FC<{ beat: number }> = ({ beat }) => {
    const reduced = useReducedMotion();

    const sendBubbleOn = beat >= 1;          // appears in your chat and stays
    const senderKeyOn  = beat >= 2;          // key left behind on your device
    const recvBubbleOn = beat >= 4;          // arrives intact on their device
    const recvKeyOn    = beat >= 4;          // their key opens it
    const keysGlow     = beat === 5;         // final "keys never leave" emphasis
    const line1On      = beat >= 2 && beat <= 3;   // you → server
    const line2On      = beat === 4;               // server → them
    const serverScan   = beat === 3;               // blind server, can't read
    const serverDelete = beat === 4;               // copy wiped after delivery

    // The sealed token: at your device (lock), down at the server, then up to them.
    const tokenPos     = beat <= 2 ? SEND_BUBBLE : beat === 3 ? SERVER_PT : RECV_BUBBLE;
    const tokenShown   = beat >= 2 && beat <= 4;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenOpacity: any = !tokenShown ? 0 : beat === 4 ? [1, 0] : 1;

    return (
        <svg viewBox="0 0 520 296" style={{ width: '100%', maxWidth: 520 }} role="img" aria-hidden="true">
            <AppWindow x={15} />
            <AppWindow x={299} />
            <text x={118} y={186} textAnchor="middle" fill={FAINT} fontSize="12">Your device</text>
            <text x={402} y={186} textAnchor="middle" fill={FAINT} fontSize="12">Their device</text>

            {/* faint existing chat history, so the windows read as live chats */}
            <rect x={72}  y={52} width="46" height="9" rx="4.5" fill="rgba(167,179,212,0.12)" />
            <rect x={449} y={52} width="40" height="9" rx="4.5" fill="rgba(37,224,200,0.10)" />

            {/* the travel lines (down into the server, then up to them) */}
            <motion.line
                x1={SEND_BUBBLE.x} y1={SEND_BUBBLE.y + 13} x2={SERVER_PT.x} y2={196}
                stroke="rgba(37,224,200,0.30)" strokeWidth="2" strokeDasharray="2 8" strokeLinecap="round"
                animate={{ opacity: line1On ? 1 : 0 }} transition={{ duration: 0.5 }}
            />
            <motion.line
                x1={SERVER_PT.x} y1={196} x2={RECV_BUBBLE.x} y2={RECV_BUBBLE.y + 13}
                stroke="rgba(37,224,200,0.30)" strokeWidth="2" strokeDasharray="2 8" strokeLinecap="round"
                animate={{ opacity: line2On ? 1 : 0 }} transition={{ duration: 0.5 }}
            />

            {/* your sent bubble — a plain teal message, no text */}
            <motion.g
                animate={{ opacity: sendBubbleOn ? 1 : 0, y: sendBubbleOn ? 0 : 8 }}
                transition={{ duration: 0.45, ease: [0.34, 1.56, 0.64, 1] }}
            >
                <rect x={SEND_BUBBLE.x - 31} y={SEND_BUBBLE.y - 12} width="62" height="24" rx="11" fill={LUME} />
            </motion.g>

            {/* their received bubble — identical, appears as the message arrives */}
            <motion.g
                animate={{ opacity: recvBubbleOn ? 1 : 0, y: recvBubbleOn ? 0 : 8 }}
                transition={{ duration: 0.45, ease: [0.34, 1.56, 0.64, 1], delay: beat === 4 ? 0.55 : 0 }}
            >
                <rect x={RECV_BUBBLE.x - 31} y={RECV_BUBBLE.y - 12} width="62" height="24" rx="11" fill={LUME} />
            </motion.g>

            {/* the blind server (a little rack) */}
            <ServerRack scan={serverScan} />
            <text x={260} y={291} textAnchor="middle" fill={FAINT} fontSize="12">Server — can’t read</text>
            {/* the server's copy is wiped once delivered */}
            {serverDelete && (
                <motion.circle
                    cx={SERVER_PT.x} cy={SERVER_PT.y} fill="none" stroke="var(--cl-flash)" strokeWidth="1.5"
                    initial={{ r: 10, opacity: 0.6 }} animate={{ r: 34, opacity: 0 }} transition={{ duration: 0.95, delay: 0.1 }}
                />
            )}

            {/* keys that stay home on each device */}
            <motion.g
                animate={{ opacity: senderKeyOn ? (keysGlow ? [1, 0.5, 1] : 1) : 0 }}
                transition={{ duration: keysGlow ? 1.4 : 0.4, repeat: keysGlow ? Infinity : 0 }}
            >
                <KeyGlyph cx={150} cy={140} scale={1.4} />
            </motion.g>
            <motion.g
                animate={{ opacity: recvKeyOn ? (keysGlow ? [1, 0.5, 1] : 1) : 0 }}
                transition={{ duration: keysGlow ? 1.4 : 0.4, repeat: keysGlow ? Infinity : 0 }}
            >
                <KeyGlyph cx={410} cy={140} scale={1.4} />
            </motion.g>

            {/* the sealed message in transit */}
            <motion.g
                animate={{ x: tokenPos.x, y: tokenPos.y, opacity: tokenOpacity }}
                transition={{
                    x: { duration: 0.85, ease: 'easeInOut' },
                    y: { duration: 0.85, ease: 'easeInOut' },
                    opacity: { duration: beat === 4 ? 0.5 : 0.3, delay: beat === 4 ? 0.55 : 0 },
                }}
            >
                <motion.rect
                    x="-16" y="-16" width="32" height="32" rx="9" fill={ABYSS} stroke={LUME} strokeWidth="2.5"
                    animate={reduced ? {} : { filter: [
                        'drop-shadow(0 0 2px rgba(37,224,200,0.3))',
                        'drop-shadow(0 0 9px rgba(37,224,200,0.65))',
                        'drop-shadow(0 0 2px rgba(37,224,200,0.3))',
                    ] }}
                    transition={{ duration: 1.8, repeat: Infinity }}
                />
                {/* padlock — the message is sealed shut */}
                <rect x="-7" y="0.5" width="14" height="11" rx="2.5" fill={LUME} />
                <path d="M-4.3 0.5 v-3.8 a4.3 4.3 0 0 1 8.6 0 v3.8" fill="none" stroke={LUME} strokeWidth="2" />
            </motion.g>
        </svg>
    );
};

// Exported (only) as a test seam — RegistrationWizard is the sole real
// consumer, rendered internally below.
export const KeysCutscene: React.FC<{ onFinish: () => void }> = ({ onFinish }) => {
    const reduced = !!useReducedMotion();
    const [beat, setBeat] = useState(0);
    // One-time entrance: Keys + the scene float into place and settle BEFORE the
    // first beat starts narrating, so nothing feels cut off the moment it appears.
    const [intro, setIntro] = useState(true);
    const finishRef = useRef(onFinish);
    useEffect(() => { finishRef.current = onFinish; }, [onFinish]);

    // Teardown safety for skip (and, defensively, for natural finish too): every
    // timer this component arms is tracked here so it can be cancelled outright,
    // not just left to an effect-cleanup that won't run until AnimatePresence
    // actually unmounts us (which happens ~0.5s AFTER onFinish fires, during the
    // exit fade) — without this, a beat timer armed before skip can still land
    // mid-exit and silently advance state a second time. `doneRef` makes finish()
    // itself idempotent so onFinish is called exactly once no matter how many
    // paths reach it (skip click, Esc, natural completion).
    const doneRef = useRef(false);
    const introTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const beatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const finish = useCallback(() => {
        if (doneRef.current) return;
        doneRef.current = true;
        if (introTimerRef.current) { clearTimeout(introTimerRef.current); introTimerRef.current = null; }
        if (beatTimerRef.current) { clearTimeout(beatTimerRef.current); beatTimerRef.current = null; }
        finishRef.current();
    }, []);

    // Esc mirrors the visible Skip control (and, harmlessly, the reduced-motion
    // fallback's "Got it" button) — nothing else in the wizard binds Escape.
    useEscape(finish);

    // Reduced-motion users get the static fallback (which never reads `intro`), so
    // there's nothing to schedule — leave intro alone and skip the timer.
    useEffect(() => {
        if (reduced) return;
        introTimerRef.current = setTimeout(() => { introTimerRef.current = null; setIntro(false); }, 1100);
        return () => { if (introTimerRef.current) { clearTimeout(introTimerRef.current); introTimerRef.current = null; } };
    }, [reduced]);

    // Keys gives a soft settle on arrival at each beat — driven by controls (not a
    // remount) so the mascot stays mounted across beats: its tentacles keep their
    // flow and its eyes keep blinking on their own schedule instead of restarting.
    // The dip is delayed to land near the END of the glide so it reads as Keys
    // settling into place rather than lurching the moment he sets off. Beat 0 is
    // skipped — Keys floats into position via the intro entrance, not a hop.
    const hop = useAnimationControls();
    useEffect(() => {
        if (reduced || beat === 0) return;
        hop.set({ y: -6 });
        hop.start({ y: 0, transition: { type: 'spring', stiffness: 140, damping: 16, delay: 0.45 } });
    }, [beat, hop, reduced]);

    // Auto-advance — held until the intro entrance settles, so beat 0 gets its full
    // dwell once Keys is in place (no rushing the greeting while he's still arriving).
    useEffect(() => {
        if (reduced || intro) return;
        if (beat >= CUT_BEATS.length) { finish(); return; }
        beatTimerRef.current = setTimeout(() => { beatTimerRef.current = null; setBeat(b => b + 1); }, CUT_BEATS[beat].dur);
        return () => { if (beatTimerRef.current) { clearTimeout(beatTimerRef.current); beatTimerRef.current = null; } };
    }, [beat, reduced, intro, finish]);

    // Accessible fallback: static, self-paced.
    if (reduced) {
        return (
            <motion.div
                className="absolute inset-0 flex items-center justify-center px-6"
                style={{ zIndex: 20 }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            >
                <div className="flex flex-col items-center text-center" style={{ maxWidth: 460 }}>
                    <Keys size={105} interactive={false} waveOnMount={false} />
                    <h2 className="mt-4 mb-4 text-2xl font-bold" style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)' }}>
                        How Cipherline keeps your messages yours
                    </h2>
                    <ul className="text-left text-sm text-cl-muted leading-relaxed space-y-2 mb-7">
                        <li>• Every message is locked on your device before it leaves — the key to open it stays with you.</li>
                        <li>• Our server only relays a sealed message; we don’t have your key, so we can’t read it.</li>
                        <li>• We hold it just until it’s delivered, then delete our copy.</li>
                        <li>• It opens on your friend’s device exactly as you sent it. The keys never leave your devices.</li>
                    </ul>
                    <ClButton onClick={finish}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>Got it <ChevronRight size={16} /></span>
                    </ClButton>
                </div>
            </motion.div>
        );
    }

    const idx = Math.min(beat, CUT_BEATS.length - 1);
    const cur = CUT_BEATS[idx];
    const badge = BADGES[cur.badge];
    const Badge = badge.Icon;
    const justify = cur.align === 'start' ? 'flex-start' : cur.align === 'end' ? 'flex-end' : 'center';

    return (
        <motion.div
            className="absolute inset-0 overflow-y-auto"
            style={{ zIndex: 20 }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            // Lift up + fade as the wizard chrome assembles below — the upward drift
            // hands the eye off to the brand mark dropping into the header.
            exit={{ opacity: 0, y: -24, transition: { duration: 0.5, ease: 'easeIn' } }}
        >
          {/* Centre when it fits, scroll when it doesn't (the takeaways list makes the
              scene tall on short windows) — min-h-full keeps it vertically centred. */}
          <div className="min-h-full flex flex-col items-center justify-center px-6 py-8">
            {/* The stage: the mascot band, caption and journey share one width, so Keys
                floats directly above whichever device / server is active. Laid out as a
                flow column so the taller app-skeleton scene never collides with Keys. */}
            <div className="relative w-full mx-auto" style={{ maxWidth: 520 }}>
                {/* Keys — glides to each station, hopping + reacting on arrival.
                    The band floats up + scales in once on mount (the entrance). */}
                <motion.div
                    className="relative" style={{ height: 86 }}
                    initial={{ opacity: 0, y: 22, scale: 0.9 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.7, delay: 0.45, ease: [0.22, 1, 0.36, 1] }}
                >
                    <motion.div
                        className="absolute"
                        style={{ top: 6, left: '50%', x: '-50%', zIndex: 2 }}
                        animate={{ left: `${STATION_PCT[cur.station]}%` }}
                        // Gentle eased glide (slow in / slow out) instead of a spring —
                        // a spring lunges off the line; this eases Keys away smoothly.
                        transition={{ duration: 1.05, ease: [0.65, 0, 0.35, 1] }}
                    >
                        {/* hop on arrival (controls, no remount) */}
                        <motion.div className="relative" animate={hop}>
                            {/* gentle continuous bob + tilt for a living, natural idle */}
                            <motion.div
                                animate={{ y: [0, -4, 0], rotate: [-2.5, 2.5, -2.5] }}
                                transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut' }}
                                style={{ transformOrigin: '50% 80%' }}
                            >
                                <Keys size={72} signal="pulse" interactive={false} waveOnMount={false} />
                            </motion.div>
                            {/* reaction badge — re-pops each beat */}
                            <motion.div
                                key={idx}
                                className="absolute flex items-center justify-center rounded-full"
                                style={{
                                    top: -4, right: -8, width: 26, height: 26,
                                    background: ABYSS, border: `1.5px solid ${badge.color}`,
                                    color: badge.color, boxShadow: `0 0 12px ${badge.color}55`,
                                }}
                                initial={{ scale: 0, rotate: -30 }}
                                animate={{ scale: 1, rotate: 0 }}
                                transition={{ type: 'spring', stiffness: 400, damping: 16, delay: 0.18 }}
                            >
                                <Badge size={14} />
                            </motion.div>
                        </motion.div>
                    </motion.div>
                </motion.div>

                {/* caption — left / centre / right with the active station */}
                <motion.div
                    className="flex px-2" style={{ minHeight: 58, justifyContent: justify, alignItems: 'flex-start' }}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.72, ease: [0.22, 1, 0.36, 1] }}
                >
                    <AnimatePresence mode="wait">
                        <motion.p
                            key={idx}
                            className="text-base leading-snug"
                            style={{
                                fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)',
                                maxWidth: 340,
                                textAlign: cur.align === 'start' ? 'left' : cur.align === 'end' ? 'right' : 'center',
                            }}
                            initial={{ opacity: 0, y: 8, x: cur.align === 'start' ? -14 : cur.align === 'end' ? 14 : 0, filter: 'blur(4px)' }}
                            animate={{ opacity: 1, y: 0, x: 0, filter: 'blur(0px)' }}
                            exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
                            transition={{ duration: 0.45 }}
                        >
                            {renderCaption(cur.caption, cur.emphasis, badge.color)}
                        </motion.p>
                    </AnimatePresence>
                </motion.div>

                {/* the journey — a skeleton of the app showing the message make the trip.
                    Rises in last, so the scene assembles top-down behind Keys. */}
                <motion.div
                    className="flex justify-center" style={{ marginTop: 2 }}
                    initial={{ opacity: 0, y: 18 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.75, delay: 0.82, ease: [0.22, 1, 0.36, 1] }}
                >
                    <JourneyStage beat={idx} />
                </motion.div>
            </div>

            {/* Skip — deliberately not present on mount. It mounts (and fades in) only
                once `intro` clears, ~1.1s in, so the first beat gets a clean, uninterrupted
                arrival before anything reads as an exit affordance. From then on it sits
                centred below the animation for the rest of the six beats — always clear of
                Keys/the journey scene at any width (it's a flow sibling underneath them,
                not overlaid), and reachable the whole time on a glance, a Tab press, or Esc. */}
            <AnimatePresence>
              {!intro && (
                <motion.div
                    key="skip"
                    className="flex justify-center mt-5"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.45, ease: 'easeOut' }}
                >
                    <ClButton variant="ghost" size="sm" onClick={finish} tooltip="Skip intro · Esc">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>Skip <ChevronRight size={13} /></span>
                    </ClButton>
                </motion.div>
              )}
            </AnimatePresence>

            {/* progress — fills with each beat; conveys it’s playing and will end */}
            <motion.div
                className="flex gap-1.5 mt-6"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5, delay: 1.0 }}
            >
                {CUT_BEATS.map((b, i) => (
                    <div key={i} className="rounded-full overflow-hidden" style={{ width: 24, height: 4, background: 'rgba(255,255,255,0.12)' }}>
                        <motion.div
                            className="h-full rounded-full"
                            style={{ background: LUME, originX: 0 }}
                            initial={{ scaleX: 0 }}
                            animate={{ scaleX: i < beat ? 1 : i === beat ? 1 : 0 }}
                            transition={{ duration: i === beat ? b.dur / 1000 : 0.3, ease: 'linear' }}
                        />
                    </div>
                ))}
            </motion.div>

            {/* The takeaways — a checklist that fills in as each point is reached and
                stays put, so the key facts are readable at a glance even if a caption
                goes by quickly. Upcoming rows are dimmed (a preview of what's coming),
                the active one glows, reached ones get a check. */}
            <motion.div
                className="flex flex-col gap-2 mt-6"
                style={{ width: '100%', maxWidth: 320 }}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 1.1, ease: [0.22, 1, 0.36, 1] }}
            >
                {KEY_POINTS.map((p, i) => {
                    const reached = idx >= p.atBeat;
                    const active  = idx === p.atBeat;
                    return (
                        <motion.div
                            key={i}
                            className="flex items-center gap-2.5"
                            animate={{ opacity: reached ? 1 : 0.32, x: active ? 3 : 0 }}
                            transition={{ duration: 0.4, ease: 'easeOut' }}
                        >
                            <motion.span
                                className="flex items-center justify-center rounded-full shrink-0"
                                style={{
                                    width: 19, height: 19,
                                    border: `1.5px solid ${reached ? p.color : 'rgba(167,179,212,0.3)'}`,
                                    color: p.color,
                                    background: active ? `${p.color}1f` : 'transparent',
                                    boxShadow: active ? `0 0 11px ${p.color}55` : 'none',
                                }}
                                animate={{ scale: active ? [1, 1.18, 1] : 1 }}
                                transition={{ duration: 0.5, ease: 'easeOut' }}
                            >
                                {reached && <Check size={11} strokeWidth={3} />}
                            </motion.span>
                            <span
                                style={{
                                    fontSize: 13.5,
                                    fontFamily: 'var(--cl-font-display)',
                                    fontWeight: active ? 700 : 600,
                                    color: active ? p.color : reached ? 'var(--cl-text)' : 'var(--cl-faint)',
                                    transition: 'color .35s ease',
                                }}
                            >
                                {p.label}
                            </span>
                        </motion.div>
                    );
                })}
            </motion.div>
          </div>
        </motion.div>
    );
};

/* ── The recovery key, revealed character by character ──────────────────────  */

const RevealKey: React.FC<{ value: string }> = ({ value }) => {
    const reduced = useReducedMotion();
    if (reduced) return <>{value}</>;
    return (
        <>
            {value.split('').map((ch, i) => (
                <motion.span
                    key={i}
                    style={{ display: 'inline-block' }}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.25 + i * 0.022, duration: 0.3 }}
                >
                    {ch === ' ' ? ' ' : ch}
                </motion.span>
            ))}
        </>
    );
};

/* ── Scene 2: History lives on this device ──────────────────────────────────  */

const SceneOnDevice: React.FC = () => {
    const reduced = useReducedMotion();
    // Echoes the cutscene's visual world — the app-window skeleton, the struck-eye
    // server rack, teal bubbles — so the steps read as one story: there, a message
    // made the trip; here, it lands and *stays*. Your history piles up on this
    // device while the server, true to the cutscene, keeps nothing.
    const bubbles = [
        { x: 58, y: 46,  w: 78, sent: false },
        { x: 78, y: 66,  w: 70, sent: true  },
        { x: 58, y: 86,  w: 60, sent: false },
        { x: 84, y: 104, w: 64, sent: true  },
    ];
    return (
        <SceneStage>
            {/* ── Your device — the chat log collects here and never leaves ── */}
            <motion.g
                initial={{ opacity: reduced ? 1 : 0, scale: reduced ? 1 : 0.93 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: reduced ? 0 : 0.1 }}
                style={{ transformOrigin: '91px 68px' }}
            >
                <rect x="18" y="12" width="146" height="112" rx="14" fill="rgba(20,28,48,0.55)" stroke="rgba(37,224,200,0.45)" strokeWidth="2" />
                <line x1="18" y1="36" x2="164" y2="36" stroke="rgba(167,179,212,0.14)" strokeWidth="1" />
                <circle cx="32" cy="24" r="2.4" fill="rgba(255,107,94,0.6)" />
                <circle cx="41" cy="24" r="2.4" fill="rgba(255,201,77,0.6)" />
                <circle cx="50" cy="24" r="2.4" fill="rgba(37,224,200,0.6)" />
                <rect x="25" y="43" width="24" height="74" rx="7" fill="rgba(255,255,255,0.03)" />
                {[0, 1, 2].map(i => (
                    <rect key={i} x="30" y={50 + i * 13} width="14" height="4.5" rx="2" fill="rgba(167,179,212,0.16)" />
                ))}
            </motion.g>

            {/* history bubbles drop in and accumulate — a chat log that stays put */}
            {bubbles.map((b, i) => (
                <motion.g
                    key={i}
                    initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : -9 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: reduced ? 0 : 0.55 + i * 0.38, type: 'spring', stiffness: 320, damping: 20 }}
                >
                    <rect
                        x={b.x} y={b.y} width={b.w} height="13" rx="6.5"
                        fill={b.sent ? LUME : 'rgba(37,224,200,0.16)'}
                        stroke={b.sent ? 'none' : LUME} strokeWidth={b.sent ? 0 : 1}
                    />
                </motion.g>
            ))}

            {/* ── The server — relays, then keeps nothing (struck-out eye) ── */}
            <motion.g
                initial={{ opacity: reduced ? 1 : 0, scale: reduced ? 1 : 0.93 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: reduced ? 0 : 0.32 }}
                style={{ transformOrigin: '265px 75px' }}
            >
                <rect x="234" y="34" width="62" height="82" rx="9" fill="rgba(18,26,46,0.78)" stroke="rgba(167,179,212,0.34)" strokeWidth="2" />
                <rect x="240" y="39" width="50" height="19" rx="5" fill="rgba(8,12,26,0.7)" stroke="rgba(167,179,212,0.16)" strokeWidth="1" />
                {/* the blind eye, struck through — it sees and keeps nothing */}
                <path d="M256 48.5 q9 -8.5 18 0 q-9 8.5 -18 0" fill="none" stroke={FAINT} strokeWidth="1.4" />
                <circle cx="265" cy="48.5" r="2" fill={FAINT} />
                <line x1="254" y1="42.5" x2="276" y2="54.5" stroke="var(--cl-flash)" strokeWidth="1.7" strokeLinecap="round" />
                {[0, 1].map(i => {
                    const by = 62 + i * 20;
                    return (
                        <g key={i}>
                            <rect x="240" y={by} width="50" height="17" rx="4" fill="rgba(255,255,255,0.035)" stroke="rgba(167,179,212,0.14)" strokeWidth="1" />
                            <circle cx="248" cy={by + 8.5} r="2" fill={LUME} opacity="0.7" />
                            <circle cx="255" cy={by + 8.5} r="2" fill="rgba(255,201,77,0.5)" />
                            {[0, 1, 2].map(v => (
                                <line key={v} x1={268 + v * 6} y1={by + 4} x2={268 + v * 6} y2={by + 13} stroke="rgba(167,179,212,0.22)" strokeWidth="1.4" strokeLinecap="round" />
                            ))}
                        </g>
                    );
                })}
            </motion.g>

            {/* a copy reaches the server — then the server deletes it: the teal
                bubble travels in and lands, then a trash icon + red poof pop above
                the rack as it's wiped. Sent, then gone — nothing stored server-side. */}
            {!reduced && (
                <>
                    <motion.g
                        initial={{ x: 166, opacity: 0 }}
                        animate={{ x: [166, 228, 250, 250], opacity: [0, 1, 1, 0] }}
                        transition={{ duration: 3.4, repeat: Infinity, repeatDelay: 0.5, ease: 'easeInOut', times: [0, 0.34, 0.5, 0.6], delay: 1.2 }}
                    >
                        <rect x="-10" y="64" width="20" height="11" rx="5.5" fill={LUME} />
                    </motion.g>
                    {/* the red poof, around the trash icon above the rack */}
                    <motion.circle
                        cx="265" cy="20" fill="none" stroke="var(--cl-flash)" strokeWidth="1.5"
                        initial={{ r: 4, opacity: 0 }}
                        animate={{ r: [4, 4, 16, 16], opacity: [0, 0, 0.5, 0] }}
                        transition={{ duration: 3.4, repeat: Infinity, repeatDelay: 0.5, ease: 'easeOut', times: [0, 0.5, 0.62, 0.78], delay: 1.2 }}
                    />
                    {/* trash icon — the server throwing the copy away */}
                    <motion.g
                        stroke="var(--cl-flash)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"
                        initial={{ opacity: 0, y: -3 }}
                        animate={{ opacity: [0, 0, 1, 1, 0], y: [-3, -3, 0, 0, 0] }}
                        transition={{ duration: 3.4, repeat: Infinity, repeatDelay: 0.5, ease: 'easeOut', times: [0, 0.48, 0.58, 0.86, 1], delay: 1.2 }}
                    >
                        <path d="M258 17 H272" />
                        <path d="M262.8 17 v-1.6 q0 -0.9 0.9 -0.9 h2.6 q0.9 0 0.9 0.9 v1.6" />
                        <path d="M259.6 17.6 l0.9 9.4 q0.1 1 1.1 1 h6.8 q1 0 1.1 -1 l0.9 -9.4" />
                        <path d="M263.2 20 v5.4" />
                        <path d="M266.8 20 v5.4" />
                    </motion.g>
                </>
            )}

            {/* labels */}
            <motion.g
                initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1 }}
                transition={{ delay: reduced ? 0 : 0.6, duration: 0.5 }}
            >
                <text x="91" y="140" textAnchor="middle" fill={LUME} fontSize="10.5" opacity="0.85">On this device</text>
                <text x="265" y="140" textAnchor="middle" fill={FAINT} fontSize="10.5">Server keeps nothing</text>
            </motion.g>
        </SceneStage>
    );
};

/* ── Scene 3: Feature showcase ────────────────────────────────────────────────
   A single static page. First half: what makes Cipherline different and is free
   for everyone (E2EE, open-source client, no ads, free messaging + audio). Second
   half: the three Pro-gated features (video & screen share up to 90 FPS at source
   resolution, 2 GB uploads, bigger saved server storage), the price, and the one
   call to action — start the no-card 7-day free trial. (Creating servers is free
   for everyone — it is NOT a Pro feature.) */

interface Feature {
    key: string;
    accent: string;
    Icon: LucideIcon;
    /** Short pill label shown on the feature card. */
    statText: string;
    title: string;
    blurb: string;
}

// Free for everyone — the stuff that makes Cipherline different from Discord/Slack.
// NOTE: the client is open source; the service is NOT self-hostable, so we never
// claim self-hosting here.
const CORE_FEATURES: Feature[] = [
    { key: 'e2ee',  accent: LUME,      Icon: ShieldCheck,    statText: 'Private', title: 'End-to-end encrypted', blurb: 'Every message, call and file — encrypted so only you and your people can read them.' },
    { key: 'open',  accent: 'var(--cl-ok)', Icon: Code2,          statText: 'Open',    title: 'Open-source client',   blurb: 'Our app is fully open source — audit every line we ship. No hidden anything.' },
    { key: 'noads', accent: '#FF8FB1', Icon: EyeOff,         statText: 'Zero',    title: 'No ads, no tracking',  blurb: 'No trackers, no targeted ads, no data sales — your activity stays yours.' },
    { key: 'free',  accent: BLUE,      Icon: MessageSquare,  statText: 'Free',    title: 'Messaging & audio',    blurb: 'Unlimited encrypted DMs, group chats and audio calls, plus servers of your own — free, forever.' },
];

// The three features reserved for Cipherline Pro (everything else above is free).
const PRO_FEATURES: Feature[] = [
    { key: 'video',   accent: LUME,      Icon: MonitorUp, statText: '90 FPS', title: 'Video & screen share', blurb: 'HD video calls and screen sharing at source resolution, up to 90 FPS.' },
    { key: 'upload',  accent: BLUE,      Icon: FileUp,    statText: '2 GB',   title: 'Big file uploads',     blurb: 'Send files up to 2 GB. Free accounts upload up to 100 MB.' },
    { key: 'storage', accent: 'var(--cl-glow)', Icon: Users,     statText: '10 GB',  title: 'Bigger server storage', blurb: 'Saved content grows with your server, from 100 MB up to 10 GB. Free servers keep 25 MB.' },
];

// Stagger timing for the feature-card entrance (each card springs in just after
// the previous one). Pure decoration — no gating, no forced wait.
const CARD_STAGGER_S = 0.06;

/* Full-screen feature page (onboarding step 3). The `subscribed` branch is a
   fallback for the rare case this is reached by an account that already pays.
   `trialWithheld` covers the P2-BILL-6 anti-farming quota denying THIS
   account's trial (see RegistrationWizardProps.trialGranted) — without it,
   this step would show "Start your free 7-day trial" to someone whose
   account was already created as `subscription_status: 'expired'`, which is
   exactly the silent, confusing bug this branch exists to fix.
   `onStart()` advances to the profile step (in every branch — the trial
   decision was already made server-side at /auth/finalize; nothing here
   ever starts or re-requests one). */
const FeatureShowcase: React.FC<{ subscribed: boolean; trialWithheld: boolean; onStart: () => void }> = ({ subscribed, trialWithheld, onStart }) => {
    const reduced = !!useReducedMotion();
    const enter = (i: number): { initial: any; animate: any } => reduced
        ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
        : {
            initial: { opacity: 0, y: 22, scale: 0.92 },
            animate: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 300, damping: 21, mass: 0.7, delay: 0.06 + i * CARD_STAGGER_S } },
        };
    // Per-card hover lift + a slow breathe on the icon chips so the grid feels alive.
    const cardHover: any = reduced ? {} : { whileHover: { y: -4, scale: 1.03 }, transition: { type: 'spring', stiffness: 420, damping: 26 } };
    const breathe = (i: number): any => reduced ? {} : {
        animate: { scale: [1, 1.09, 1], rotate: [0, 2.5, 0] },
        transition: { duration: 3.4, repeat: Infinity, ease: 'easeInOut', delay: 0.4 + i * 0.45 },
    };

    if (subscribed) {
        return (
            <motion.div className="absolute inset-0 overflow-y-auto" style={{ zIndex: 20 }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="min-h-full flex flex-col items-center justify-center px-6 py-10 text-center">
                    <div className="rounded-2xl flex items-center justify-center mb-4" style={{ width: 76, height: 76, background: 'color-mix(in srgb, var(--cl-ok) 12%, transparent)', boxShadow: '0 0 30px color-mix(in srgb, var(--cl-ok) 25%, transparent)', color: 'var(--cl-ok)' }}>
                        <ShieldCheck size={38} />
                    </div>
                    <h3 className="text-2xl font-bold text-cl-text mb-2" style={{ fontFamily: 'var(--cl-font-display)' }}>You’re all set with Pro</h3>
                    <p className="text-base text-cl-muted leading-snug mb-6" style={{ maxWidth: 340 }}>
                        Everything below is unlocked. Thanks for backing a private internet.
                    </p>
                    <ClButton onClick={onStart} style={{ maxWidth: 320, width: '100%' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>Continue <ChevronRight size={16} /></span>
                    </ClButton>
                </div>
            </motion.div>
        );
    }

    // The trial was withheld (P2-BILL-6's anti-farming quota) — say so plainly
    // instead of presenting a "Start your free trial" button for a trial that
    // was never started. onStart still just advances the wizard; there is no
    // retry here, because the server already decided and there is nothing on
    // this screen that could change that decision.
    if (trialWithheld) {
        return (
            <motion.div className="absolute inset-0 overflow-y-auto" style={{ zIndex: 20 }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="min-h-full flex flex-col items-center justify-center px-6 py-10 text-center">
                    <div className="rounded-2xl flex items-center justify-center mb-4" style={{ width: 76, height: 76, background: 'color-mix(in srgb, var(--cl-glow) 12%, transparent)', boxShadow: '0 0 30px color-mix(in srgb, var(--cl-glow) 25%, transparent)', color: 'var(--cl-glow)' }}>
                        <Info size={38} />
                    </div>
                    <h3 className="text-2xl font-bold text-cl-text mb-2" style={{ fontFamily: 'var(--cl-font-display)' }}>Your free trial didn’t start this time</h3>
                    <p className="text-base text-cl-muted leading-snug mb-3" style={{ maxWidth: 400 }}>
                        We cap how many free trials can start from the same network in a short window, to keep the trial from being farmed — and this signup landed on that limit. It isn’t about you or anything your account did.
                    </p>
                    <p className="text-sm text-cl-faint leading-snug mb-6" style={{ maxWidth: 400 }}>
                        You're still fully set up either way: unlimited encrypted messaging, audio calls, and encrypted backups, free forever, no trial required. A referral code always overrides this limit and grants an instant trial — worth having ready next time. Want Pro right away instead? You can subscribe any time from Settings → Billing.
                    </p>
                    <ClButton onClick={onStart} style={{ maxWidth: 320, width: '100%' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>Continue <ChevronRight size={16} /></span>
                    </ClButton>
                </div>
            </motion.div>
        );
    }

    return (
        <motion.div className="absolute inset-0 overflow-y-auto" style={{ zIndex: 20 }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.35, ease: 'easeIn' } }}>
            <div className="min-h-full flex flex-col items-center justify-center px-6 py-10">
                <div style={{ width: '100%', maxWidth: 540 }}>
                    {/* Header */}
                    <motion.div className="text-center mb-6" {...enter(0)}>
                        <p className="text-xs font-bold uppercase mb-2" style={{ color: LUME, letterSpacing: '0.2em' }}>Private by design</p>
                        <h2 className="text-[1.75rem] font-bold leading-tight" style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)' }}>
                            Welcome to Cipherline
                        </h2>
                    </motion.div>

                    {/* Section 1 — what makes Cipherline different, free for everyone */}
                    <motion.p className="text-[11px] font-bold uppercase mb-2.5 px-0.5" style={{ color: FAINT, letterSpacing: '0.16em' }} {...enter(1)}>
                        What makes Cipherline different — free for everyone
                    </motion.p>
                    <div className="grid grid-cols-2 gap-2.5 mb-7">
                        {CORE_FEATURES.map((f, i) => (
                            <motion.div key={f.key} className="flex flex-col gap-2 rounded-2xl px-3.5 py-3.5 cursor-default"
                                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                                {...enter(i + 2)} {...cardHover}>
                                <div className="flex items-center justify-between">
                                    <motion.span className="flex items-center justify-center rounded-xl shrink-0" style={{ width: 38, height: 38, background: `${f.accent}1f`, color: f.accent }} {...breathe(i)}>
                                        <f.Icon size={19} />
                                    </motion.span>
                                    <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ color: f.accent, background: `${f.accent}14`, letterSpacing: '0.06em' }}>
                                        {f.statText}
                                    </span>
                                </div>
                                <div className="min-w-0">
                                    <p className="text-sm font-bold text-cl-text mb-0.5" style={{ fontFamily: 'var(--cl-font-display)' }}>{f.title}</p>
                                    <p className="text-xs text-cl-faint leading-snug">{f.blurb}</p>
                                </div>
                            </motion.div>
                        ))}
                    </div>

                    {/* Section 2 — the Pro card: the three paid features, price, and CTA */}
                    <motion.div className="relative rounded-2xl px-5 py-5 mb-3"
                        style={{ background: 'rgba(37,224,200,0.06)', border: '1px solid rgba(37,224,200,0.22)' }}
                        {...enter(CORE_FEATURES.length + 2)}>
                        {!reduced && (
                            <motion.div aria-hidden className="absolute inset-0 rounded-2xl pointer-events-none"
                                style={{ boxShadow: '0 0 28px rgba(37,224,200,0.20)' }}
                                animate={{ opacity: [0.35, 0.75, 0.35] }}
                                transition={{ duration: 3.6, repeat: Infinity, ease: 'easeInOut' }} />
                        )}
                        <div className="relative flex items-center justify-between mb-3.5">
                            <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase" style={{ color: LUME, letterSpacing: '0.16em' }}>
                                <Sparkles size={13} /> Cipherline Pro
                            </p>
                            <div className="flex items-end gap-0.5">
                                <span className="font-extrabold" style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)', fontSize: 26, lineHeight: 0.9 }}>$2.50</span>
                                <span className="text-cl-faint font-bold mb-0.5" style={{ fontSize: 13 }}>/mo + tax</span>
                            </div>
                        </div>

                        <div className="relative flex flex-col gap-2.5 mb-3.5">
                            {PRO_FEATURES.map(f => (
                                <div key={f.key} className="flex items-center gap-3">
                                    <span className="flex items-center justify-center rounded-xl shrink-0" style={{ width: 34, height: 34, background: `${f.accent}1f`, color: f.accent }}>
                                        <f.Icon size={17} />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-bold text-cl-text leading-tight" style={{ fontFamily: 'var(--cl-font-display)' }}>
                                            {f.title} <span className="font-semibold" style={{ color: f.accent }}>· {f.statText}</span>
                                        </p>
                                        <p className="text-xs text-cl-faint leading-snug">{f.blurb}</p>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <p className="relative inline-flex items-center gap-1.5 text-xs text-cl-muted">
                            <CupSoda size={14} style={{ color: FAINT }} /> Less than a mid-tier fountain drink.
                        </p>
                    </motion.div>

                    {/* The one call to action — no card, no payment step */}
                    <motion.div className="flex flex-col items-center gap-2.5" {...enter(CORE_FEATURES.length + 3)}>
                        <div className="relative w-full flex justify-center" style={{ maxWidth: 360, margin: '0 auto' }}>
                            {!reduced && (
                                <motion.div aria-hidden className="absolute inset-0 rounded-full pointer-events-none"
                                    style={{ boxShadow: '0 0 22px rgba(37,224,200,0.45)' }}
                                    animate={{ opacity: [0.25, 0.6, 0.25] }}
                                    transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }} />
                            )}
                            <ClButton fullWidth onClick={onStart}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>Start your free 7-day trial <ChevronRight size={16} /></span>
                            </ClButton>
                        </div>
                        <p className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: LUME }}>
                            <Lock size={12} /> No card required · cancel anytime
                        </p>
                        <p className="text-xs text-cl-faint text-center" style={{ maxWidth: 380 }}>
                            Only video &amp; screen share, 2 GB uploads, and bigger server storage are Pro. After 7 days you drop to the free tier — everything else stays free, forever.
                        </p>
                    </motion.div>
                </div>
            </div>
        </motion.div>
    );
};

// Shorter window = lower rank (used to pick the soonest-expiring setting to show
// off in the save demo). 'never' sorts last so it's never chosen.
const RET_RANK: Record<MessageRetention | AttachmentRetention, number> = {
    never: 99, '1y': 6, '6mo': 5, '3mo': 4, '1mo': 3, '1wk': 2, '24h': 1,
};

/* Shown only when something is set to auto-delete: a message-row skeleton that
   demonstrates the app's save gesture. The amber expiry badge by the name (the
   chosen window, e.g. "1 week") gets tapped, and a Save icon takes its place as
   the row lights amber — exactly how keeping a message looks in the app. */
const SaveDemo: React.FC<{ expiryLabel: string }> = ({ expiryLabel }) => {
    const reduced = useReducedMotion();
    const loop = { duration: 4, repeat: Infinity, repeatDelay: 0.4, ease: 'easeInOut' as const };
    return (
        <div className="rounded-2xl px-4 py-3.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="relative rounded-xl px-2.5 py-2" style={{ overflow: 'hidden' }}>
                {/* the amber "saved" row tint, as in the app */}
                {!reduced && (
                    <motion.div
                        className="absolute inset-0 rounded-xl pointer-events-none"
                        style={{ background: 'rgba(255,201,77,0.10)', boxShadow: 'inset 0 0 0 1px rgba(255,201,77,0.18)' }}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: [0, 0, 1, 1] }}
                        transition={{ ...loop, times: [0, 0.44, 0.56, 1] }}
                    />
                )}
                <div className="relative flex items-start gap-2.5">
                    <div className="rounded-full shrink-0" style={{ width: 30, height: 30, background: 'rgba(37,224,200,0.16)', border: '1px solid rgba(37,224,200,0.3)' }} />
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2" style={{ height: 11 }}>
                            <div className="rounded" style={{ width: 64, height: 8, background: 'rgba(255,255,255,0.24)' }} />
                            <div className="rounded" style={{ width: 32, height: 6, background: 'rgba(255,255,255,0.1)' }} />
                            {/* amber expiry badge ↔ save icon */}
                            {reduced ? (
                                <span className="text-[10px] font-medium tabular-nums" style={{ color: 'rgba(255,201,77,0.85)' }}>· {expiryLabel}</span>
                            ) : (
                                <span className="relative inline-flex items-center">
                                    <motion.span
                                        className="text-[10px] font-medium tabular-nums whitespace-nowrap" style={{ color: 'rgba(255,201,77,0.9)' }}
                                        initial={{ opacity: 1 }} animate={{ opacity: [1, 1, 0, 0] }} transition={{ ...loop, times: [0, 0.42, 0.52, 1] }}
                                    >
                                        · {expiryLabel}
                                    </motion.span>
                                    <motion.span
                                        className="absolute left-0 inline-flex items-center" style={{ color: 'var(--cl-glow)' }}
                                        initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: [0, 0, 1, 1], scale: [0.6, 0.6, 1, 1] }} transition={{ ...loop, times: [0, 0.46, 0.58, 1] }}
                                    >
                                        <Save size={12} strokeWidth={2.4} />
                                    </motion.span>
                                </span>
                            )}
                        </div>
                        <div className="rounded mb-1.5" style={{ width: '86%', height: 8, background: 'rgba(255,255,255,0.1)' }} />
                        <div className="rounded" style={{ width: '58%', height: 8, background: 'rgba(255,255,255,0.1)' }} />
                    </div>
                </div>
                {/* tap ripple over the row */}
                {!reduced && (
                    <motion.div
                        className="absolute rounded-full pointer-events-none"
                        style={{ left: '44%', top: '52%', width: 30, height: 30, marginLeft: -15, marginTop: -15, border: '2px solid rgba(37,224,200,0.75)' }}
                        initial={{ opacity: 0, scale: 0.4 }}
                        animate={{ opacity: [0, 0, 0.55, 0], scale: [0.4, 0.4, 1.5, 2.1] }}
                        transition={{ ...loop, times: [0, 0.36, 0.48, 0.62] }}
                    />
                )}
            </div>
            <p className="text-[13px] text-cl-muted leading-relaxed mt-3 text-center">
                Tap a message to{' '}
                <motion.span
                    className="font-bold"
                    style={{ color: 'var(--cl-glow)', display: 'inline-block', textShadow: '0 0 10px rgba(255,201,77,0.0)' }}
                    animate={reduced ? {} : {
                        scale: [1, 1, 1.1, 1],
                        textShadow: ['0 0 10px rgba(255,201,77,0)', '0 0 10px rgba(255,201,77,0)', '0 0 12px rgba(255,201,77,0.55)', '0 0 10px rgba(255,201,77,0.15)'],
                    }}
                    transition={{ duration: 4, repeat: Infinity, repeatDelay: 0.4, times: [0, 0.5, 0.6, 0.82], ease: 'easeOut' }}
                >
                    save it forever
                </motion.span>
            </p>
        </div>
    );
};

/* ─── Step transition variants (body only; chrome is persistent) ────────────  */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stepVariants: Record<string, any> = {
    enter: (dir: number) => ({
        opacity: 0,
        x: dir >= 0 ? 40 : -40,
        filter: 'blur(5px)',
    }),
    center: {
        opacity: 1, x: 0, filter: 'blur(0px)',
        transition: { duration: 0.42, ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number] },
    },
    exit: (dir: number) => ({
        opacity: 0,
        x: dir >= 0 ? -40 : 40,
        filter: 'blur(5px)',
        transition: { duration: 0.26, ease: 'easeIn' },
    }),
};

/* ─── Reusable bits ─────────────────────────────────────────────────────────  */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fadeUp = (delay: number, reduced: boolean | null): any => ({
    initial: { opacity: reduced ? 1 : 0, y: reduced ? 0 : 14 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number], delay: reduced ? 0 : delay },
});

// Springier sibling of fadeUp — pops in with a little overshoot. Used on the
// profile step so it feels livelier/bouncier than the calmer teaching steps.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bounceIn = (delay: number, reduced: boolean | null): any => ({
    initial: reduced ? { opacity: 1 } : { opacity: 0, scale: 0.82, y: 16 },
    animate: { opacity: 1, scale: 1, y: 0 },
    transition: reduced ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 16, delay },
});

/* ─── Main Wizard ───────────────────────────────────────────────────────────── */

export const RegistrationWizard: React.FC<RegistrationWizardProps> = ({
    username, onComplete, onEnter, trialGranted,
}) => {
    const reduced = useReducedMotion();
    const [step, setStep]           = useState(1);
    const [direction, setDirection] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError]         = useState('');
    const [cutsceneSeen, setCutsceneSeen] = useState(false);
    // Keys's live line on the profile step + the closing-outro phase machine.
    const [keysMsg, setKeysMsg] = useState('');
    const [outro, setOutro] = useState<null | 'out' | 'msg1' | 'msg2'>(null);
    const TOTAL_STEPS = 4;

    const go = (next: number) => {
        setDirection(next >= step ? 1 : -1);
        setError('');
        setStep(next);
    };

    /* ── Profile (step 4) ── */
    // No account exists yet during the wizard — it's created at the very end, once
    // the Terms are accepted (POST /auth/finalize). So the #tag isn't known here;
    // it's assigned at finalize and shown in-app afterwards.
    const [displayName, setDisplayName]     = useState(username);
    const [avatarBlob, setAvatarBlob]       = useState<Blob | null>(null);
    const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
    const [avatarError, setAvatarError]     = useState('');
    /** The picked image awaiting crop. Non-null while the cropper is open. */
    const [cropFile, setCropFile]           = useState<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); }, [avatarPreview]);

    const onPickAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
        setAvatarError('');
        const result = validateImageUpload(e.target.files?.[0]);
        // Always clear the input: without this, cancelling the cropper and
        // re-picking the same file fires no change event.
        if (e.target) e.target.value = '';
        if (!result.ok) { setAvatarError(result.reason); return; }
        if (!result.file) return;
        setCropFile(result.file);
    };

    /** The cropper hands back a 512² JPEG — it replaces the old fixed resize. */
    const onAvatarCropped = (blob: Blob) => {
        setCropFile(null);
        setAvatarBlob(blob);
        setAvatarPreview(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
    };

    const clearAvatar = () => {
        setAvatarBlob(null);
        setAvatarPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    };

    const nameTrim  = displayName.trim();
    const nameValid = nameTrim.length === 0 || USERNAME_REGEX.test(nameTrim);

    const [bio, setBio] = useState('');

    // Keys hosts the profile step and reacts as you fill it in: each time a new
    // field (photo / name / bio) is completed, he does a happy bounce.
    const keysBounce = useAnimationControls();
    const filledCount = (avatarPreview ? 1 : 0) + (nameValid && nameTrim ? 1 : 0) + (bio.trim() ? 1 : 0);
    const prevFilled = useRef(0);
    useEffect(() => {
        // Only bounce while the mascot is actually on screen (step 4).
        if (filledCount > prevFilled.current && !reduced && step === 4) {
            keysBounce.start({ scale: [1, 1.2, 0.94, 1], rotate: [0, -9, 7, 0], transition: { duration: 0.6, ease: 'easeOut' } });
        }
        prevFilled.current = filledCount;
    }, [filledCount, keysBounce, reduced, step]);

    /* ── Keys's profile-step dialogue ──────────────────────────────────────────
       Greeting on arrival ("Nice to meet you!" → "Let's set up your profile."),
       a reaction after the name settles, a light reaction on a new photo, and
       deliberate silence for the bio. `interactedRef` stops the greeting's second
       line from clobbering a reaction the user already triggered. */
    const interactedRef  = useRef(false);
    const firstNameRun   = useRef(true);
    const firstAvatarRun = useRef(true);
    const nameSettleRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (step !== 4) return;
        interactedRef.current = false;
        firstNameRun.current = true;
        firstAvatarRun.current = true;
        setKeysMsg('Nice to meet you! 👋');
        const t = setTimeout(() => { if (!interactedRef.current) setKeysMsg('Let’s set up your profile.'); }, 1700);
        return () => clearTimeout(t);
    }, [step]);

    useEffect(() => {
        if (step !== 4) return;
        if (firstNameRun.current) { firstNameRun.current = false; return; }  // skip the prefilled value
        interactedRef.current = true;
        if (nameSettleRef.current) clearTimeout(nameSettleRef.current);
        nameSettleRef.current = setTimeout(() => {
            const n = displayName.trim();
            if (n && USERNAME_REGEX.test(n)) {
                const lines = [`Love it — ${n}!`, `${n} — great name!`, `Nice to meet you, ${n}!`];
                setKeysMsg(lines[n.length % lines.length]);
            }
        }, 700);
        return () => { if (nameSettleRef.current) clearTimeout(nameSettleRef.current); };
    }, [displayName, step]);

    useEffect(() => {
        if (step !== 4) return;
        if (firstAvatarRun.current) { firstAvatarRun.current = false; return; }
        if (avatarPreview) { interactedRef.current = true; setKeysMsg('Ooh, nice photo! 📸'); }
        // Bio is intentionally silent — no effect watches it.
    }, [avatarPreview, step]);

    /* ── Retention (step 2) ── */
    // Sensible privacy-minded defaults — long enough to be useful, short enough
    // that nothing lingers on-device forever by accident. Tunable per row + later.
    const [dmMsg,  setDmMsg]   = useState<MessageRetention>(RECOMMENDED_RETENTION.dmMessageRetention);
    const [dmAtt,  setDmAtt]   = useState<AttachmentRetention>(RECOMMENDED_RETENTION.dmAttachmentRetention);
    const [grpMsg, setGrpMsg]  = useState<MessageRetention>(RECOMMENDED_RETENTION.groupMessageRetention);
    const [grpAtt, setGrpAtt]  = useState<AttachmentRetention>(RECOMMENDED_RETENTION.groupAttachmentRetention);
    const [srvMsg, setSrvMsg]  = useState<MessageRetention>(RECOMMENDED_RETENTION.serverMessageRetention);
    const [srvAtt, setSrvAtt]  = useState<AttachmentRetention>(RECOMMENDED_RETENTION.serverAttachmentRetention);

    // Save demo surfaces whenever ANY row is set to auto-delete (not Forever).
    // The example expiry it shows is the soonest-deleting setting — preferring a
    // message window (the demo saves a message), falling back to an attachment one.
    const expiringMsg = ([dmMsg, grpMsg, srvMsg] as const).filter(v => v !== 'never');
    const expiringAtt = ([dmAtt, grpAtt, srvAtt] as const).filter(v => v !== 'never');
    const anyExpires  = expiringMsg.length > 0 || expiringAtt.length > 0;
    const shortestRet = (arr: (MessageRetention | AttachmentRetention)[]) =>
        arr.reduce((m, v) => (RET_RANK[v] < RET_RANK[m] ? v : m), arr[0]);
    const demoRet: MessageRetention | AttachmentRetention =
        expiringMsg.length ? shortestRet(expiringMsg) : expiringAtt.length ? shortestRet(expiringAtt) : '1wk';
    const demoExpiryLabel = ATTACHMENT_RETENTION_LABELS[demoRet as AttachmentRetention];

    /* ── Recovery key (step 1) ──
     * SIGNUP CARVE-OUT (deliberate, owner decision 2026-09-20): this step
     * used to require an explicit "Reveal my recovery key" click before
     * showing anything, specifically so the main-process confirmation dialog
     * was always the answer to a click the user just made rather than a
     * pop-up appearing on its own. The owner asked for both the click and the
     * dialog gone here: "just show it to me, and also get rid of this huge
     * pop up with it." It now auto-reveals on mount through a SEPARATE,
     * ungated IPC channel (`revealRecoveryKeySignup` — see main.ts's "SIGNUP
     * CARVE-OUT" comment and the UPDATE notice at the top of
     * electron/recovery-key-gate.ts for the full rationale and the residual
     * risk this accepts). Settings' reveal (RecoveryKeyCard.tsx) is
     * unchanged: still a click, still the gated dialog. */
    const [keyChecked, setKeyChecked]   = useState(false);
    const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
    const [keyState, setKeyState]       = useState<'checking' | 'revealing' | 'ok' | 'unavailable'>('checking');
    const [copied, setCopied]           = useState(false);
    const [downloaded, setDownloaded]   = useState(false);

    useEffect(() => {
        if (step !== 1 || keyState !== 'checking') return;
        let alive = true;
        (async () => {
            const api = window.electronAPI;
            try {
                // Status first — no point revealing if there's nothing to reveal.
                const ex = await api?.getLocalMasterKeyStatus?.();
                if (!alive) return;
                if (ex && ex.status !== 'ok') { setKeyState('unavailable'); return; }
                setKeyState('revealing');
                const res = await api?.revealRecoveryKeySignup?.();
                if (!alive) return;
                if (res?.ok) { setRecoveryKey(res.keyB64); setKeyState('ok'); }
                // No dialog exists on this channel to decline or queue behind,
                // so anything other than `ok` here means the key genuinely
                // isn't available right now — same fallback as a missing status.
                else setKeyState('unavailable');
            } catch {
                if (alive) setKeyState('unavailable');
            }
        })();
        return () => { alive = false; };
    }, [step, keyState]);

    const copyKey = async () => {
        if (!recoveryKey) return;
        try {
            await (window.electronAPI?.writeClipboard?.(recoveryKey) ?? navigator.clipboard.writeText(recoveryKey));
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch { /* clipboard blocked */ }
    };

    const downloadKey = async () => {
        if (!recoveryKey) return;
        const content =
            `Cipherline — Storage Recovery Key\n` +
            `================================\n\n` +
            `${recoveryKey}\n\n` +
            `Keep this secret. Anyone with this key can decrypt this device's local\n` +
            `data (message history, settings, identity). It is the ONLY way to recover\n` +
            `your data if your computer's secure storage is ever reset.\n`;
        const api = window.electronAPI;
        try {
            if (api?.showSaveDialog && api?.writeFile) {
                const res = await api.showSaveDialog({
                    title: 'Save Recovery Key',
                    defaultPath: 'cipherline-recovery-key.txt',
                    filters: [{ name: 'Text File', extensions: ['txt'] }],
                });
                if (res.canceled || !res.filePath) return;
                await api.writeFile(res.filePath, new TextEncoder().encode(content));
            } else {
                const blob = new Blob([content], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'cipherline-recovery-key.txt';
                a.click();
                URL.revokeObjectURL(url);
            }
            setDownloaded(true);
        } catch { /* save failed */ }
    };

    const keyGateSatisfied = keyState === 'unavailable' || (keyState === 'ok' && keyChecked);

    /* ── Submit ── */
    const handleFinish = async () => {
        if (submitting) return;
        setError('');
        setSubmitting(true);

        const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
        const beat = reduced ? 1 : 0; // reduced motion → near-instant, no theatrics

        // Kick the profile save off immediately; it runs while the outro plays.
        const savePromise = onComplete({
            avatarBlob,
            displayName: nameValid ? nameTrim : username,
            bio: bio.trim(),
            dmMessageRetention: dmMsg,
            dmAttachmentRetention: dmAtt,
            groupMessageRetention: grpMsg,
            groupAttachmentRetention: grpAtt,
            serverMessageRetention: srvMsg,
            serverAttachmentRetention: srvAtt,
        });

        try {
            // 1. Form slides away, Keys flies to centre.
            setOutro('out');
            await sleep(beat ? 0 : 480);
            // 2. "Looking good, {name}!"
            setOutro('msg1');
            await sleep(beat ? 0 : 1700);
            // 3. The creative send-off line.
            setOutro('msg2');
            await sleep(beat ? 0 : 1500);
            // Make sure the save actually finished before we leave.
            await savePromise;
            // Hand off to the Dashboard while the outro overlay is still fully
            // opaque. AuthScreen unmounts immediately (wizard chrome is already
            // hidden), and the Dashboard fades in from the ABYSS background —
            // no sign-up form ever flashes through.
            onEnter();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            // Roll the outro back so the user sees the error on the form.
            setOutro(null);
            setError(err?.response?.data?.message || err?.message || 'Setup failed. Please try again.');
            setSubmitting(false);
        }
    };

    /* ── Layout helpers ── */
    const outer = (children: React.ReactNode) => (
        <div className="flex flex-col" style={{ width: '100%', maxWidth: 480 }}>
            {children}
        </div>
    );

    const sceneTitle = (title: string, sub?: string, accent?: string) => (
        <motion.div className="text-center mb-5 px-2" {...fadeUp(0.15, reduced)}>
            <h2 className="text-[26px] font-bold leading-tight" style={{ fontFamily: 'var(--cl-font-display)', color: accent ?? 'var(--cl-text)' }}>
                {title}
            </h2>
            {sub && <p className="text-cl-muted text-sm leading-relaxed mt-2">{sub}</p>}
        </motion.div>
    );

    const navButtons = (opts: {
        onNext: () => void;
        nextLabel?: React.ReactNode;
        nextDisabled?: boolean;
        nextLoading?: boolean;
        onBack?: () => void;
        backLabel?: string;
        backDisabled?: boolean;
    }) => (
        <motion.div className="flex flex-col gap-2 mt-1" {...fadeUp(0.3, reduced)}>
            <ClButton fullWidth disabled={opts.nextDisabled} loading={opts.nextLoading} onClick={opts.onNext}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    {opts.nextLabel ?? 'Continue'} {!opts.nextLoading && <ChevronRight size={16} />}
                </span>
            </ClButton>
            {opts.onBack && (
                <ClButton variant="ghost" fullWidth disabled={opts.backDisabled} onClick={opts.onBack}>
                    {opts.backLabel ?? '← Back'}
                </ClButton>
            )}
        </motion.div>
    );

    /* ── Steps ── */
    const renderStep = () => {
        switch (step) {
            /* 1 — Save your key (the cutscene just taught the why) */
            case 1:
                return outer(<>
                    {sceneTitle(
                        'Now — save your key',
                        'Your keys live only on this device. This recovery key is your one way back if its secure storage is ever reset — we can’t do it for you.',
                        'var(--cl-glow)',
                    )}

                    <motion.div
                        className="rounded-2xl px-4 py-4 mb-5"
                        style={{ background: 'rgba(255,201,77,0.06)', border: '1px solid rgba(255,201,77,0.22)' }}
                        initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 18, scale: reduced ? 1 : 0.97, filter: reduced ? 'blur(0px)' : 'blur(6px)' }}
                        animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                        transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94], delay: reduced ? 0 : 0.26 }}
                    >
                        <div className="flex items-center gap-2 mb-1.5">
                            <AlertTriangle size={15} style={{ color: 'var(--cl-glow)' }} />
                            <h3 className="text-base font-bold" style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-glow)' }}>
                                Your recovery key
                            </h3>
                        </div>
                        <p className="text-cl-faint text-xs leading-relaxed mb-3">
                            Anyone with this key can decrypt this device’s data, so keep it somewhere private — a
                            password manager is perfect.
                        </p>

                        {error && (
                            <div className="mb-3 px-3 py-2 rounded-lg text-xs text-center"
                                style={{ background: 'rgba(255,107,94,0.12)', border: '1px solid rgba(255,107,94,0.3)', color: 'var(--cl-flash)' }}>
                                {error}
                            </div>
                        )}

                        {(keyState === 'checking' || keyState === 'revealing') && (
                            <div className="py-4 text-center text-xs text-cl-faint">Preparing your recovery key…</div>
                        )}

                        {keyState === 'unavailable' && (
                            <div className="px-3 py-2.5 rounded-lg flex items-start gap-2"
                                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                                <Info size={14} className="text-cl-lume shrink-0 mt-0.5" />
                                <p className="text-[11px] text-cl-faint leading-relaxed">
                                    A recovery key isn’t available on this device yet — your OS keystore manages it directly.
                                    You can export one anytime from <span className="text-cl-muted">Settings → Security</span>.
                                </p>
                            </div>
                        )}

                        {keyState === 'ok' && recoveryKey && (
                            <>
                                <motion.div
                                    className="flex items-center gap-2 rounded-lg px-3 py-2.5 mb-2.5"
                                    style={{ background: 'rgba(255,201,77,0.08)', border: '1px solid rgba(255,201,77,0.25)' }}
                                    initial={{ boxShadow: '0 0 0 rgba(255,201,77,0)' }}
                                    animate={{ boxShadow: reduced ? '0 0 0 rgba(255,201,77,0)' : ['0 0 0 rgba(255,201,77,0)', '0 0 18px rgba(255,201,77,0.35)', '0 0 0 rgba(255,201,77,0)'] }}
                                    transition={{ duration: 1.4, delay: 0.55 }}
                                >
                                    <code className="flex-1 min-w-0 text-xs break-all"
                                        style={{ color: 'var(--cl-glow)', fontFamily: "'JetBrains Mono',monospace" }}>
                                        <RevealKey value={recoveryKey} />
                                    </code>
                                </motion.div>
                                <div className="flex gap-2 mb-3">
                                    <ClButton size="sm" variant="ghost" onClick={copyKey}>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                            {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}
                                        </span>
                                    </ClButton>
                                    <ClButton size="sm" variant="ghost" onClick={downloadKey}>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                            {downloaded ? <Check size={14} /> : <Download size={14} />}{downloaded ? 'Saved' : 'Download .txt'}
                                        </span>
                                    </ClButton>
                                </div>
                                <ClCheckbox
                                    checked={keyChecked}
                                    onChange={setKeyChecked}
                                    label={<span className="text-xs text-cl-muted leading-relaxed">I’ve saved my recovery key somewhere safe</span>}
                                />
                            </>
                        )}
                    </motion.div>

                    {navButtons({
                        onNext: () => go(2),
                        nextDisabled: !keyGateSatisfied,
                    })}
                </>);

            /* 2 — History on device → retention */
            case 2:
                return outer(<>
                    <motion.div {...fadeUp(0, reduced)}><SceneOnDevice /></motion.div>
                    {sceneTitle(
                        'Your history lives here',
                        'Messages are stored on this device — never on our servers. So you decide how long to keep them.',
                    )}

                    <motion.div className="mb-4" {...fadeUp(0.28, reduced)}>
                        <RetentionChoiceTable rows={[
                            { label: 'Direct messages', msg: dmMsg,  att: dmAtt,  onMsg: setDmMsg,  onAtt: setDmAtt },
                            { label: 'Group chats',     msg: grpMsg, att: grpAtt, onMsg: setGrpMsg, onAtt: setGrpAtt },
                            { label: 'Servers',         msg: srvMsg, att: srvAtt, onMsg: setSrvMsg, onAtt: setSrvAtt },
                        ]} />
                    </motion.div>

                    {anyExpires ? (
                        <motion.div className="mb-4" {...fadeUp(0.4, reduced)}>
                            <SaveDemo expiryLabel={demoExpiryLabel} />
                        </motion.div>
                    ) : (
                        <motion.div className="flex items-start gap-2 mb-4 px-1" {...fadeUp(0.4, reduced)}>
                            <Info size={13} className="text-cl-faint mt-0.5 shrink-0" />
                            <p className="text-xs text-cl-faint leading-relaxed">
                                “Forever” keeps content on this device until you delete it. Shorter windows auto-clear old content.
                                You can fine-tune any chat later.
                            </p>
                        </motion.div>
                    )}

                    {navButtons({ onNext: () => go(3), onBack: () => go(1) })}
                </>);

            /* 3 is the full-screen FeatureShowcase (rendered at the wizard root,
               not here) — its "Start your free 7-day trial" CTA advances to step 4. */

            /* 4 — Profile */
            case 4: {
                const hasAvatar = !!avatarPreview;
                return outer(<>
                    {/* Keys hosts this step, greeting + reacting in a speech bubble.
                        The line comes from `keysMsg` (greeting → name reaction → photo
                        reaction; bio stays silent). */}
                    <motion.div className="flex items-end gap-3 mb-5" {...bounceIn(0, reduced)}>
                        <motion.div animate={keysBounce} className="shrink-0" style={{ transformOrigin: '50% 85%' }}>
                            <Keys size={70} signal="pulse" interactive={false} waveOnMount={false} />
                        </motion.div>
                        <div className="flex-1 min-w-0 pb-1">
                            <AnimatePresence mode="wait">
                                <motion.div
                                    key={keysMsg}
                                    className="inline-block rounded-2xl rounded-bl-md px-3.5 py-2.5"
                                    style={{ background: 'rgba(37,224,200,0.1)', border: '1px solid rgba(37,224,200,0.28)' }}
                                    initial={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.85, y: 6 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.92, transition: { duration: 0.12 } }}
                                    transition={{ type: 'spring', stiffness: 360, damping: 18 }}
                                >
                                    <p className="text-sm font-semibold text-cl-text leading-snug" style={{ fontFamily: 'var(--cl-font-display)' }}>
                                        {keysMsg}
                                    </p>
                                </motion.div>
                            </AnimatePresence>
                        </div>
                    </motion.div>

                    {/* Avatar — glows once a photo lands */}
                    <motion.div className="flex flex-col items-center mb-5" {...bounceIn(0.08, reduced)}>
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="relative group mb-2"
                            style={{ width: 96, height: 96 }}
                        >
                            <div
                                className="w-full h-full rounded-full overflow-hidden flex items-center justify-center"
                                style={{
                                    background: 'rgba(255,255,255,0.06)',
                                    border: `2px solid ${hasAvatar ? 'rgba(37,224,200,0.7)' : 'rgba(37,224,200,0.25)'}`,
                                    boxShadow: hasAvatar ? '0 0 22px rgba(37,224,200,0.3)' : 'none',
                                    transition: 'border-color .3s, box-shadow .3s',
                                }}
                            >
                                {avatarPreview
                                    ? <img src={avatarPreview} alt="avatar" className="w-full h-full object-cover" />
                                    : <Camera className="w-7 h-7" style={{ color: FAINT }} />}
                            </div>
                            <span
                                className="absolute inset-0 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                style={{ background: 'rgba(0,0,0,0.5)' }}
                            >
                                <Camera className="w-6 h-6 text-white" />
                            </span>
                            <span
                                className="absolute -inset-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                                style={{ border: '2px solid rgba(37,224,200,0.6)', boxShadow: '0 0 14px rgba(37,224,200,0.22)' }}
                            />
                        </button>
                        <input ref={fileInputRef} type="file" accept={IMAGE_ACCEPT_ATTR} onChange={onPickAvatar} className="hidden" />
                        {avatarBlob
                            ? (
                                <button type="button" onClick={clearAvatar}
                                    className="inline-flex items-center gap-1 text-xs text-cl-faint hover:text-cl-flash transition-colors">
                                    <Trash2 className="w-3 h-3" /> Remove photo
                                </button>
                            )
                            : <p className="text-xs text-cl-faint">Tap to add a photo</p>}
                        {avatarError && <p className="text-xs mt-1" style={{ color: 'var(--cl-flash)' }}>{avatarError}</p>}
                    </motion.div>

                    {/* Display name */}
                    <motion.div className="mb-4" {...bounceIn(0.16, reduced)}>
                        <p className="text-[10px] font-bold text-cl-faint uppercase tracking-widest mb-2">Display name</p>
                        <ClInput
                            value={displayName}
                            onChange={e => setDisplayName(e.target.value)}
                            placeholder="Your name"
                            maxLength={32}
                        />
                        {!nameValid && (
                            <p className="text-xs mt-1.5" style={{ color: 'var(--cl-flash)' }}>
                                3–32 characters: letters, digits, and underscore only.
                            </p>
                        )}
                        <p className="text-xs text-cl-faint mt-1.5">
                            We'll give you a unique #tag when your account is created — friends find you by name + tag.
                        </p>
                    </motion.div>

                    {/* Bio */}
                    <motion.div className="mb-6" {...bounceIn(0.24, reduced)}>
                        <p className="text-[10px] font-bold text-cl-faint uppercase tracking-widest mb-2">
                            Bio <span className="text-cl-faint normal-case tracking-normal font-medium opacity-70">· optional</span>
                        </p>
                        <ClTextarea
                            value={bio}
                            onChange={e => setBio(e.target.value)}
                            placeholder="A line about you — show up however you like."
                            maxLength={160}
                            style={{ width: '100%', height: 76, resize: 'none' }}
                        />
                        <div className="text-right text-xs text-cl-faint mt-1">{bio.length} / 160</div>
                    </motion.div>

                    {navButtons({ onNext: handleFinish, nextLabel: 'Enter Cipherline', nextDisabled: !nameValid || submitting, nextLoading: submitting, onBack: () => go(2) })}
                </>);
            }

            default:
                return null;
        }
    };

    /* ── Full-screen layout ── */
    const showCutscene = step === 1 && !cutsceneSeen;
    // Step 3 is the full-screen feature page (no wizard chrome); its "Start your
    // free 7-day trial" CTA hands off to the profile step.
    const showFeatureReel = step === 3;
    // Already-subscribed check. The wizard is pre-auth, so status is normally null
    // (no account yet) → false → the page shows the trial CTA. The branch is
    // here for when this flow is ever reached by an account that already pays.
    const { status: subStatus } = useSubscription();
    const isSubscribed = !!subStatus?.has_subscription;

    return (
        <motion.div
            className="fixed inset-0 overflow-y-auto"
            style={{ background: ABYSS, zIndex: 50 }}
            // Fade the whole surface in (bg included) so it cross-dissolves over the
            // verify-email card that's fading out beneath it on the same dot field.
            // The short delay lets the prompt get a clean head-start leaving, so the
            // two motions sequence (card out → cutscene in) instead of colliding.
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.55, ease: 'easeOut', delay: 0.3 }}
        >
            <CinematicBackground />

            {/* No mode="wait": the cutscene and the wizard cross-fade (no blank gap).
                Keys drifts up and out as the chrome + first step assemble in below —
                the upward exit leads the eye to the brand mark dropping into the header. */}
            <AnimatePresence>
                {showCutscene ? (
                    <KeysCutscene key="cutscene" onFinish={() => setCutsceneSeen(true)} />
                ) : showFeatureReel ? (
                    <FeatureShowcase key="features" subscribed={isSubscribed} trialWithheld={trialGranted === false} onStart={() => go(4)} />
                ) : (
                    <motion.div
                        key="wizard"
                        className="relative flex flex-col items-center w-full"
                        style={{ zIndex: 10, minHeight: '100%', ...(outro ? { opacity: 0, pointerEvents: 'none' } : {}) }}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: outro ? 0 : 1 }}
                        exit={{ opacity: 0, transition: { duration: 0.3, ease: 'easeIn' } }}
                        transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.1 }}
                    >
                        {/* Persistent brand header */}
                        <motion.div
                            className="relative shrink-0 flex flex-col items-center gap-3.5 pt-7 pb-2"
                            initial={{ opacity: 0, y: -12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
                        >
                            <LogoLockup markSize={30} textClass="text-xl" />
                            <StepDots current={step} total={TOTAL_STEPS} />
                        </motion.div>

                        {/* Step body */}
                        <div className="relative flex-1 flex items-center justify-center w-full px-6 py-8">
                            <AnimatePresence mode="wait" custom={direction}>
                                <motion.div
                                    key={step}
                                    custom={direction}
                                    variants={stepVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    className="flex items-center justify-center w-full"
                                >
                                    {renderStep()}
                                </motion.div>
                            </AnimatePresence>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── Closing outro ──────────────────────────────────────────────────
                After "Enter Cipherline": the profile fades away beneath an opaque
                overlay, Keys springs up to centre, says his piece, then the whole
                surface fades to the deep and hands off to the Dashboard. */}
            <AnimatePresence>
                {outro && (
                    <motion.div
                        key="outro"
                        className="absolute inset-0 flex flex-col items-center justify-center px-6"
                        style={{ background: ABYSS, zIndex: 40 }}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.42, ease: 'easeInOut' }}
                    >
                        <CinematicBackground />
                        <motion.div
                            className="relative flex flex-col items-center text-center"
                            style={{ zIndex: 1 }}
                            initial={reduced ? { opacity: 0 } : { scale: 0.5, opacity: 0, y: 38 }}
                            animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1, y: 0 }}
                            transition={{ type: 'spring', stiffness: 200, damping: 17 }}
                        >
                            <motion.div
                                animate={outro === 'msg2' && !reduced ? { rotate: [0, -8, 8, 0] } : {}}
                                transition={{ duration: 0.7, ease: 'easeInOut' }}
                            >
                                <Keys size={165} signal="pulse" wave={outro === 'msg2'} interactive={false} waveOnMount={false} />
                            </motion.div>
                            <div style={{ minHeight: 42, marginTop: 24 }}>
                                <AnimatePresence mode="wait">
                                    {outro !== 'out' && (
                                        <motion.p
                                            key={outro === 'msg1' ? 'm1' : 'm2'}
                                            className="text-xl font-bold"
                                            style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)' }}
                                            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.9 }}
                                            animate={{ opacity: 1, y: 0, scale: 1 }}
                                            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, transition: { duration: 0.18 } }}
                                            transition={{ type: 'spring', stiffness: 340, damping: 20 }}
                                        >
                                            {outro === 'msg1'
                                                ? `Looking good${nameTrim ? ', ' + nameTrim : ''}!`
                                                : "Let's dive in."}
                                        </motion.p>
                                    )}
                                </AnimatePresence>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Avatar crop. ClModal portals to <body> at z-index 1000, so it clears
                this surface's z-50 regardless of where it sits in the tree. */}
            <ClImageCropper
                open={!!cropFile}
                file={cropFile}
                outputWidth={AVATAR_OUTPUT.width}
                outputHeight={AVATAR_OUTPUT.height}
                shape="circle"
                title="Position your avatar"
                onCancel={() => setCropFile(null)}
                onConfirm={onAvatarCropped}
            />
        </motion.div>
    );
};
