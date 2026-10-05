import React, { useState } from 'react';
import { X, Link, Users, ServerCrash, CheckCircle2, RotateCw } from 'lucide-react';
import { ClModal, ClButton, ClInput, ClField } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';
import axios from 'axios';
import { API_BASE } from '../../constants';
import { ServerIcon } from './ServerIcon';
import { motion, useReducedMotion } from 'framer-motion';
import { useInvitePreview } from '../../hooks/useInvitePreview';
import type { ServerInfo } from '../../hooks/useServers';

// ── InvitePreviewModal — rich modal for deep-link cipherline://invite/<CODE> ──

/**
 * Staggered entrance for the pieces of the join prompt when it is an ARRIVAL
 * (the invite was carried through signup): the server block settles in, then
 * the Join button. Renders its children untouched when `on` is false, so the
 * everyday "someone sent me a link" prompt is exactly what it always was.
 */
const Arrive: React.FC<{ on: boolean; delay: number; children: React.ReactNode }> = ({ on, delay, children }) => {
    const reduce = useReducedMotion();
    if (!on) return <>{children}</>;
    return (
        <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.94 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26, delay: reduce ? 0 : delay }}
        >
            {children}
        </motion.div>
    );
};

interface InvitePreviewModalProps {
    code: string;
    token: string | null;
    servers: ServerInfo[];
    /** The invite was carried through signup: play the welcome entrance and use
     *  welcome copy. Never changes what Join does — it is still the person's click. */
    arrival?: boolean;
    onJoin: (serverId: string, serverName: string) => void;
    onClose: () => void;
}

export const InvitePreviewModal: React.FC<InvitePreviewModalProps> = ({
    code, token, servers, arrival = false, onJoin, onClose,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const { preview, state, reload } = useInvitePreview(code, token, servers);
    const [joining, setJoining]     = useState(false);
    const [joinError, setJoinError] = useState<string | null>(null);

    const handleJoin = async () => {
        if (!token || !preview || joining) return;
        setJoining(true);
        setJoinError(null);
        try {
            await axios.post(
                `${API_BASE}/invites/${code}/accept`,
                {},
                { headers: { Authorization: `Bearer ${token}` } },
            );
            // No setState('joined') here: `state` is owned by useInvitePreview,
            // which has no setter in its public surface — the call referenced an
            // undeclared name and threw a ReferenceError the moment the POST
            // succeeded. That landed in the catch below, so the user got
            // "Failed to join" on a join that had in fact worked, and onJoin()
            // never ran, so nothing refreshed the server list or navigated.
            // Restarting the app showed them in the server. Exactly the
            // "joining requires a refresh and throws an error" report.
            //
            // It was also redundant: useInvitePreview reconciles state to
            // 'joined' by itself once `servers` contains this server, which is
            // what onJoin's loadServers() brings about.
            onJoin(preview.server_id, preview.server_name);
        } catch (e: unknown) {
            // Only an HTTP failure carries a server message. Anything else is a
            // bug on our side and would otherwise be disguised as a join
            // failure — surface it instead of swallowing it.
            const msg = axios.isAxiosError(e) ? e.response?.data?.message : undefined;
            if (!axios.isAxiosError(e)) console.error('[JoinServer] join threw:', e);
            setJoinError(msg ?? 'Failed to join');
        } finally {
            setJoining(false);
        }
    };

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={380}
            overlayStyle={{ zIndex: 1200 }}
            cardStyle={{ overflow: 'hidden' }}
        >
            <div className="flex items-center justify-between px-5 pt-5 pb-4">
                <h2 className="font-display font-semibold text-[17px] text-cl-text mt-0 mb-0">{arrival ? "Welcome \u2014 you've been invited" : "You've been invited"}</h2>
                <ClButton icon onClick={handleClose} variant="ghost" tooltip="Close">
                    <X size={15} />
                </ClButton>
            </div>
            <div className="px-5 pb-5">
                {state === 'loading' ? (
                    <div className="flex items-center gap-3 py-4">
                        <div className="w-14 h-14 rounded-2xl bg-white/[0.06] animate-pulse shrink-0" />
                        <div className="flex-1 space-y-2">
                            <div className="h-4 w-40 bg-white/[0.06] rounded animate-pulse" />
                            <div className="h-3 w-24 bg-white/[0.04] rounded animate-pulse" />
                        </div>
                    </div>
                ) : (state === 'invalid' || state === 'error' || !preview) ? (
                    <div className="flex items-center gap-3 py-4 opacity-60">
                        <span className="w-14 h-14 rounded-2xl bg-white/[0.05] flex items-center justify-center shrink-0">
                            <ServerCrash size={24} className="text-cl-faint" />
                        </span>
                        <div className="flex-1 min-w-0">
                            <p className="font-semibold text-[14px] text-cl-muted">{state === 'invalid' ? 'Invite expired' : 'Invite unavailable'}</p>
                            <p className="text-[12px] text-cl-faint mt-0.5">{state === 'invalid' ? 'This invite is no longer valid.' : 'Could not load invite info.'}</p>
                            {/* useInvitePreview already retried with backoff before
                                landing in 'error' — this is very likely still
                                transient, so offer a manual retry rather than a
                                dead end. Not shown for 'invalid': that's a real
                                404/400, retrying won't help. */}
                            {state === 'error' && (
                                <button
                                    type="button"
                                    onClick={reload}
                                    className="flex items-center gap-1 text-[12px] text-cl-lume hover:underline mt-1.5"
                                >
                                    <RotateCw size={12} /> Retry
                                </button>
                            )}
                        </div>
                    </div>
                ) : (
                    <>
                        <Arrive on={arrival} delay={0.12}>
                        <div className="flex items-start gap-4 py-2 mb-5">
                            <ServerIcon
                                serverId={preview.server_id}
                                name={preview.server_name}
                                attachmentId={preview.server_icon}
                                keyB64={preview.server_icon_key_b64}
                                nonceB64={preview.server_icon_nonce_b64}
                                token={token}
                                className="w-16 h-16 rounded-2xl text-[22px] shrink-0"
                            />
                            <div className="flex-1 min-w-0 pt-1">
                                <p className="font-bold text-[17px] text-cl-text leading-tight truncate">{preview.server_name}</p>
                                {preview.server_description && (
                                    <p className="text-[12px] text-cl-faint leading-snug mt-1 line-clamp-2">{preview.server_description}</p>
                                )}
                                <div className="flex items-center gap-1.5 mt-1.5">
                                    <Users size={12} className="text-cl-faint shrink-0" />
                                    <span className="text-[12px] text-cl-faint">{preview.member_count.toLocaleString()} member{preview.member_count !== 1 ? 's' : ''}</span>
                                </div>
                            </div>
                        </div>
                        </Arrive>
                        {joinError && <p className="text-[12px] text-cl-flash mb-3">{joinError}</p>}
                        {state === 'joined' ? (
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-[13px] text-cl-ok font-medium mb-2">
                                    <CheckCircle2 size={14} /> You're already a member of this server.
                                </div>
                                <ClButton fullWidth onClick={() => { onJoin(preview.server_id, preview.server_name); handleClose(); }}>Go to Server →</ClButton>
                                <ClButton variant="ghost" fullWidth onClick={handleClose}>Cancel</ClButton>
                            </div>
                        ) : (
                            <Arrive on={arrival} delay={0.35}>
                            <div className="space-y-2">
                                <ClButton fullWidth disabled={joining || !token} loading={joining} onClick={handleJoin}>{`Join ${preview.server_name}`}</ClButton>
                                <ClButton variant="ghost" fullWidth onClick={handleClose}>{arrival ? 'Not now' : 'Cancel'}</ClButton>
                            </div>
                            </Arrive>
                        )}
                    </>
                )}
            </div>
        </ClModal>
    );
};

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
    onClose: () => void;
    onJoinServer: (code: string) => Promise<void>;
}

