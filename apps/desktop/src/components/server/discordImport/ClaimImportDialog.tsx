/**
 * The confirm step of claiming imported messages (Discord import phase 3;
 * plan B6.3 and B8 "Claim UI"), and the auto-map notice, in one dialog:
 *
 *   mode 'claim'  "N messages in <server>, imported by @admin on <date>, will
 *                 show as you." Review them · Cancel · Claim
 *   mode 'auto'   "Your Discord messages imported into <server> now show as
 *                 you." Review · Report · Unclaim · OK   (D28 notice)
 *
 * "Review them" lists where the messages are, in channels you can see, with
 * a Show button that opens the channel at the newest one (the rows decrypt
 * through the normal history path). Nothing here decides ownership: the
 * server checks your Discord proof on every claim.
 */
import { formatMemberSince } from '../../../utils/memberSince';
import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Flag, Hash, Shield, UserCheck } from 'lucide-react';
import { ClButton, ClModal } from '../../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError, DialogText } from '../../dialog/DialogFrame';
import { DialogStack, DialogNote } from '../../dialog/DialogExtras';
import { formatLongMonthDayYear } from '../../../utils/messageTimeFormat';
import {
    claimAuthor, claimContentsLabel, claimErrorMessage, hasGrants, importerLabel, messageCountLabel, reportImportedAuthor, reviewAuthor, unclaimAuthor,
    type ClaimableAuthor, type ImportedGrants, type ReviewChannel,
} from '../../../utils/discordClaims';

export type ClaimDialogMode = 'claim' | 'auto';

const dateOf = (iso: string | null | undefined): string => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? formatLongMonthDayYear(new Date(t)) : '';
};

export function claimSummary(a: ClaimableAuthor): { count: string; server: string; importer: string; date: string } {
    const latest = a.imports[0];
    // A person with roles but no imported messages: the structure import is
    // the only "import" there is, so its importer and date are shown.
    const viaGrants = !latest && a.grants ? { import_id: '', imported_at: a.grants.granted_at ?? '', importer: a.grants.granted_by } : undefined;
    return {
        count: claimContentsLabel(a),
        server: a.server_name || 'this server',
        importer: importerLabel(latest ?? viaGrants),
        date: dateOf((latest ?? viaGrants)?.imported_at),
    };
}

const roleColor = (c: number): string => (c >= 0 && c <= 0xffffff ? `#${c.toString(16).padStart(6, '0')}` : 'var(--cl-faint)');

/**
 * "What you'll get": every role by name (Administrator called out), the
 * per-channel permissions, the nickname, and a ban if the Discord server had
 * banned this account. Shown BEFORE Claim (owner rule).
 */
export const ClaimGrantsList: React.FC<{ grants: ImportedGrants; mode: ClaimDialogMode; member: boolean; server: string }> = ({ grants, mode, member, server }) => {
    const given = mode === 'auto' && grants.given;
    const admin = grants.roles.some(r => r.administrator);
    return (
        <div data-claim-grants>
            <div className="text-[12px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--cl-faint)' }}>
                {given ? 'You now have' : 'You will also get'}
            </div>
            {grants.roles.length > 0 && (
                <ul className="m-0 p-0 list-none flex flex-wrap gap-1.5" aria-label="Roles" data-claim-roles>
                    {grants.roles.map(r => (
                        <li key={r.role_id} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12.5px] font-semibold"
                            style={{ borderColor: 'var(--cl-border)', color: 'var(--cl-bright)' }}>
                            <span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: roleColor(r.color) }} />
                            {r.name}
                            {r.administrator && <Shield size={12} aria-label="Administrator" style={{ color: 'var(--cl-flash-text)' }} />}
                        </li>
                    ))}
                </ul>
            )}
            <ul className="m-0 mt-1.5 pl-4 text-[12.5px]" style={{ color: 'var(--cl-muted)' }}>
                {grants.overrides > 0 && <li>Your own permissions in {grants.overrides} channel{grants.overrides === 1 ? '' : 's'} or categor{grants.overrides === 1 ? 'y' : 'ies'}</li>}
                {grants.nickname && <li>The nickname <b style={{ color: 'var(--cl-bright)' }}>{grants.nickname}</b> (if you have none in {server})</li>}
                {grants.member_since && <li data-claim-member-since>Member since <b style={{ color: 'var(--cl-bright)' }}>{formatMemberSince(grants.member_since)}</b> on your profile in {server}</li>}
            </ul>
            {admin && (
                <DialogNote tone="warn">
                    <b>Administrator</b> gives full control of {server}, exactly as on Discord.
                </DialogNote>
            )}
            {grants.banned && (
                <DialogNote tone="danger">
                    This Discord account was <b>banned</b> from the original server, so it is banned from {server} too.
                </DialogNote>
            )}
            {!member && !grants.banned && (grants.roles.length > 0 || grants.overrides > 0 || grants.nickname || grants.member_since) && (
                <div className="mt-1.5 text-[12px]" style={{ color: 'var(--cl-faint)' }}>You get them as soon as you join {server}.</div>
            )}
        </div>
    );
};

