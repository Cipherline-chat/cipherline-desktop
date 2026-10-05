/**
 * ServerInviteModal — "Invite People".
 *
 * The quick-share path, and nothing else: open it, a working link is already
 * there, copy it, done. Defaults to 7 days and unlimited uses.
 *
 * It used to double as an invite manager — it listed every invite with revoke
 * buttons under an "Active links" heading, and picked the link to show by
 * taking the newest row by created_at. But `GET /servers/:id/invites` is an
 * audit log: it returns expired and exhausted invites too, on purpose, so the
 * settings screen can show history. So the modal routinely opened showing a
 * long-dead link as the server's invite, and listed dead links under "Active".
 *
 * Managing invites now lives solely in Server Settings → Invites, which
 * already had a fuller version of that list (per-invite use history, inviter,
 * revoke). This modal reuses the newest still-usable invite when there is one
 * and only creates a link when there isn't, so opening it repeatedly doesn't
 * litter the server with invites.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { X, Copy, Check, Link, UserPlus, Sparkles, Settings2, RotateCw } from 'lucide-react';
import { API_BASE } from '../../constants';
import type { ServerInfo } from '../../hooks/useServers';
import { ClModal, ClButton, ClField, ClInput, ClSelect } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';
import { writeToClipboard } from '../../utils/clipboard';
import { nudges } from '../../utils/firstWeekNudgeStore';
import { useToast } from '../../contexts/ToastContext';
import {
    toSeconds, clampExpirySeconds, clampUses, newestUsableInvite,
    USES_MIN, USES_MAX,
    type ExpiryUnit,
} from '../../utils/inviteLimits';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Invite {
    code: string;
    created_at: string;
    expires_at: string | null;
    max_uses: number | null;
    uses: number;
}

interface Props {
    server: ServerInfo;
    token: string | null;
    onClose: () => void;
}

/** `null` = never expires; `'custom'` = the custom-value row is active. */
type ExpiryChoice = number | null | 'custom';
/** `null` = unlimited; `'custom'` = the custom-value row is active. */
type UsesChoice = number | null | 'custom';

/** Hours. Discord's default, and the one most people want. */
const DEFAULT_EXPIRY_HOURS = 168;
/** Unlimited. */
const DEFAULT_MAX_USES: UsesChoice = null;

const EXPIRY_OPTIONS: { label: string; value: ExpiryChoice }[] = [
    { label: '30 min', value: 0.5 },
    { label: '1 hour', value: 1 },
    { label: '6 hours', value: 6 },
    { label: '12 hours', value: 12 },
    { label: '1 day', value: 24 },
    { label: '7 days', value: 168 },
    { label: '30 days', value: 720 },
    { label: 'Never', value: null },
    { label: 'Custom…', value: 'custom' },
];

const USE_OPTIONS: { label: string; value: UsesChoice }[] = [
    { label: '1', value: 1 },
    { label: '5', value: 5 },
    { label: '10', value: 10 },
    { label: '25', value: 25 },
    { label: '50', value: 50 },
    { label: '100', value: 100 },
    { label: '∞', value: null },
    { label: 'Custom…', value: 'custom' },
];

const EXPIRY_UNIT_OPTIONS: { value: ExpiryUnit; label: string }[] = [
    { value: 'minutes', label: 'minutes' },
    { value: 'hours', label: 'hours' },
    { value: 'days', label: 'days' },
];

/** Human summary of what the CURRENT link actually is. Only ever called with
 *  a usable invite, so there's no "Expired" branch — a dead link never
 *  reaches this modal any more. */
function describeInvite(inv: Invite): string {
    const expiry = (() => {
        if (!inv.expires_at) return 'Never expires';
        const ms = new Date(inv.expires_at).getTime() - Date.now();
        const h = Math.round(ms / 3_600_000);
        if (h < 1) return 'Expires in under an hour';
        if (h < 24) return `Expires in ${h}h`;
        return `Expires in ${Math.round(h / 24)} days`;
    })();
    const uses = inv.max_uses === null
        ? 'unlimited uses'
        : `${Math.max(inv.max_uses - inv.uses, 0)} of ${inv.max_uses} uses left`;
    return `${expiry} · ${uses}`;
}

/**
 * Last invite this session created per server, so reopening the modal reuses
 * it instead of minting another.
 *
 * The listing endpoint needs MANAGE_SERVER while creating only needs
 * CREATE_INVITE, so a member who can invite but not audit gets a 403 above and
 * has no way to discover the link they just made. Without this they'd mint a
 * fresh invite on every open — exactly the POST-per-open behaviour that got
 * auto-create removed from this modal in the first place.
 *
 * Module-level because the modal unmounts on close. Deliberately not
 * persisted: it's a within-session convenience, and a stale code surviving a
 * restart is worse than one extra invite.
 */