export const JoinServerModal: React.FC<Props> = ({ onClose, onJoinServer }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const [code, setCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const parseCode = (input: string): string => {
        const trimmed = input.trim();
        const deepLink = trimmed.match(/cipherline:\/\/invite\/([A-Za-z0-9_-]+)/);
        if (deepLink) return deepLink[1];
        const urlMatch = trimmed.match(/\/invite\/([A-Za-z0-9_-]+)/);
        if (urlMatch) return urlMatch[1];
        return trimmed;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const parsedCode = parseCode(code);
        if (!parsedCode) { setError('Please enter a valid invite code or link'); return; }
        setLoading(true);
        setError(null);
        try {
            await onJoinServer(parsedCode);
            handleClose();
        } catch (err: any) {
            const msg = err?.response?.data?.message;
            if (msg?.includes('banned')) {
                setError('You are banned from this server');
            } else if (msg?.includes('expired') || msg?.includes('exhausted')) {
                setError('This invite has expired or reached its usage limit');
            } else {
                setError(msg ?? 'Invalid invite code');
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <ClModal open={!closing} onClose={handleClose} width={440} cardStyle={{ padding: '28px' }}>
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-cl-lume/15 flex items-center justify-center text-cl-lume border border-cl-lume/20">
                        <Link size={18} />
                    </div>
                    <div>
                        <h2 className="font-display font-semibold text-[17px] text-cl-text mt-0 mb-0">Join a Server</h2>
                        <p className="text-[12px] text-cl-faint">Paste an invite link or code</p>
                    </div>
                </div>
                <ClButton icon onClick={handleClose} variant="ghost" tooltip="Close">
                    <X size={16} />
                </ClButton>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
                <ClField label="Invite Code or Link">
                    <ClInput
                        autoFocus
                        value={code}
                        onChange={e => setCode(e.target.value)}
                        placeholder="https://cipherline.chat/invite/AbCd1234"
                    />
                </ClField>

                {error && (
                    <p className="text-sm text-cl-flash bg-cl-flash/10 rounded-xl px-3 py-2">{error}</p>
                )}

                <div className="flex gap-3 pt-2">
                    <ClButton type="button" variant="ghost" fullWidth style={{ flex: 1 }} onClick={handleClose}>Cancel</ClButton>
                    <ClButton type="submit" fullWidth disabled={loading || !code.trim()} loading={loading} style={{ flex: 1 }}>Join Server</ClButton>
                </div>
            </form>
        </ClModal>
    );
};

export default JoinServerModal;
