import React, { useState } from 'react';
import axios from 'axios';
import { Flag } from 'lucide-react';
import { API_BASE } from '../constants';
import { ClButton, ClModal, ClSelect, ClTextarea } from './cl';
import type { ClSelectOption } from './cl';
import { useModalExit } from '../hooks/useModalExit';

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
    /** Pre-fills the content excerpt — used when reporting a specific message
     *  so the reporter doesn't have to retype/repaste what they saw. */
    initialSnippet?: string;
}

const REPORT_OPTIONS: ClSelectOption<string>[] = [
    { value: '', label: 'Select a reason…' },
    ...REPORT_TYPES.map(t => ({ value: t.value, label: t.label })),
];

export const ReportModal: React.FC<Props> = ({ targetUserId, targetUsername, token, onClose, initialSnippet }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const [reportType, setReportType] = useState('');
    const [description, setDescription] = useState('');
    const [snippet, setSnippet] = useState((initialSnippet ?? '').slice(0, 4000));
    const [submitting, setSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        if (!reportType) { setError('Please select a reason for the report.'); return; }
        setSubmitting(true);
        setError(null);
        try {
            await axios.post(
                `${API_BASE}/reports`,
                {
                    reported_user_id: targetUserId,
                    report_type: reportType,
                    description: description.trim() || undefined,
                    content_snippet: snippet.trim() || undefined,
                },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setSubmitted(true);
        } catch (e: any) {
            setError(e?.response?.data?.message || 'Failed to submit report. Please try again.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={448}
            overlayStyle={{ zIndex: 10000 }}
            label={`Report ${targetUsername}`}
        >
            <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                    <Flag size={18} className="text-cl-flash shrink-0" />
                    <h2 className="text-base font-semibold text-white m-0" style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600 }}>Report {targetUsername}</h2>
                </div>

                {submitted ? (
                    <>
                        <p className="text-sm text-cl-muted">
                            Your report has been received. Our team will review it and take appropriate action.
                            Thank you for helping keep Cipherline safe.
                        </p>
                        <ClButton onClick={handleClose} fullWidth>Done</ClButton>
                    </>
                ) : (
                    <>
                        <p className="text-xs text-cl-faint leading-relaxed">
                            Because messages are end-to-end encrypted, only you can see their content.
                            The information you include here is what our team will have to review.
                            False reports may result in action against your account.
                        </p>

                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-cl-muted font-medium">Reason *</label>
                            <ClSelect<string>
                                value={reportType}
                                onChange={setReportType}
                                options={REPORT_OPTIONS}
                                style={{ width: '100%' }}
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-cl-muted font-medium">Description <span className="text-cl-faint">(optional)</span></label>
                            <ClTextarea
                                placeholder="Briefly describe the violation…"
                                value={description}
                                maxLength={2000}
                                onChange={e => setDescription(e.target.value)}
                                style={{ width: '100%', height: 80, resize: 'none' }}
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-cl-muted font-medium">
                                Content excerpt <span className="text-cl-faint">(optional — paste what you saw)</span>
                            </label>
                            <ClTextarea
                                placeholder="Paste a message or describe content you received…"
                                value={snippet}
                                maxLength={4000}
                                onChange={e => setSnippet(e.target.value)}
                                style={{ width: '100%', height: 80, resize: 'none', fontFamily: 'var(--cl-font-mono)' }}
                            />
                        </div>

                        {error && <p className="text-xs text-cl-flash">{error}</p>}

                        <div className="flex gap-2 justify-end">
                            <ClButton variant="ghost" onClick={handleClose} disabled={submitting}>Cancel</ClButton>
                            <ClButton
                                variant="danger"
                                onClick={submit}
                                disabled={!reportType || submitting}
                                loading={submitting}
                            >
                                {submitting ? 'Submitting…' : 'Submit report'}
                            </ClButton>
                        </div>
                    </>
                )}
            </div>
        </ClModal>
    );
};
