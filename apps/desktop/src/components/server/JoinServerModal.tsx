import React, { useId, useRef, useState } from 'react';
import { Link, MailOpen, Users, ServerCrash } from 'lucide-react';
import { ClModal, ClButton, ClInput } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';
import axios from 'axios';
import { apiUrl } from '../../utils/apiPath';
import { ServerIcon } from './ServerIcon';
import { motion, useReducedMotion } from 'framer-motion';
import { useInvitePreview } from '../../hooks/useInvitePreview';
import type { ServerInfo } from '../../hooks/useServers';
import { DialogHeader, DialogBody, DialogFooter, DialogError, useInitialFocus } from '../dialog/DialogFrame';
import { DialogForm, DialogField, DialogStack, DialogNote } from '../dialog/DialogExtras';
import { BusyLabel } from '../dialog/BusyLabel';
import '../../styles/dialog-server.css';

// ── InvitePreviewModal — rich modal for deep-link cipherline://invite/<CODE> ──

/**
 * Staggered entrance for the pieces of the join prompt when it is an ARRIVAL
 * (the invite was carried through signup): the server block settles in, then
 * the Join button. Renders its children untouched when `on` is false, so the
 * everyday "someone sent me a link" prompt is exactly what it always was.
 */
const Arrive: React.FC<{ on: boolean; delay: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ on, delay, children, style }) => {
    const reduce = useReducedMotion();
    if (!on) return <>{children}</>;
    return (
        <motion.div
            style={style}
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

/**
 * The invite prompt, in the house dialog pattern (components/dialog/DialogFrame).
 * States: checking the invite, ready to join, already a member, expired, and
 * could-not-load (with a retry). The primary takes focus when it can act, so
 * Enter joins; Escape / Cancel never do.
 */
export const InvitePreviewModal: React.FC<InvitePreviewModalProps> = ({
    code, token, servers, arrival = false, onJoin, onClose,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const { preview, state, reload } = useInvitePreview(code, token, servers);
    const [joining, setJoining]     = useState(false);
    const [joinError, setJoinError] = useState<string | null>(null);
    const primaryRef = useRef<HTMLSpanElement>(null);

    const handleJoin = async () => {
        if (!token || !preview || joining) return;
        setJoining(true);
        setJoinError(null);
        try {
            await axios.post(
                apiUrl`/invites/${code}/accept`,
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

    const dead = state === 'invalid' || state === 'error' || (state !== 'loading' && !preview);
    const ready = !!preview && !dead && state !== 'loading';
    const joined = ready && state === 'joined';
    // Initial focus goes to the primary once it can act (a join is not destructive, so Enter confirms).
    useInitialFocus(primaryRef, (ready && (joined || !!token)) || state === 'error' || state === 'invalid');

    const title = arrival ? "Welcome — you've been invited" : "You've been invited";
    const subtitle = state === 'loading' ? 'Checking the invite…'
        : state === 'invalid' ? 'This invite is no longer valid.'
        : dead ? "We couldn't load this invite."
        : joined ? 'It’s already in your server list.'
        : 'Review the server, then join.';

    let footer: React.ReactNode;
    if (state === 'invalid') {
        footer = (
            <span className="dlg-focus-slot" ref={primaryRef}>
                <ClButton type="button" size="sm" onClick={handleClose}>Close</ClButton>
            </span>
        );
    } else if (dead) {
        // useInvitePreview already retried with backoff before landing in 'error' —
        // this is very likely still transient, so offer a manual retry rather than
        // a dead end. Not offered for 'invalid': that's a real 404/400.
        footer = (
            <>
                <ClButton type="button" variant="ghost" size="sm" onClick={handleClose}>Close</ClButton>
                <span className="dlg-focus-slot" ref={primaryRef}>
                    <ClButton type="button" size="sm" onClick={reload}>Try again</ClButton>
                </span>
            </>
        );
    } else if (joined && preview) {
        footer = (
            <>
                <ClButton type="button" variant="ghost" size="sm" onClick={handleClose}>Cancel</ClButton>
                <span className="dlg-focus-slot" ref={primaryRef}>
                    <ClButton type="button" size="sm" onClick={() => { onJoin(preview.server_id, preview.server_name); handleClose(); }}>Go to server</ClButton>
                </span>
            </>
        );
    } else {
        footer = (
            <Arrive on={arrival && ready} delay={0.35} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ClButton type="button" variant="ghost" size="sm" onClick={handleClose} disabled={joining}>{arrival ? 'Not now' : 'Cancel'}</ClButton>
                <span className="dlg-focus-slot" ref={primaryRef}>
                    <ClButton type="submit" size="sm" disabled={!ready || !token} className={joining ? 'dlg-busy' : undefined}>
                        <BusyLabel busy={joining}>Join server</BusyLabel>
                    </ClButton>
                </span>
            </Arrive>
        );
    }

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={420}
            overlayStyle={{ zIndex: 1200 }}
            label="Server invite"
            cardClassName="dlg-card dlg-card--srv"
        >
            <DialogHeader icon={<MailOpen size={18} strokeWidth={2.2} />} title={title} subtitle={subtitle} />
            <DialogForm onSubmit={() => { if (ready && !joined) void handleJoin(); }}>
                <DialogBody>
                    {state === 'loading' ? (
                        <div className="dlg-srv" aria-busy="true" aria-label="Checking the invite">
                            <div className="dlg-skel" style={{ width: 64, height: 64, borderRadius: 16, flex: 'none' }} />
                            <div className="dlg-srv-text" style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 }}>
                                <div className="dlg-skel" style={{ height: 16, width: '70%' }} />
                                <div className="dlg-skel" style={{ height: 12, width: '45%' }} />
                            </div>
                        </div>
                    ) : dead || !preview ? (
                        <div className="dlg-srv">
                            <span className="dlg-srv-badge" aria-hidden="true">
                                <ServerCrash size={26} />
                            </span>
                            <div className="dlg-srv-text">
                                <div className="dlg-srv-name">{state === 'invalid' ? 'Invite expired' : 'Invite unavailable'}</div>
                                <div className="dlg-srv-desc">
                                    {state === 'invalid'
                                        ? 'Ask the person who sent it for a new link.'
                                        : 'Could not load invite info. Check your connection and try again.'}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <DialogStack>
                            <Arrive on={arrival} delay={0.12}>
                                <div className="dlg-srv">
                                    <ServerIcon
                                        serverId={preview.server_id}
                                        name={preview.server_name}
                                        attachmentId={preview.server_icon}
                                        keyB64={preview.server_icon_key_b64}
                                        nonceB64={preview.server_icon_nonce_b64}
                                        token={token}
                                        className="w-16 h-16 rounded-2xl text-[22px] shrink-0"
                                    />
                                    <div className="dlg-srv-text">
                                        <div className="dlg-srv-name" title={preview.server_name}>{preview.server_name}</div>
                                        {preview.server_description && (
                                            <div className="dlg-srv-desc">{preview.server_description}</div>
                                        )}
                                        <div className="dlg-srv-meta">
                                            <Users size={13} />
                                            <span>{preview.member_count.toLocaleString()} member{preview.member_count !== 1 ? 's' : ''}</span>
                                        </div>
                                    </div>
                                </div>
                            </Arrive>
                            {joined && (
                                <DialogNote tone="ok" role="status">You&rsquo;re already a member of this server.</DialogNote>
                            )}
                        </DialogStack>
                    )}
                </DialogBody>
                {joinError && <DialogError>{joinError}</DialogError>}
                <DialogFooter hint={joining ? 'Joining…' : undefined}>{footer}</DialogFooter>
            </DialogForm>
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
    const codeId = useId();
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

    const handleSubmit = async () => {
        if (loading) return;
        const parsedCode = parseCode(code);
        if (!parsedCode) { setError('Please enter a valid invite code or link'); return; }
        setLoading(true);
        setError(null);
        try {
            await onJoinServer(parsedCode);
            handleClose();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
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
        <ClModal open={!closing} onClose={handleClose} width={440} label="Join a Server" cardClassName="dlg-card dlg-card--srv">
            <DialogHeader
                icon={<Link size={18} strokeWidth={2.2} />}
                title="Join a Server"
                subtitle="Paste an invite link or code"
            />
            <DialogForm onSubmit={handleSubmit}>
                <DialogBody>
                    <DialogField label="Invite link or code" htmlFor={codeId}>
                        <ClInput
                            id={codeId}
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                            value={code}
                            onChange={e => setCode(e.target.value)}
                            placeholder="https://cipherline.chat/invite/AbCd1234"
                            aria-invalid={error ? true : undefined}
                        />
                    </DialogField>
                </DialogBody>
                {error && <DialogError>{error}</DialogError>}
                <DialogFooter hint={loading ? 'Joining…' : 'A full link or just the code'}>
                    <ClButton type="button" variant="ghost" size="sm" onClick={handleClose}>Cancel</ClButton>
                    <ClButton type="submit" size="sm" disabled={!code.trim()} className={loading ? 'dlg-busy' : undefined}>
                        <BusyLabel busy={loading}>Join server</BusyLabel>
                    </ClButton>
                </DialogFooter>
            </DialogForm>
        </ClModal>
    );
};

export default JoinServerModal;
