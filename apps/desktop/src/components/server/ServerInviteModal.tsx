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
 *
 * Link settings apply on their own: change expiry or max uses and, after a short
 * debounce, a new link is made for those settings (Copy and the friend Invite
 * buttons stay disabled until it is ready, so nothing ever sends a link that
 * doesn't match what is on screen). The link this dialog itself made for the
 * previous settings is revoked, unless it was already copied or sent to someone,
 * so tweaking a setting doesn't leave a trail of unused invites. A link the
 * dialog merely REUSED on open is never revoked: it isn't ours.
 *
 * Below the link: recent friends (just added / most recently messaged, worked out
 * on this device) and a friend search, each with an Invite button that DMs the
 * current link through the normal E2EE send path. See InviteFriendsList.
 */

import React, { useState, useEffect, useCallback, useId, useMemo, useRef } from 'react';
import axios from 'axios';
import { Copy, Check, Link, UserPlus, Sparkles, Settings2 } from 'lucide-react';
import { apiUrl } from '../../utils/apiPath';
import type { ServerInfo } from '../../hooks/useServers';
import { ClModal, ClButton, ClInput, ClSelect } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError, useInitialFocus } from '../dialog/DialogFrame';
import { DialogField, DialogStack, DialogLinkButton } from '../dialog/DialogExtras';
import { InviteFriendsList } from './InviteFriendsList';
import { buildInviteFriends, type InviteFriendSource } from '../../utils/inviteFriends';
import { peekRoster, refreshRoster, type Roster } from '../../utils/serverRosterCache';
import '../../styles/dialog-server.css';
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
    /** Accepted friends (the `GET /friends` rows). With `onSendInvite`, turns on the friend list. */
    friends?: readonly InviteFriendSource[];
    /** DM conversations — only used to find each friend's DM for recency. */
    conversations?: readonly { conversation_id?: string | null; id?: string | null; type?: string | null; other_user_id?: string | null; is_self?: boolean | null }[];
    /** Device-local `conversation id -> last message ms` map. Read once, when the dialog opens. */
    lastActivityAt?: Record<string, number>;
    blockedIds?: ReadonlySet<string>;
    myUserId?: string | null;
    /** DM `code` to a friend over the normal E2EE send path. Resolves true when it went out. */
    onSendInvite?: (userId: string, code: string) => Promise<boolean>;
}

/** `null` = never expires; `'custom'` = the custom-value row is active. */
type ExpiryChoice = number | null | 'custom';
/** `null` = unlimited; `'custom'` = the custom-value row is active. */
type UsesChoice = number | null | 'custom';

/** Hours. Discord's default, and the one most people want. */
const DEFAULT_EXPIRY_HOURS = 168;
/** Unlimited. */
const DEFAULT_MAX_USES: UsesChoice = null;

/** Quiet time after the last settings change before a new link is made, so
 *  clicking through chips or typing a custom number makes ONE invite. */
export const REGEN_DEBOUNCE_MS = 700;

const rosterIds = (r: Roster | null): ReadonlySet<string> | null =>
    r ? new Set(r.members.map(m => m.user_id)) : null;

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