export const ClaimImportDialog: React.FC<{
    open: boolean;
    mode: ClaimDialogMode;
    author: ClaimableAuthor;
    token: string | null;
    /** "#general" for a channel id of this server; null when unknown to this device. */
    channelName?: (channelId: string) => string | null;
    /** Open a channel at a message (absent = Review lists without Show). */
    onOpenMessage?: (serverId: string, channelId: string, messageId: string) => void;
    onClose: () => void;
    /** After a successful claim / unclaim / report. */
    onChanged?: (next: { claimed: boolean }) => void;
}> = ({ open, mode, author, token, channelName, onOpenMessage, onClose, onChanged }) => {
    const [busy, setBusy] = useState<null | 'claim' | 'unclaim' | 'report'>(null);
    const [error, setError] = useState<string | null>(null);
    const [reviewOpen, setReviewOpen] = useState(false);
    const [review, setReview] = useState<ReviewChannel[] | null>(null);
    const [reviewError, setReviewError] = useState<string | null>(null);
    const [reported, setReported] = useState(false);
    const s = claimSummary(author);

    useEffect(() => {
        if (!open) { setReviewOpen(false); setReview(null); setError(null); setReviewError(null); setReported(false); }
    }, [open]);

    useEffect(() => {
        if (!reviewOpen || review || !token) return;
        let live = true;
        reviewAuthor(token, author.server_id, author.author_id)
            .then(r => { if (live) setReview(r); })
            .catch(err => { if (live) setReviewError(claimErrorMessage(err, 'Could not load the list. Try again.')); });
        return () => { live = false; };
    }, [reviewOpen, review, token, author.server_id, author.author_id]);

    const run = async (kind: 'claim' | 'unclaim' | 'report') => {
        if (!token || busy) return;
        setBusy(kind); setError(null);
        try {
            if (kind === 'claim') { await claimAuthor(token, author.server_id, author.author_id); onChanged?.({ claimed: true }); onClose(); }
            if (kind === 'unclaim') { await unclaimAuthor(token, author.server_id, author.author_id); onChanged?.({ claimed: false }); onClose(); }
            if (kind === 'report') {
                const r = await reportImportedAuthor(token, author.server_id, author.author_id);
                setReported(true);
                onChanged?.({ claimed: false });
                if (!r.reported) setError('Unclaimed. The person who imported these has left Cipherline, so there is no one to report.');
            }
        } catch (err) {
            setError(claimErrorMessage(err, kind === 'claim' ? 'Could not claim these messages. Try again.' : 'That did not work. Try again.'));
        } finally {
            setBusy(null);
        }
    };

    const onlyGrants = author.message_count === 0 && hasGrants(author);
    const title = onlyGrants
        ? (mode === 'auto' ? 'Your Discord roles are yours here' : 'Claim your Discord roles?')
        : (mode === 'auto' ? 'Your Discord messages now show as you' : 'Show these messages as you?');
    return (
        <ClModal open={open} onClose={onClose} width={480} label={title}>
            <DialogHeader icon={<UserCheck size={18} strokeWidth={2.2} />} title={title} subtitle={s.server} />
            <DialogBody className="dlg-body--scroll">
                <DialogStack>
                    <DialogText>
                        {onlyGrants ? (
                            mode === 'auto'
                                ? <><b>{s.server}</b> was imported from a Discord server by <b>{s.importer}</b>{s.date && <> on {s.date}</>}. Your linked Discord account was a member there, so what you had comes with you.</>
                                : <><b>{s.server}</b> was imported from a Discord server by <b>{s.importer}</b>{s.date && <> on {s.date}</>}. Claim your Discord account there to get what you had. Everyone in that server will see this account was yours.</>
                        ) : mode === 'auto' ? (
                            <><b>{messageCountLabel(author.message_count)}</b> you wrote on Discord, imported into <b>{s.server}</b> by <b>{s.importer}</b>{s.date && <> on {s.date}</>}, now show with your name, picture and profile, because your linked Discord account matches.</>
                        ) : (
                            <><b>{messageCountLabel(author.message_count)}</b> in <b>{s.server}</b>, imported by <b>{s.importer}</b>{s.date && <> on {s.date}</>}, will show as you: your name, picture and profile, to everyone in that server.</>
                        )}
                    </DialogText>
                    {author.grants && hasGrants(author) && (
                        <ClaimGrantsList grants={author.grants} mode={mode} member={author.member} server={s.server} />
                    )}
                    {author.message_count > 0 && <div>
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 text-[12.5px] font-semibold bg-transparent border-0 p-0 cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--cl-glow)]"
                            style={{ color: 'var(--cl-glow-text)' }}
                            aria-expanded={reviewOpen}
                            aria-controls="claim-review-list"
                            data-claim-review-toggle
                            onClick={() => setReviewOpen(v => !v)}
                        >
                            {reviewOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                            Review them
                        </button>
                        {reviewOpen && (
                            <div id="claim-review-list" className="mt-2" aria-live="polite">
                                {reviewError ? (
                                    <div className="text-[12.5px]" style={{ color: 'var(--cl-danger-text)' }}>{reviewError}</div>
                                ) : !review ? (
                                    <div className="text-[12.5px]" style={{ color: 'var(--cl-faint)' }}>Loading…</div>
                                ) : review.length === 0 ? (
                                    <div className="text-[12.5px]" style={{ color: 'var(--cl-faint)' }}>None of them are in channels you can see.</div>
                                ) : (
                                    <ul className="m-0 p-0 list-none rounded-lg border divide-y" style={{ borderColor: 'var(--cl-border)' }} data-claim-review>
                                        {review.map(c => {
                                            const name = channelName?.(c.channel_id) ?? null;
                                            const range = [dateOf(c.first_at), dateOf(c.last_at)].filter(Boolean);
                                            const span = range.length === 2 && range[0] !== range[1] ? `${range[0]} to ${range[1]}` : range[0] ?? '';
                                            return (
                                                <li key={c.channel_id} className="flex items-center gap-2 px-3 py-2" style={{ borderColor: 'var(--cl-border)' }}>
                                                    <Hash size={14} aria-hidden="true" style={{ color: 'var(--cl-faint)' }} />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--cl-bright)' }}>{name ?? 'A channel'}</div>
                                                        <div className="text-[11.5px] truncate" style={{ color: 'var(--cl-faint)' }}>
                                                            {messageCountLabel(c.count)}{span && <> · copied from messages sent {span}</>}
                                                        </div>
                                                    </div>
                                                    {onOpenMessage && c.message_ids[0] && (
                                                        <ClButton size="sm" variant="ghost" onClick={() => { onOpenMessage(author.server_id, c.channel_id, c.message_ids[0]); onClose(); }}>
                                                            Show
                                                        </ClButton>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </div>
                        )}
                    </div>}
                    <DialogNote tone="info">
                        {mode === 'auto'
                            ? <>Not yours? <b>Report</b> unclaims them and tells our team. You can turn automatic claiming off in Settings, Profile, Discord.</>
                            : <>You can undo this any time in Settings, Profile, Discord, and you can delete these messages there too.</>}
                    </DialogNote>
                    {reported && !error && (
                        <DialogNote tone="ok" role="status">Unclaimed and reported. Our team will look at this import.</DialogNote>
                    )}
                </DialogStack>
            </DialogBody>
            {error && <DialogError>{error}</DialogError>}
            {mode === 'auto' ? (
                <DialogFooter>
                    {!reported && (
                        <>
                            <ClButton variant="ghost" onClick={() => void run('report')} loading={busy === 'report'} disabled={!!busy}><Flag size={14} aria-hidden="true" /> Report</ClButton>
                            <ClButton variant="ghost" onClick={() => void run('unclaim')} loading={busy === 'unclaim'} disabled={!!busy}>Unclaim</ClButton>
                        </>
                    )}
                    <ClButton onClick={onClose} disabled={!!busy}>OK</ClButton>
                </DialogFooter>
            ) : (
                <DialogFooter>
                    <ClButton variant="ghost" onClick={onClose} disabled={!!busy}>Cancel</ClButton>
                    <ClButton onClick={() => void run('claim')} loading={busy === 'claim'} disabled={!!busy || !token}>
                        {author.message_count > 0 ? `Claim ${messageCountLabel(author.message_count)}` : 'Claim'}
                    </ClButton>
                </DialogFooter>
            )}
        </ClModal>
    );
};

export default ClaimImportDialog;
