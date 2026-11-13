import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Flag, CheckCircle2, ShieldCheck, BadgeCheck, ImagePlus, X } from 'lucide-react';
import { API_BASE } from '../constants';
import { ClButton, ClModal, ClSelect, ClTextarea } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText, DialogError } from './dialog/DialogFrame';
import { DialogForm, DialogField, DialogStack, DialogNote } from './dialog/DialogExtras';
import type { ClSelectOption } from './cl';
import { useModalExit } from '../hooks/useModalExit';
import { safeImageSrc } from '../utils/safeMediaUrl';
import { REPORT_SNIPPET_MAX, snippetWithEvidence, type ReportEvidence } from '../utils/integrations/coverReport';
import { buildFrankedReport, type FrankedReportResult, type ReportedMessageRef } from '../utils/franking';
import {
    REPORT_IMAGE_MAX_BYTES, REPORT_IMAGE_MAX_COUNT, REPORT_IMAGE_TYPES, pickReportImages, reportedFileProblem, uploadReportEvidence,
    type PickedImage, type ReportImageType,
} from '../utils/reportEvidenceFiles';

const REPORT_TYPES = [
    { value: 'csam',          label: 'Child sexual abuse material (CSAM)' },
    { value: 'harassment',    label: 'Harassment or bullying' },
    { value: 'violence',      label: 'Threats or incitement to violence' },
    { value: 'spam',          label: 'Spam or unsolicited messages' },
    { value: 'impersonation', label: 'Impersonation' },
    { value: 'other',         label: 'Other violation' },
] as const;

interface Props {
    targetUserId: string;
    targetUsername: string;
    token: string;
    onClose: () => void;
    /** Pre-fills the content excerpt - used when reporting a specific message
     *  so the reporter doesn't have to retype/repaste what they saw. */
    initialSnippet?: string;
    /**
     * Content this device decrypted and the server cannot see (a friend's
     * end-to-end encrypted cover). Shown, removable, and appended to the
     * excerpt on send (utils/integrations/coverReport.ts).
     */
    evidence?: ReportEvidence;
    /**
     * The message being reported. With its franking proof (utils/franking.ts)
     * the report carries a message the API can VERIFY was sent by the reported
     * user, unchanged - the typed excerpt is then not needed (and not trusted).
     */
    message?: ReportedMessageRef;
}

const REPORT_OPTIONS: ClSelectOption<string>[] = [
    { value: '', label: 'Select a reason…' },
    ...REPORT_TYPES.map(t => ({ value: t.value, label: t.label })),
];

type Proof = { state: 'none' } | { state: 'checking' } | { state: 'ready'; result: FrankedReportResult };

const WHY_UNVERIFIED: Record<string, string> = {
    no_franking: 'This message was sent before messages could be verified (or from an older version of the app), so it will be reported as text you provide, marked unverified.',
    content_changed: 'This message was edited after it was received without a verifiable copy of the edit, so it will be reported as text you provide, marked unverified.',
    no_content: 'This message has no text to verify, so it will be reported as text you provide, marked unverified.',
    sender_mismatch: 'This message could not be tied to the account you are reporting, so it will be reported as unverified.',
    malformed: 'This message could not be verified, so it will be reported as text you provide, marked unverified.',
};

interface Shot { id: number; picked: PickedImage; url: string }