export const ServerInviteModal: React.FC<Props> = ({
    server, token, onClose, friends, conversations, lastActivityAt, blockedIds, myUserId, onSendInvite,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const toast = useToast();

    const [invite, setInvite]     = useState<Invite | null>(null);
    const [loading, setLoading]   = useState(true);
    const [working, setWorking]   = useState(false);
    const [copied, setCopied]     = useState(false);
    const [error, setError]       = useState<string | null>(null);
    const [showOptions, setShowOptions] = useState(false);
    const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const copyRef = useRef<HTMLSpanElement>(null);
    const ids = { expiry: useId(), uses: useId(), expiryValue: useId(), usesValue: useId() };

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

    /** What the settings controls say right now, as one comparable key. Always
     *  the latest render's value (read from timers via the ref). */
    const settingsKey = `${resolvedExpirySeconds ?? 'never'}|${resolvedMaxUses ?? 'unlimited'}`;
    const settingsRef = useRef({ key: settingsKey, expirySeconds: resolvedExpirySeconds, maxUses: resolvedMaxUses });
    useEffect(() => { settingsRef.current = { key: settingsKey, expirySeconds: resolvedExpirySeconds, maxUses: resolvedMaxUses }; });

    /** The settings key the link on screen was made for. A link that doesn't
     *  match the current key is stale: Copy / Invite wait for the new one. */
    const [appliedKey, setAppliedKey] = useState<string | null>(null);
    const appliedKeyRef = useRef<string | null>(null);
    /** The invite THIS dialog made (so it may revoke it on a settings change);
     *  null for one it merely reused, which isn't ours to delete. */
    const ownInviteRef = useRef<Invite | null>(null);
    /** True once the current link has been copied or DM'd: it is out in the
     *  world, so a settings change must leave it alone rather than revoke it. */
    const sharedRef = useRef(false);
    const mountedRef = useRef(true);
    const regenChain = useRef<Promise<void>>(Promise.resolve());
    const [regenFailed, setRegenFailed] = useState(false);

    const create = useCallback(async (expirySeconds: number | null, maxUses: number | null): Promise<Invite | null> => {
        if (!token) return null;
        const body: Record<string, number> = {};
        if (maxUses !== null) body.max_uses = maxUses;
        if (expirySeconds !== null) body.expires_in_seconds = expirySeconds;
        const res = await axios.post(
            apiUrl`/servers/${server.server_id}/invites`,
            body,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const made = res.data as Invite;
        sessionInvites.set(server.server_id, made);
        return made;
    }, [token, server.server_id]);

    /** Best-effort revoke of a link this dialog superseded. DELETE is allowed for
     *  the invite's creator with CREATE_INVITE alone. A failure only leaves one
     *  unused invite (which expires on its own), so it is never surfaced. */
    const revoke = useCallback(async (code: string) => {
        if (!token) return;
        try {
            await axios.delete(apiUrl`/servers/${server.server_id}/invites/${code}`, { headers: { Authorization: `Bearer ${token}` } });
        } catch { /* see above */ }
    }, [token, server.server_id]);

    // On open: reuse the newest still-usable invite, or make one. Listing needs
    // MANAGE_SERVER while creating only needs CREATE_INVITE, so a 403 here is a
    // permission level, not a failure — fall straight through to creating.
    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        const baseline = settingsRef.current;
        const settle = () => { appliedKeyRef.current = baseline.key; setAppliedKey(baseline.key); };
        (async () => {
            let existing: Invite | null = null;
            try {
                const res = await axios.get(apiUrl`/servers/${server.server_id}/invites`, {
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
            // A reused link is treated as matching the default settings: only an
            // actual change away from them makes a new one.
            if (existing) { settle(); setInvite(existing); setLoading(false); return; }

            try {
                const made = await create(baseline.expirySeconds, baseline.maxUses);
                if (!cancelled && made) { ownInviteRef.current = made; setInvite(made); }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
            } catch (e: any) {
                if (!cancelled) setError(e?.response?.data?.message ?? 'Could not create an invite link.');
            } finally {
                if (!cancelled) { settle(); setLoading(false); }
            }
        })();
        return () => { cancelled = true; };
    // Deliberately mount-only: re-running on `create`'s identity would fire a
    // POST every time a preset chip changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, server.server_id]);

    useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

    /** Make a link for the CURRENT settings and retire the one it replaces.
     *  Runs one at a time (see enqueueRegen) and always reads the latest
     *  settings, so a burst of changes ends in exactly one new invite. */
    const runRegen = useCallback(async () => {
        const target = settingsRef.current;
        if (target.key === appliedKeyRef.current) return;
        if (mountedRef.current) { setWorking(true); setError(null); setRegenFailed(false); }
        try {
            const made = await create(target.expirySeconds, target.maxUses);
            if (!made) throw new Error('no invite');
            const previous = ownInviteRef.current;
            const previousShared = sharedRef.current;
            ownInviteRef.current = made;
            sharedRef.current = false;
            appliedKeyRef.current = target.key;
            if (mountedRef.current) { setInvite(made); setCopied(false); setAppliedKey(target.key); }
            // Revoke the superseded link only if it was ours and nobody has it.
            if (previous && !previousShared && previous.code !== made.code) void revoke(previous.code);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (e: any) {
            if (mountedRef.current) {
                setRegenFailed(true);
                setError(e?.response?.data?.message ?? 'Could not update the invite link.');
            }
        } finally {
            if (mountedRef.current) setWorking(false);
        }
    }, [create, revoke]);
    const enqueueRegen = useCallback(() => {
        regenChain.current = regenChain.current.then(runRegen, runRegen);
    }, [runRegen]);

    // Settings changed: after a quiet moment, make the matching link. A change
    // back to what the link on screen already matches needs nothing.
    useEffect(() => {
        if (loading || !token) return;
        if (settingsKey === appliedKeyRef.current) return;
        setRegenFailed(false);
        setError(null);
        const t = setTimeout(enqueueRegen, REGEN_DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [settingsKey, loading, token, enqueueRegen]);

    const inviteUrl = invite ? `https://cipherline.chat/invite/${invite.code}` : '';
    /** The link on screen was made for different settings than the controls show. */
    const stale = !loading && appliedKey !== settingsKey;
    /** Nothing may copy or send the link until it matches the settings. */
    const updating = loading || working || (stale && !regenFailed);
    const linkReady = !!inviteUrl && !updating && !stale;

    const copyLink = () => {
        if (!inviteUrl || !linkReady) return;
        sharedRef.current = true;
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

    // ── Friends ──────────────────────────────────────────────────────────────
    const friendsOn = !!onSendInvite;
    // Who is already in the server, when this device knows. Starts from the
    // cached roster (prefetched at boot) and revalidates once; never blocks.
    const [memberIds, setMemberIds] = useState<ReadonlySet<string> | null>(() => (friendsOn ? rosterIds(peekRoster(server.server_id)) : null));
    useEffect(() => {
        if (!friendsOn || !token) return;
        let cancelled = false;
        refreshRoster(server.server_id, token).then(r => { if (!cancelled && r) setMemberIds(rosterIds(r)); }).catch(() => { /* membership marks are a nicety */ });
        return () => { cancelled = true; };
    }, [friendsOn, token, server.server_id]);
    // Ordering is fixed at open: sending an invite moves that DM to "latest
    // activity", and rows jumping under the cursor mid-send would be worse than
    // a list that is a few minutes stale.
    const [activityAtOpen] = useState(lastActivityAt);
    const inviteFriends = useMemo(() => buildInviteFriends({
        friends: friends ?? [], conversations: conversations ?? [], lastActivityAt: activityAtOpen, blockedIds, myUserId,
    }), [friends, conversations, activityAtOpen, blockedIds, myUserId]);
    const sendToFriend = useCallback(async (userId: string, code: string): Promise<boolean> => {
        // Out in the world from the moment it's sent: a settings change during
        // the send must not revoke it. (Set before the await, not after.)
        if (ownInviteRef.current?.code === code) sharedRef.current = true;
        const ok = await onSendInvite!(userId, code);
        if (ok) nudges.notify({ kind: 'invite_sent' });
        return ok;
    }, [onSendInvite]);

    const busy = updating;
    // Enter / initial focus lands on Copy link once there is a link to copy.
    useInitialFocus(copyRef, !!inviteUrl && !busy);

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={460}
            overlayStyle={{ zIndex: 1100 }}
            label="Invite people"
            // The body scrolls (never the card), so the header and the Copy
            // button stay on screen at the app's minimum 1000x720 window even
            // with the link settings open and both custom fields showing.
            // The one child meant to escape the card — the custom-expiry-unit
            // ClSelect — is portaled to document.body.
            cardClassName="dlg-card dlg-card--srv"
        >
            <DialogHeader
                icon={<UserPlus size={18} strokeWidth={2.2} />}
                title="Invite People"
                subtitle={`to ${server.name}`}
            />
            <DialogBody>
                <DialogStack>
                    {/* The link. Its own box so a long code is never clipped. */}
                    <div>
                        <div className="dlg-linkbox">
                            <div className="dlg-linkbox-label"><Link size={12} className="shrink-0" aria-hidden="true" /> Invite link</div>
                            <div className={`dlg-linkbox-url${busy || !linkReady ? ' dlg-linkbox-url--idle' : ''}`} aria-live="polite">
                                {busy ? (loading ? 'Creating a link…' : 'Updating link…') : stale ? 'Link out of date' : inviteUrl || 'No link available'}
                            </div>
                        </div>
                        {invite && linkReady && (
                            <div className="dlg-help" style={{ marginTop: 8 }}>{describeInvite(invite)}</div>
                        )}
                    </div>

                    {/* Settings are secondary — the default is right for almost
                        everyone, so they stay folded away until asked for. */}
                    <div>
                        <DialogLinkButton onClick={() => setShowOptions(v => !v)}>
                            <Settings2 size={13} aria-hidden="true" />
                            {showOptions ? 'Hide link settings' : 'Edit link settings'}
                        </DialogLinkButton>
                    </div>

                    {showOptions && (
                        <DialogStack>
                            <div role="group" aria-labelledby={ids.expiry} className="dlg-stack dlg-stack--tight">
                                <div className="dlg-section" id={ids.expiry}>Expire after</div>
                                <div className="dlg-chips">
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
                                    <DialogField label="Custom expiry" htmlFor={ids.expiryValue} help="Between 1 minute and 30 days.">
                                        <div className="dlg-pair">
                                            <ClInput
                                                id={ids.expiryValue}
                                                type="number"
                                                min={1}
                                                value={String(customExpiryValue)}
                                                onChange={e => setCustomExpiryValue(Number(e.target.value))}
                                            />
                                            <ClSelect
                                                value={customExpiryUnit}
                                                onChange={v => setCustomExpiryUnit(v as ExpiryUnit)}
                                                options={EXPIRY_UNIT_OPTIONS}
                                            />
                                        </div>
                                    </DialogField>
                                )}
                            </div>

                            <div role="group" aria-labelledby={ids.uses} className="dlg-stack dlg-stack--tight">
                                <div className="dlg-section" id={ids.uses}>Max uses</div>
                                <div className="dlg-chips">
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
                                    <DialogField label="Custom uses" htmlFor={ids.usesValue} help={`Between ${USES_MIN} and ${USES_MAX} uses.`}>
                                        <ClInput
                                            id={ids.usesValue}
                                            type="number"
                                            min={USES_MIN}
                                            max={USES_MAX}
                                            value={String(customUses)}
                                            onChange={e => setCustomUses(Number(e.target.value))}
                                        />
                                    </DialogField>
                                )}
                            </div>

                            <div className="dlg-help">Changes update the link automatically.</div>
                        </DialogStack>
                    )}

                    {friendsOn && (
                        <InviteFriendsList
                            friends={inviteFriends}
                            memberIds={memberIds}
                            token={token}
                            code={linkReady ? invite!.code : null}
                            onSend={sendToFriend}
                            loading={friends === undefined}
                        />
                    )}

                    <div className="dlg-help">Past and active invites live in Server Settings → Invites.</div>
                </DialogStack>
            </DialogBody>
            {error && (
                <DialogError>
                    {error}
                    {regenFailed && <> <DialogLinkButton onClick={enqueueRegen}>Try again</DialogLinkButton></>}
                </DialogError>
            )}
            <DialogFooter hint={copied ? 'Copied to your clipboard' : busy ? (loading ? 'Creating a link…' : 'Updating link…') : undefined}>
                <ClButton type="button" variant="ghost" size="sm" onClick={handleClose}>Close</ClButton>
                <span className="dlg-focus-slot" ref={copyRef}>
                    <ClButton
                        size="sm"
                        onClick={copyLink}
                        disabled={!linkReady}
                        variant={copied ? 'ok' : 'primary'}
                    >
                        {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy link</>}
                    </ClButton>
                </span>
            </DialogFooter>
        </ClModal>
    );
};

export default ServerInviteModal;