const sessionInvites = new Map<string, Invite>();

// ── Component ─────────────────────────────────────────────────────────────────

export const ServerInviteModal: React.FC<Props> = ({ server, token, onClose }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const toast = useToast();

    const [invite, setInvite]     = useState<Invite | null>(null);
    const [loading, setLoading]   = useState(true);
    const [working, setWorking]   = useState(false);
    const [copied, setCopied]     = useState(false);
    const [error, setError]       = useState<string | null>(null);
    const [showOptions, setShowOptions] = useState(false);
    const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>(DEFAULT_EXPIRY_HOURS);
    const [customExpiryValue, setCustomExpiryValue] = useState(1);
    const [customExpiryUnit, setCustomExpiryUnit]   = useState<ExpiryUnit>('days');
    const [usesChoice, setUsesChoice] = useState<UsesChoice>(DEFAULT_MAX_USES);
    const [customUses, setCustomUses] = useState(10);

    const resolvedExpirySeconds = expiryChoice === 'custom'
        ? clampExpirySeconds(toSeconds(customExpiryValue, customExpiryUnit))
        : expiryChoice === null
            ? null
            : clampExpirySeconds(Math.round(expiryChoice * 3600));
    const resolvedMaxUses = usesChoice === 'custom' ? clampUses(customUses) : usesChoice;

    const create = useCallback(async (): Promise<Invite | null> => {
        if (!token) return null;
        const body: Record<string, number> = {};
        if (resolvedMaxUses !== null) body.max_uses = resolvedMaxUses;
        if (resolvedExpirySeconds !== null) body.expires_in_seconds = resolvedExpirySeconds;
        const res = await axios.post(
            `${API_BASE}/servers/${server.server_id}/invites`,
            body,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const made = res.data as Invite;
        sessionInvites.set(server.server_id, made);
        return made;
    }, [token, server.server_id, resolvedMaxUses, resolvedExpirySeconds]);

    // On open: reuse the newest still-usable invite, or make one. Listing needs
    // MANAGE_SERVER while creating only needs CREATE_INVITE, so a 403 here is a
    // permission level, not a failure — fall straight through to creating.
    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        (async () => {
            let existing: Invite | null = null;
            try {
                const res = await axios.get(`${API_BASE}/servers/${server.server_id}/invites`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                existing = newestUsableInvite<Invite>(res.data ?? []);
            } catch {
                // 403 (no MANAGE_SERVER) or offline. Fall back to whatever this
                // session already made for this server, if it's still good.
                const cached = sessionInvites.get(server.server_id);
                if (cached && newestUsableInvite<Invite>([cached])) existing = cached;
            }

            if (cancelled) return;
            if (existing) { setInvite(existing); setLoading(false); return; }

            try {
                const made = await create();
                if (!cancelled && made) setInvite(made);
            } catch (e: any) {
                if (!cancelled) setError(e?.response?.data?.message ?? 'Could not create an invite link.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    // Deliberately mount-only: re-running on `create`'s identity would fire a
    // POST every time a preset chip changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, server.server_id]);

    /** Explicit "make a new one with these settings" from the options panel. */
    const createWithCurrentSettings = async () => {
        if (working) return;
        setWorking(true);
        setError(null);
        try {
            const made = await create();
            if (made) { setInvite(made); setCopied(false); }
        } catch (e: any) {
            setError(e?.response?.data?.message ?? 'Could not create an invite link.');
        } finally { setWorking(false); }
    };

    const inviteUrl = invite ? `https://cipherline.chat/invite/${invite.code}` : '';

    const copyLink = () => {
        if (!inviteUrl) return;
        writeToClipboard(inviteUrl).then(() => {
            setCopied(true);
            nudges.notify({ kind: 'invite_sent' });
            if (copiedTimer.current) clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 2000);
        }).catch(() => {
            toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' });
        });
    };
    useEffect(() => () => clearTimeout(copiedTimer.current ?? undefined), []);

    const busy = loading || working;

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={460}
            overlayStyle={{ zIndex: 1100 }}
            // Expanding "link settings" adds two chip rows plus both custom
            // fields — measured 739px at 1280x720, which `.mod`'s centred flex
            // pushes off BOTH edges with the top unreachable. The scroll cap
            // replaces the old inline `overflow:'hidden'` (an inline value would
            // have beaten the class): a scroll container still clips to the
            // border radius, and the one child meant to escape — the
            // custom-expiry-unit ClSelect — is portaled to document.body, so
            // the card's overflow cannot clip it.
            cardClassName="mcard--scroll"
            cardStyle={{ padding: 0 }}
        >
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
                <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-cl-lume/15 flex items-center justify-center shrink-0">
                        <UserPlus size={15} className="text-cl-lume" />
                    </span>
                    <div className="min-w-0">
                        <h2 className="font-display font-semibold text-[16px] text-cl-text leading-tight mt-0 mb-0">Invite People</h2>
                        <p className="text-[11px] text-cl-faint leading-tight mt-0.5 truncate">to {server.name}</p>
                    </div>
                </div>
                <ClButton icon size="sm" onClick={handleClose} variant="ghost" tooltip="Close">
                    <X size={15} />
                </ClButton>
            </div>

            <div className="px-5 pb-5 space-y-3">

                {/* The link. Its own row so a long code is never clipped. */}
                <div className="bg-cl-sink border border-cl-border/50 rounded-xl px-3.5 py-3">
                    <span className="flex items-center gap-1.5 text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-1.5">
                        <Link size={11} className="shrink-0" />
                        Invite link
                    </span>
                    <p className="text-[13px] text-cl-text font-mono break-all select-all leading-snug m-0">
                        {busy
                            ? <span className="text-cl-faint italic">Creating a link…</span>
                            : inviteUrl || <span className="text-cl-faint italic">No link available</span>}
                    </p>
                </div>

                <ClButton
                    fullWidth
                    onClick={copyLink}
                    disabled={!inviteUrl || busy}
                    variant={copied ? 'ok' : 'primary'}
                >
                    {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy link</>}
                </ClButton>

                {invite && !busy && (
                    <p className="text-[11.5px] text-cl-faint text-center m-0">{describeInvite(invite)}</p>
                )}

                {error && <p className="text-[12px] text-cl-flash text-center m-0">{error}</p>}

                {/* Settings are secondary — the default is right for almost
                    everyone, so they stay folded away until asked for. */}
                <button
                    type="button"
                    onClick={() => setShowOptions(v => !v)}
                    className="flex items-center gap-1.5 mx-auto text-[11.5px] text-cl-faint hover:text-cl-text"
                >
                    <Settings2 size={12} />
                    {showOptions ? 'Hide link settings' : 'Edit link settings'}
                </button>

                {showOptions && (
                    <div className="space-y-3 pt-1">
                        <div>
                            <p className="text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-1.5">Expire after</p>
                            <div className="flex flex-wrap gap-1.5">
                                {EXPIRY_OPTIONS.map(opt => (
                                    <ClButton
                                        key={String(opt.value)}
                                        chip
                                        variant="ghost"
                                        active={expiryChoice === opt.value}
                                        onClick={() => setExpiryChoice(opt.value)}
                                    >
                                        {opt.value === 'custom' && <Sparkles size={10} />}
                                        {opt.label}
                                    </ClButton>
                                ))}
                            </div>
                            {expiryChoice === 'custom' && (
                                <div className="mt-2">
                                    <ClField note={`Between 1 minute and 30 days.`}>
                                        <div className="flex gap-2 items-center">
                                            <ClInput
                                                type="number"
                                                min={1}
                                                value={String(customExpiryValue)}
                                                onChange={e => setCustomExpiryValue(Number(e.target.value))}
                                                className="flex-1"
                                            />
                                            <ClSelect
                                                value={customExpiryUnit}
                                                onChange={v => setCustomExpiryUnit(v as ExpiryUnit)}
                                                options={EXPIRY_UNIT_OPTIONS}
                                            />
                                        </div>
                                    </ClField>
                                </div>
                            )}
                        </div>

                        <div>
                            <p className="text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-1.5">Max uses</p>
                            <div className="flex flex-wrap gap-1.5">
                                {USE_OPTIONS.map(opt => (
                                    <ClButton
                                        key={String(opt.value)}
                                        chip
                                        variant="ghost"
                                        active={usesChoice === opt.value}
                                        onClick={() => setUsesChoice(opt.value)}
                                    >
                                        {opt.value === 'custom' && <Sparkles size={10} />}
                                        {opt.label}
                                    </ClButton>
                                ))}
                            </div>
                            {usesChoice === 'custom' && (
                                <div className="mt-2">
                                    <ClField note={`Between ${USES_MIN} and ${USES_MAX} uses.`}>
                                        <ClInput
                                            type="number"
                                            min={USES_MIN}
                                            max={USES_MAX}
                                            value={String(customUses)}
                                            onChange={e => setCustomUses(Number(e.target.value))}
                                        />
                                    </ClField>
                                </div>
                            )}
                        </div>

                        <ClButton fullWidth variant="ghost" onClick={createWithCurrentSettings} loading={working} disabled={working}>
                            <RotateCw size={13} /> Create new link with these settings
                        </ClButton>
                    </div>
                )}

                <p className="text-[11px] text-cl-faint text-center m-0 pt-0.5">
                    Past and active invites live in Server Settings → Invites.
                </p>
            </div>
        </ClModal>
    );
};

export default ServerInviteModal;