export const ReportModal: React.FC<Props> = ({ targetUserId, targetUsername, token, onClose, initialSnippet, evidence, message }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const [reportType, setReportType] = useState('');
    const [description, setDescription] = useState('');
    const [snippet, setSnippet] = useState((initialSnippet ?? '').slice(0, 4000));
    const [submitting, setSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [attach, setAttach] = useState(!!evidence);
    const attached = attach && evidence ? evidence : null;
    const snippetMax = attached ? Math.max(0, REPORT_SNIPPET_MAX - attached.text.length - 2) : REPORT_SNIPPET_MAX;
    const evidenceImg = safeImageSrc(attached?.imageSrc ?? null);

    // ── Message franking: can the reported message be sent as a VERIFIED message? ──
    // The check is async (WebCrypto); its result is filed against the message it was for, so
    // a different `message` reads as "checking" again without any state reset in the effect.
    const [checked, setChecked] = useState<{ for: ReportedMessageRef; result: FrankedReportResult } | null>(null);
    useEffect(() => {
        if (!message) return;
        let cancelled = false;
        void buildFrankedReport(message).then(result => { if (!cancelled) setChecked({ for: message, result }); });
        return () => { cancelled = true; };
    }, [message]);
    const proof: Proof = !message ? { state: 'none' }
        : checked && checked.for === message ? { state: 'ready', result: checked.result }
        : { state: 'checking' };
    const franked = proof.state === 'ready' && proof.result.ok ? proof.result.franked : null;
    const unverifiedWhy = proof.state === 'ready' && !proof.result.ok ? (WHY_UNVERIFIED[proof.result.reason] ?? WHY_UNVERIFIED.malformed) : null;

    // The decrypted image of a verified attachment message, offered as evidence
    // (the API checks it against the hash the sender committed to).
    // Videos, GIFs and other files cannot be sent (the API takes PNG, JPEG or
    // WebP up to 8 MB), so they are not offered: the dialog says why instead.
    const fileProblem = franked?.kind === 'attachment' ? reportedFileProblem(franked.attachment) : null;
    const attachmentUrl = franked?.kind === 'attachment' && !fileProblem ? safeImageSrc(message?.attachmentUrl ?? null) : undefined;
    const [includeFile, setIncludeFile] = useState(true);

    // ── Screenshots ──
    const [shots, setShots] = useState<Shot[]>([]);
    const [shotProblems, setShotProblems] = useState<string[]>([]);
    const nextShotId = useRef(1);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const shotsRef = useRef<Shot[]>([]);
    useEffect(() => { shotsRef.current = shots; }, [shots]);
    useEffect(() => () => { for (const s of shotsRef.current) URL.revokeObjectURL(s.url); }, []);
    const isCsam = reportType === 'csam';

    const addFiles = async (list: FileList | null) => {
        if (!list || list.length === 0) return;
        const { accepted, problems } = await pickReportImages(shotsRef.current.length, Array.from(list));
        setShotProblems(problems);
        if (accepted.length) {
            setShots(prev => [...prev, ...accepted.map(picked => ({ id: nextShotId.current++, picked, url: URL.createObjectURL(picked.file) }))]);
        }
        if (fileInput.current) fileInput.current.value = '';
    };
    const removeShot = (id: number) => {
        setShots(prev => {
            const gone = prev.find(s => s.id === id);
            if (gone) URL.revokeObjectURL(gone.url);
            return prev.filter(s => s.id !== id);
        });
        setShotProblems([]);
    };

    const [sentNote, setSentNote] = useState<string | null>(null);

    const submit = async () => {
        if (!reportType) { setError('Please select a reason for the report.'); return; }
        setSubmitting(true);
        setError(null);
        try {
            const base = {
                reported_user_id: targetUserId,
                report_type: reportType,
                description: description.trim() || undefined,
                // A verified message replaces the typed excerpt: only text the reporter
                // added themselves (cover evidence) still rides in the excerpt.
                content_snippet: snippetWithEvidence(franked ? '' : snippet, attached) || undefined,
            };
            const headers = { Authorization: `Bearer ${token}` };
            let res;
            try {
                res = await axios.post(`${API_BASE}/reports`, franked ? { ...base, franked_message: franked } : base, { headers });
            } catch (e) {
                // An API that predates franking rejects the unknown field (400): fall back
                // to the plain report, carrying the message as the excerpt it always was.
                const status = (e as { response?: { status?: number } })?.response?.status;
                if (!franked || status !== 400) throw e;
                const fallbackSnippet = snippetWithEvidence(initialSnippet ?? snippet, attached) || undefined;
                res = await axios.post(`${API_BASE}/reports`, { ...base, content_snippet: fallbackSnippet }, { headers });
            }
            const reportId: string | undefined = res?.data?.id;
            const verdict: string | undefined = res?.data?.evidence;

            // Images go up AFTER the report exists. A failure here never undoes the report.
            let failed = 0;
            let total = 0;
            if (reportId && !isCsam) {
                for (const s of shots) {
                    total++;
                    if (!await uploadReportEvidence({ reportId, kind: 'screenshot', blob: s.picked.file, type: s.picked.type, token })) failed++;
                }
                if (attachmentUrl && includeFile && verdict === 'verified') {
                    total++;
                    let ok = false;
                    try {
                        const blob = await (await fetch(attachmentUrl)).blob();
                        const t = blob.type as ReportImageType;
                        if ((REPORT_IMAGE_TYPES as readonly string[]).includes(t) && blob.size <= REPORT_IMAGE_MAX_BYTES) {
                            ok = await uploadReportEvidence({ reportId, kind: 'attachment', blob, type: t, token });
                        }
                    } catch { /* counted as failed below */ }
                    if (!ok) failed++;
                }
            }
            const notes: string[] = [];
            if (franked && verdict === 'unverified') notes.push('The message could not be verified by the server, so it was filed as unverified text.');
            if (failed > 0) notes.push(`${failed} of ${total} image${total === 1 ? '' : 's'} could not be attached.`);
            setSentNote(notes.length ? notes.join(' ') : null);
            setSubmitted(true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (e: any) {
            setError(e?.response?.data?.message || 'Failed to submit report. Please try again.');
        } finally {
            setSubmitting(false);
        }
    };

    const preview = franked
        ? franked.kind === 'text' ? franked.text ?? ''
        : franked.kind === 'attachment' ? `[Attachment: ${franked.attachment?.filename ?? 'file'}]`
        : '[GIF]'
        : '';

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={460}
            overlayStyle={{ zIndex: 10000 }}
            label={`Report ${targetUsername}`}
            cardClassName="dlg-card"
        >
            {submitted ? (
                <>
                    <DialogHeader
                        tone="ok"
                        icon={<CheckCircle2 size={18} strokeWidth={2.2} />}
                        title="Report sent"
                        subtitle="Thank you for helping keep Cipherline safe."
                    />
                    <DialogBody>
                        <DialogText>
                            Your report has been received. Our team will review it and take appropriate action.
                        </DialogText>
                        {sentNote && <DialogText>{sentNote}</DialogText>}
                    </DialogBody>
                    <DialogFooter>
                        <ClButton size="sm" onClick={handleClose}>Done</ClButton>
                    </DialogFooter>
                </>
            ) : (
                <DialogForm onSubmit={() => { if (!submitting) void submit(); }}>
                    <DialogHeader
                        tone="danger"
                        icon={<Flag size={18} strokeWidth={2.2} />}
                        title={`Report ${targetUsername}`}
                        subtitle="Tell our team what happened."
                    />
                    <DialogBody className="dlg-body--scroll">
                        <DialogStack>
                            <DialogNote icon={<ShieldCheck size={15} />}>
                                Because messages are end-to-end encrypted, only you can see their content.
                                The information you include here is what our team will have to review.
                                False reports may result in action against your account.
                            </DialogNote>

                            <DialogField label="Reason" aside="Required">
                                <ClSelect<string>
                                    value={reportType}
                                    onChange={(v) => { setReportType(v); setError(null); }}
                                    options={REPORT_OPTIONS}
                                    ariaLabel="Reason"
                                    style={{ width: '100%' }}
                                />
                            </DialogField>

                            <DialogField label="Description" aside="Optional" htmlFor="report-description">
                                <ClTextarea
                                    id="report-description"
                                    placeholder="Briefly describe the violation…"
                                    value={description}
                                    maxLength={2000}
                                    onChange={e => setDescription(e.target.value)}
                                    style={{ width: '100%', height: 80, resize: 'none' }}
                                />
                            </DialogField>

                            {franked && (
                                <DialogField label="The message" aside="Verified">
                                    <div data-testid="report-verified" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        <DialogNote tone="ok" icon={<BadgeCheck size={15} />}>
                                            This message is sent with a cryptographic proof that {targetUsername} sent exactly
                                            this, so it cannot be changed or faked. Our team sees it as verified.
                                        </DialogNote>
                                        <div
                                            data-testid="report-verified-text"
                                            style={{ fontFamily: 'var(--cl-font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto', padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}
                                        >
                                            {preview}
                                        </div>
                                        {attachmentUrl && !isCsam && (
                                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                                                <input type="checkbox" checked={includeFile} onChange={e => setIncludeFile(e.target.checked)} data-testid="report-include-file" />
                                                <span>Also send the image from this message (checked against what was sent)</span>
                                            </label>
                                        )}
                                        {fileProblem && !isCsam && (
                                            <div data-testid="report-file-not-sendable">
                                                <DialogNote role="note">
                                                    {fileProblem === 'size'
                                                        ? 'This image is too large to send with a report (over 8 MB), so our team will see only its name, type and size.'
                                                        : 'This file can’t be sent with a report, so our team will see only its name, type and size.'}
                                                    {' '}Add a screenshot below if it helps show what’s in it.
                                                </DialogNote>
                                            </div>
                                        )}
                                    </div>
                                </DialogField>
                            )}
                            {proof.state === 'checking' && (
                                <DialogNote role="status">Checking the message…</DialogNote>
                            )}
                            {unverifiedWhy && (
                                <DialogNote tone="warn" role="note">{unverifiedWhy}</DialogNote>
                            )}

                            {evidence && (
                                <DialogField label="Attached" aside={attached ? 'Sent with your report' : 'Not attached'}>
                                    <div className="report-evidence" data-testid="report-evidence" data-attached={attached ? 'true' : 'false'}
                                        style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        {evidenceImg && attached && (
                                            <img src={evidenceImg} alt="" width={48} height={48} draggable={false}
                                                style={{ borderRadius: 6, objectFit: 'cover', flex: 'none' }} />
                                        )}
                                        <span style={{ flex: 1, minWidth: 0 }}>{evidence.label}</span>
                                        <ClButton type="button" variant="ghost" size="sm" onClick={() => setAttach(a => !a)}>
                                            {attached ? 'Remove' : 'Attach'}
                                        </ClButton>
                                    </div>
                                </DialogField>
                            )}

                            {!franked && (
                                <DialogField
                                    label="Content excerpt"
                                    aside={proof.state === 'none' && !message ? 'Optional — paste what you saw' : 'Unverified'}
                                    htmlFor="report-snippet"
                                >
                                    <ClTextarea
                                        id="report-snippet"
                                        placeholder="Paste a message or describe content you received…"
                                        value={snippet}
                                        maxLength={snippetMax}
                                        onChange={e => setSnippet(e.target.value)}
                                        style={{ width: '100%', height: 80, resize: 'none', fontFamily: 'var(--cl-font-mono)' }}
                                    />
                                </DialogField>
                            )}

                            {isCsam ? (
                                <DialogNote tone="warn" role="note" icon={<ShieldCheck size={15} />}>
                                    Do not capture or upload images for a child-safety report. Our team gets what it needs
                                    from the report itself.
                                </DialogNote>
                            ) : (
                                <DialogField label="Screenshots" aside={`Optional — up to ${REPORT_IMAGE_MAX_COUNT}`}>
                                    <div data-testid="report-shots" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {shots.length > 0 && (
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                {shots.map(s => (
                                                    <div key={s.id} data-testid="report-shot" style={{ position: 'relative', width: 72, height: 72 }}>
                                                        <img src={safeImageSrc(s.url)} alt={s.picked.file.name} width={72} height={72} draggable={false}
                                                            style={{ borderRadius: 8, objectFit: 'cover', width: 72, height: 72 }} />
                                                        <button
                                                            type="button"
                                                            aria-label={`Remove ${s.picked.file.name}`}
                                                            onClick={() => removeShot(s.id)}
                                                            style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
                                                        >
                                                            <X size={12} />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        <input
                                            ref={fileInput}
                                            type="file"
                                            accept={REPORT_IMAGE_TYPES.join(',')}
                                            multiple
                                            hidden
                                            data-testid="report-shot-input"
                                            onChange={e => { void addFiles(e.target.files); }}
                                        />
                                        <div>
                                            <ClButton
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                disabled={shots.length >= REPORT_IMAGE_MAX_COUNT || submitting}
                                                onClick={() => fileInput.current?.click()}
                                            >
                                                <ImagePlus size={14} style={{ marginRight: 6 }} />
                                                Add a screenshot
                                            </ClButton>
                                        </div>
                                        {shotProblems.map((p, i) => (
                                            <div key={i} className="dlg-field-error" role="alert">{p}</div>
                                        ))}
                                    </div>
                                </DialogField>
                            )}
                        </DialogStack>
                    </DialogBody>
                    {error && <DialogError>{error}</DialogError>}
                    <DialogFooter hint={submitting ? 'Sending…' : 'Only what you include is sent'}>
                        <ClButton type="button" variant="ghost" size="sm" onClick={handleClose} disabled={submitting}>Cancel</ClButton>
                        <ClButton
                            type="submit"
                            variant="danger"
                            size="sm"
                            disabled={!reportType || submitting || proof.state === 'checking'}
                            loading={submitting}
                        >
                            {submitting ? 'Submitting…' : 'Submit report'}
                        </ClButton>
                    </DialogFooter>
                </DialogForm>
            )}
        </ClModal>
    );
};
