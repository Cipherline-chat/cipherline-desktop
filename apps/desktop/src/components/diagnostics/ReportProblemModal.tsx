import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Bug, MonitorUp, Headphones, Video, Gauge, Bell, MessageCircleQuestion, LifeBuoy, X, ChevronDown,
    Info, ShieldCheck, AlertTriangle, Loader2, Check, Copy, Download, Send, ArrowLeft, RotateCcw,
} from 'lucide-react';
import { ClButton, ClInput, ClModal, ClSegment, ClTextarea } from '../cl';
import { DIAGNOSTIC_LIMITS, type DiagnosticCategory, type DiagnosticReportBody } from '../../utils/diagnostics/reportTypes';
import { describeCollection, isValidReplyEmail } from '../../utils/diagnostics/bundle';
import { buildFromPrepared, prepareReportInputs, type LiveContext, type PreparedInputs } from '../../utils/diagnostics/collect';
import { newestCrash } from '../../utils/diagnostics/ipc';
import type { ReportRequest, ReportStep } from '../../utils/diagnostics/reportRequest';
import type { SendResult } from '../../utils/diagnostics/sendPolicy';
import { sendDiagnosticReport, saveDiagnosticReport, type SaveResult } from '../../utils/diagnostics/send';
import { ReportPreview, RawJson } from './ReportPreview';
import './reportProblem.css';

/**
 * "Report a problem" — category → details → preview → send.
 *
 * The contract with the user, enforced by construction:
 *   • The Preview renders `built.body`, the Raw JSON view is
 *     JSON.stringify(built.body), and Send / Save to file transmit that same
 *     object. There is no second build between showing and sending.
 *   • Nothing is uploaded until Send is pressed (automatic crash sending is a
 *     separate, opt-in path in ReportProblemHost).
 *   • The report is linked to the account server-side; we say so, with the
 *     username, before anything is sent.
 */

const CATEGORY_UI: Array<{ id: DiagnosticCategory; title: string; hint: string; Icon: typeof Bug }> = [
    { id: 'screen_share', title: 'Screen share quality', hint: 'Choppy, blurry, or not reaching the frame rate you picked — e.g. not getting 90 fps', Icon: MonitorUp },
    { id: 'call_audio', title: 'Call or audio quality', hint: 'Robotic or cutting-out voices, echo, people can’t hear you', Icon: Headphones },
    { id: 'video_camera', title: 'Video or camera', hint: 'Camera won’t start, freezes, looks dark or stutters', Icon: Video },
    { id: 'performance', title: 'Performance or freezes', hint: 'Slow, stuttering, or “Not responding” moments', Icon: Gauge },
    { id: 'crash', title: 'Crash', hint: 'Cipherline closed, went blank, or showed an error screen', Icon: Bug },
    { id: 'notifications', title: 'Notifications', hint: 'Missing, late or unwanted notifications and sounds', Icon: Bell },
    { id: 'other', title: 'Something else', hint: 'Anything that doesn’t fit the categories above', Icon: MessageCircleQuestion },
];
const CATEGORY_BY_ID = Object.fromEntries(CATEGORY_UI.map(c => [c.id, c])) as Record<DiagnosticCategory, typeof CATEGORY_UI[number]>;

const PLACEHOLDER: Record<DiagnosticCategory, string> = {
    screen_share: 'e.g. I picked 90 fps at 1440p but friends say it looks like 60, and it stutters when the game is busy.',
    call_audio: 'e.g. My voice cuts out every few seconds in voice channels since this morning.',
    video_camera: 'e.g. My camera freezes after about a minute in a call.',
    performance: 'e.g. The app freezes for a few seconds whenever I switch servers.',
    crash: 'What were you doing right before it closed? Anything you can remember helps.',
    notifications: 'e.g. I don’t get notifications for DMs while the window is minimized.',
    other: 'Tell us what happened and what you expected to happen.',
};

export interface ReportProblemModalProps {
    request: ReportRequest;
    token: string | null;
    username: string | null;
    live: LiveContext;
    onClose: () => void;
    /** Injectable for the screenshot harness and tests. */
    prepare?: (live: LiveContext) => Promise<PreparedInputs>;
    send?: (body: DiagnosticReportBody, token: string) => Promise<SendResult>;
    save?: (body: DiagnosticReportBody) => Promise<SaveResult>;
    /** Called after a successful send that included a pending crash. */
    onCrashSent?: (signature: string) => void;
}

type Phase = 'edit' | 'sending' | 'sent';

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export const ReportProblemModal: React.FC<ReportProblemModalProps> = ({
    request, token, username, live, onClose,
    prepare = prepareReportInputs, send = sendDiagnosticReport, save = saveDiagnosticReport, onCrashSent,
}) => {
    const [open, setOpen] = useState(true);
    const [step, setStep] = useState<ReportStep>(request.step ?? (request.category ? 'details' : 'category'));
    const [category, setCategory] = useState<DiagnosticCategory | null>(request.category ?? null);
    const [description, setDescription] = useState('');
    const [replyEmail, setReplyEmail] = useState('');
    const [emailTouched, setEmailTouched] = useState(false);
    const [collectedOpen, setCollectedOpen] = useState(false);
    const [view, setView] = useState<'readable' | 'raw'>('readable');

    const [prepared, setPrepared] = useState<PreparedInputs | null>(null);
    const [prepareFailed, setPrepareFailed] = useState(false);
    const [phase, setPhase] = useState<Phase>('edit');
    const [sendError, setSendError] = useState<string | null>(null);
    const [reference, setReference] = useState<string | null>(null);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | SaveResult>('idle');
    const [refCopied, setRefCopied] = useState(false);

    const headingRef = useRef<HTMLHeadingElement>(null);
    const firstCatRef = useRef<HTMLButtonElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const close = useCallback(() => setOpen(false), []);
    // Let ClModal play its exit before the host unmounts us.
    useEffect(() => {
        if (open) return;
        const t = setTimeout(onClose, 260);
        return () => clearTimeout(t);
    }, [open, onClose]);

    // Gather once, as soon as the reporter opens — by the time the user has
    // written a description the preview is ready. "Try again" bumps the nonce.
    const [prepareNonce, setPrepareNonce] = useState(0);
    useEffect(() => {
        let alive = true;
        prepare(live).then(p => { if (alive) setPrepared(p); }).catch(() => { if (alive) setPrepareFailed(true); });
        return () => { alive = false; };
    // `live` is read once per attempt on purpose: the report describes the
    // moment the user opened the reporter, not every later re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prepare, prepareNonce]);
    const retryPrepare = () => {
        setPrepareFailed(false);
        setPrepared(null);
        setPrepareNonce(n => n + 1);
    };

    const crashEntry = useMemo(() => (prepared ? newestCrash(prepared.pendingCrashes) : null), [prepared]);

    const emailOk = replyEmail.trim() === '' || isValidReplyEmail(replyEmail);

    // THE report. Rebuilt only from the inputs the user can see change; the
    // preview, the raw view, Save and Send all use this one object.
    const built = useMemo(() => {
        if (!prepared || !category || step !== 'preview') return null;
        return buildFromPrepared(prepared, {
            category,
            trigger: request.trigger,
            description,
            replyEmail: replyEmail.trim() || undefined,
            crash: category === 'crash' ? crashEntry?.crash ?? null : null,
        });
    }, [prepared, category, step, request.trigger, description, replyEmail, crashEntry]);

    // Focus follows the step, so keyboard and screen-reader users land at the
    // top of the new content rather than on a button that just disappeared.
    useEffect(() => {
        const id = requestAnimationFrame(() => {
            if (step === 'category') (firstCatRef.current ?? headingRef.current)?.focus();
            else if (step === 'details') textareaRef.current?.focus();
            else headingRef.current?.focus();
        });
        return () => cancelAnimationFrame(id);
    }, [step, phase]);

    const pickCategory = (c: DiagnosticCategory) => {
        setCategory(c);
        setStep('details');
    };

    const onCatKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const btns = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        if (i < 0) return;
        const cols = window.matchMedia?.('(max-width: 640px)').matches ? 1 : 2;
        const go = (j: number) => { e.preventDefault(); btns[Math.max(0, Math.min(btns.length - 1, j))]?.focus(); };
        if (e.key === 'ArrowRight') go(i + 1);
        else if (e.key === 'ArrowLeft') go(i - 1);
        else if (e.key === 'ArrowDown') go(i + cols);
        else if (e.key === 'ArrowUp') go(i - cols);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(btns.length - 1);
    };

    const toPreview = () => {
        setEmailTouched(true);
        if (!emailOk) return;
        setSendError(null);
        setSaveState('idle');
        setView('readable');
        setStep('preview');
    };

    const doSend = async () => {
        if (!built || !token) return;
        setPhase('sending');
        setSendError(null);
        const r = await send(built.body, token);
        if (r.ok) {
            setReference(r.reference);
            setPhase('sent');
            if (category === 'crash' && crashEntry && built.body.payload.crash) onCrashSent?.(crashEntry.signature);
        } else {
            setSendError(r.message);
            setPhase('edit');
        }
    };

    const doSave = async () => {
        if (!built) return;
        setSaveState('saving');
        setSaveState(await save(built.body));
    };

    const copyRef = async () => {
        if (!reference) return;
        try { await navigator.clipboard.writeText(reference); setRefCopied(true); setTimeout(() => setRefCopied(false), 1800); } catch { /* visible anyway */ }
    };

    const stepIndex = step === 'category' ? 0 : step === 'details' ? 1 : 2;
    const cat = category ? CATEGORY_BY_ID[category] : null;
    const wide = step === 'preview' && phase !== 'sent';

    // ── Header copy per step ────────────────────────────────────────────────
    const head = phase === 'sent'
        ? null
        : step === 'category'
            ? { title: 'Report a problem', sub: 'What kind of problem are you seeing? We’ll attach the diagnostics that help with that — and you’ll see all of it before anything is sent.' }
            : step === 'details'
                ? { title: cat?.title ?? 'Details', sub: 'Tell us what happened. The more specific, the faster we can fix it.' }
                : { title: 'Review what will be sent', sub: 'This is the complete report, exactly as it will leave your device.' };

    return (
        <ClModal
            open={open}
            onClose={phase === 'sending' ? () => {} : close}
            closeOnOverlay={phase !== 'sending' && step === 'category'}
            width={wide ? 760 : 600}
            cardClassName={`rp-card${wide ? ' rp-wide' : ''}`}
            overlayStyle={{ zIndex: 10001 }}
            label={head?.title ?? 'Report sent'}
        >
            {phase === 'sent' ? (
                <>
                    <div className="rp-body" style={{ paddingTop: 10 }}>
                        <div className="rp-done rp-enter" aria-live="polite">
                            <div className="rp-done-badge"><Check size={30} strokeWidth={2.6} aria-hidden /></div>
                            <h3 ref={headingRef} tabIndex={-1} style={{ outline: 'none' }}>Report sent — thank you</h3>
                            <div className="rp-done-text">We received exactly what you reviewed. It’s linked to your account, so we can follow up{replyEmail.trim() ? ` at ${replyEmail.trim()}` : ''}.</div>
                            {reference && (
                                <div className="rp-ref">
                                    <span>Reference</span>
                                    <code>{reference}</code>
                                    <button type="button" onClick={copyRef} aria-label={refCopied ? 'Reference copied' : 'Copy reference'}>
                                        {refCopied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                                    </button>
                                </div>
                            )}
                            {reference && <div className="rp-help" style={{ marginTop: 10 }}>Mention it if you contact support about this.</div>}
                        </div>
                    </div>
                    <div className="rp-foot" style={{ borderTop: 'none', background: 'none', justifyContent: 'center', paddingBottom: 26 }}>
                        <div style={{ width: 200 }}><ClButton onClick={close} fullWidth>Done</ClButton></div>
                    </div>
                </>
            ) : (
                <>
                    <div className="rp-head">
                        <div className={`rp-tile${step !== 'category' && category === 'crash' ? ' rp-tile--flash' : ''}`} aria-hidden>
                            {step === 'category' || !cat ? <LifeBuoy size={20} /> : <cat.Icon size={20} />}
                        </div>
                        <div className="rp-titles">
                            <h2 className="rp-title" ref={headingRef} tabIndex={-1} style={{ outline: 'none' }}>{head!.title}</h2>
                            <div className="rp-sub">{head!.sub}</div>
                        </div>
                    </div>
                    <div className="rp-steps" aria-hidden>
                        {[0, 1, 2].map(i => <span key={i} className={i <= stepIndex ? 'on' : ''} />)}
                    </div>

                    <div className="rp-body">
                        {step === 'category' && (
                            <div key="cat" className="rp-enter">
                                <div className="rp-cats" role="radiogroup" aria-label="Problem type" onKeyDown={onCatKey}>
                                    {CATEGORY_UI.map((c, i) => (
                                        <button
                                            key={c.id}
                                            ref={i === 0 ? firstCatRef : undefined}
                                            type="button"
                                            role="radio"
                                            aria-checked={category === c.id}
                                            tabIndex={(category ? category === c.id : i === 0) ? 0 : -1}
                                            className={`rp-cat${i === CATEGORY_UI.length - 1 ? ' rp-cat--wide' : ''}`}
                                            onClick={() => pickCategory(c.id)}
                                        >
                                            <span className="rp-cat-ico"><c.Icon size={17} aria-hidden /></span>
                                            <span>
                                                <b>{c.title}</b>
                                                <span className="rp-hint">{c.hint}</span>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {step === 'details' && category && (
                            <div key="details" className="rp-enter">
                                <div className="rp-chiprow">
                                    <span className="rp-chip">{cat && <cat.Icon size={13} aria-hidden />}{cat?.title}</span>
                                    <button type="button" className="rp-link" onClick={() => setStep('category')}>Change</button>
                                </div>

                                {category === 'crash' && prepared && (
                                    crashEntry
                                        ? <div className="rp-notice rp-notice--warn" style={{ marginBottom: 16 }}>
                                            <AlertTriangle size={15} aria-hidden />
                                            <span>We’ll include the most recent crash we recorded on this device ({new Date(crashEntry.crash.occurred_at).toLocaleString()}).</span>
                                        </div>
                                        : <div className="rp-notice" style={{ marginBottom: 16 }}>
                                            <Info size={15} aria-hidden />
                                            <span>No crash was recorded on this device, so this report will rely on your description and recent app errors.</span>
                                        </div>
                                )}

                                <div className="rp-field">
                                    <label className="rp-label" htmlFor="rp-desc">
                                        What happened?
                                        <small>{description.length.toLocaleString()} / {DIAGNOSTIC_LIMITS.maxDescriptionChars.toLocaleString()}</small>
                                    </label>
                                    <ClTextarea
                                        id="rp-desc"
                                        ref={textareaRef}
                                        className="rp-textarea"
                                        value={description}
                                        maxLength={DIAGNOSTIC_LIMITS.maxDescriptionChars}
                                        placeholder={PLACEHOLDER[category]}
                                        aria-describedby="rp-desc-help"
                                        onChange={e => setDescription(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toPreview(); } }}
                                    />
                                    <div id="rp-desc-help" className="rp-help">
                                        Sent as you write it, after we automatically remove emails, links and file paths.
                                        Please don’t include passwords, messages or anything else private.
                                    </div>
                                </div>

                                <div className="rp-field">
                                    <label className="rp-label" htmlFor="rp-email">Email for a reply <small>Optional</small></label>
                                    <ClInput
                                        id="rp-email"
                                        className="rp-input"
                                        type="email"
                                        inputMode="email"
                                        autoComplete="email"
                                        value={replyEmail}
                                        maxLength={DIAGNOSTIC_LIMITS.maxReplyEmailChars}
                                        placeholder="you@example.com"
                                        aria-invalid={emailTouched && !emailOk}
                                        aria-describedby="rp-email-help"
                                        onChange={e => setReplyEmail(e.target.value)}
                                        onBlur={() => setEmailTouched(true)}
                                    />
                                    {emailTouched && !emailOk
                                        ? <div id="rp-email-help" className="rp-err" role="alert">That doesn’t look like an email address.</div>
                                        : <div id="rp-email-help" className="rp-help">Only if you’d like us to write back. It’s sent alongside the report, never inside the diagnostic data.</div>}
                                </div>

                                <div className="rp-notice">
                                    <Info size={15} aria-hidden />
                                    <span>This report is linked to your account{username ? <> (<b>@{username}</b>)</> : null} so we can follow up.</span>
                                </div>

                                <div className="rp-collected" data-open={collectedOpen}>
                                    <button type="button" aria-expanded={collectedOpen} aria-controls="rp-collected-list" onClick={() => setCollectedOpen(v => !v)}>
                                        <ShieldCheck size={15} style={{ color: 'var(--cl-lume)' }} aria-hidden />
                                        What’s collected for this report
                                        <ChevronDown size={15} className="rp-chev" aria-hidden />
                                    </button>
                                    {collectedOpen && (
                                        <ul id="rp-collected-list">
                                            {describeCollection(category).map(l => <li key={l}>{l}</li>)}
                                            <li><b style={{ color: 'var(--cl-text)' }}>Never included:</b> messages, keys, file names, contacts, names.</li>
                                        </ul>
                                    )}
                                </div>
                            </div>
                        )}

                        {step === 'preview' && (
                            <div key="preview" className="rp-enter">
                                {prepareFailed ? (
                                    <div className="rp-notice rp-notice--err" role="alert">
                                        <AlertTriangle size={15} aria-hidden />
                                        <span>Couldn’t gather the diagnostics. <button type="button" className="rp-link" onClick={retryPrepare}>Try again</button></span>
                                    </div>
                                ) : !built ? (
                                    <div className="rp-loading" role="status">
                                        <Loader2 size={22} className="rp-spin" aria-hidden />
                                        Gathering diagnostics…
                                    </div>
                                ) : (
                                    <>
                                        <div className="rp-pbar">
                                            <ClSegment<'readable' | 'raw'>
                                                value={view}
                                                onChange={setView}
                                                options={[{ value: 'readable', label: 'Readable' }, { value: 'raw', label: 'Raw JSON' }]}
                                            />
                                            <span className="rp-size">{kb(built.bodyBytes)} · {category}</span>
                                        </div>
                                        {sendError && (
                                            <div className="rp-notice rp-notice--err" role="alert" style={{ marginBottom: 12 }}>
                                                <AlertTriangle size={15} aria-hidden />
                                                <span>{sendError}</span>
                                            </div>
                                        )}
                                        {view === 'readable' ? <ReportPreview body={built.body} trimmed={built.trimmed} /> : <RawJson body={built.body} />}
                                        <div className="rp-never" style={{ marginTop: 14 }}>
                                            <ShieldCheck size={15} aria-hidden />
                                            Never included: messages, keys, file names, contacts, names.
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="rp-foot">
                        {step === 'category' && (
                            <>
                                <span className="rp-foot-note"><ShieldCheck size={14} aria-hidden /> You’ll review everything before it’s sent.</span>
                                <span className="rp-spacer" />
                                <ClButton variant="ghost" onClick={close}>Cancel</ClButton>
                            </>
                        )}
                        {step === 'details' && (
                            <>
                                <ClButton variant="ghost" onClick={() => setStep('category')}><ArrowLeft size={15} aria-hidden /> Back</ClButton>
                                <span className="rp-spacer" />
                                <ClButton onClick={toPreview} disabled={emailTouched && !emailOk}>Review report</ClButton>
                            </>
                        )}
                        {step === 'preview' && (
                            <>
                                <ClButton variant="ghost" onClick={() => setStep('details')} disabled={phase === 'sending'}><ArrowLeft size={15} aria-hidden /> Back</ClButton>
                                <span className="rp-spacer" />
                                {saveState === 'saved' && <span className="rp-foot-note" role="status"><Check size={14} style={{ color: 'var(--cl-ok)' }} aria-hidden /> Saved</span>}
                                {saveState === 'failed' && <span className="rp-foot-note" role="alert" style={{ color: 'var(--cl-flash)' }}>Couldn’t save the file</span>}
                                <ClButton variant="ghost" onClick={doSave} disabled={!built || phase === 'sending' || saveState === 'saving'} loading={saveState === 'saving'}>
                                    <Download size={15} aria-hidden /> Save to file
                                </ClButton>
                                <ClButton onClick={doSend} disabled={!built || !token || phase === 'sending'} loading={phase === 'sending'}>
                                    {phase === 'sending' ? 'Sending…' : sendError ? <><RotateCcw size={15} aria-hidden /> Try again</> : <><Send size={15} aria-hidden /> Send to Cipherline</>}
                                </ClButton>
                            </>
                        )}
                    </div>

                    {/* Last in DOM order so ClModal's first-focusable autofocus lands
                        on the content, not on the close button. */}
                    <button
                        type="button"
                        className="rp-close"
                        style={{ position: 'absolute', top: 22, right: 22 }}
                        onClick={close}
                        disabled={phase === 'sending'}
                        aria-label="Close"
                    >
                        <X size={17} aria-hidden />
                    </button>
                </>
            )}
        </ClModal>
    );
};

export default ReportProblemModal;
