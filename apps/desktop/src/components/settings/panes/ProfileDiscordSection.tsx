import React, { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Link2, Loader2, MessagesSquare } from 'lucide-react';
import { ClButton, ClConfirm, ClToggle } from '../../cl';
import { useToast } from '../../../contexts/ToastContext';
import { SettingsDisclosure } from '../SettingsDisclosure';
import { useDiscordLink } from '../../../hooks/useDiscordLink';
import {
    claimErrorMessage, deleteMyImportedMessages, fetchMyClaims, messageCountLabel, unclaimAuthor,
    type ClaimableAuthor,
} from '../../../utils/discordClaims';
import { ClaimImportDialog, claimSummary } from '../../server/discordImport/ClaimImportDialog';
import { formatLongMonthDayYear } from '../../../utils/messageTimeFormat';
import '../../../styles/settings-ui.css';
import '../../../styles/profile-settings.css';

/**
 * Settings > Profile > Showcase > Discord (Discord import phase 3; plan B6.3
 * entry point b, B8 "Claim UI"): link or unlink the Discord account you prove
 * by signing in on Discord, the "show my imported Discord messages as me
 * automatically" switch (D28, on by default), and every imported author you
 * have claimed or can claim, with Claim / Unclaim / Delete my messages.
 *
 * Nothing about the Discord account is shown (the server keeps only a keyed
 * hash of its number; no name, no avatar). Text only, no Discord logo.
 */
export const ProfileDiscordSection: React.FC<{ token: string | null }> = ({ token }) => {
    const toast = useToast();
    const link = useDiscordLink(token);
    const [claims, setClaims] = useState<ClaimableAuthor[] | null>(null);
    const [claimsError, setClaimsError] = useState<string | null>(null);
    const [confirmUnlink, setConfirmUnlink] = useState(false);
    const [claiming, setClaiming] = useState<ClaimableAuthor | null>(null);
    const [deleting, setDeleting] = useState<ClaimableAuthor | null>(null);
    const [rowBusy, setRowBusy] = useState<string | null>(null);
    const linked = link.status?.linked === true;
    const available = link.status?.available === true;

    const loadClaims = useCallback(async () => {
        if (!token || !linked) { setClaims(null); return; }
        try {
            const r = await fetchMyClaims(token);
            setClaims(r.authors);
            setClaimsError(null);
        } catch (err) {
            setClaimsError(claimErrorMessage(err, 'Could not load your imported messages.'));
        }
    }, [token, linked]);
    useEffect(() => { void loadClaims(); }, [loadClaims, link.linkedTick]);

    const unclaim = async (a: ClaimableAuthor) => {
        if (!token || rowBusy) return;
        setRowBusy(a.author_id);
        try {
            await unclaimAuthor(token, a.server_id, a.author_id);
            await loadClaims();
        } catch (err) {
            toast.push({ kind: 'error', title: 'Not unclaimed', message: claimErrorMessage(err, 'Try again.') });
        } finally {
            setRowBusy(null);
        }
    };
    const doDelete = async () => {
        const a = deleting;
        if (!token || !a) return;
        setRowBusy(a.author_id);
        try {
            const n = await deleteMyImportedMessages(token, a.server_id, a.author_id);
            toast.push({ kind: 'success', title: 'Deleted', message: `${messageCountLabel(n)} deleted from ${a.server_name ?? 'that server'}.` });
            setDeleting(null);
            await loadClaims();
        } catch (err) {
            toast.push({ kind: 'error', title: 'Not deleted', message: claimErrorMessage(err, 'Try again.') });
        } finally {
            setRowBusy(null);
        }
    };

    const movedAt = link.status?.moved_away_at ? Date.parse(link.status.moved_away_at) : NaN;
    const movedOn = Number.isFinite(movedAt) ? formatLongMonthDayYear(new Date(movedAt)) : '';
    const summary = !link.status ? 'Checking…' : !available ? 'Not available yet' : linked ? 'Linked' : 'Not linked';
    return (
        <SettingsDisclosure
            id="profile.discord" variant="card" title="Discord" defaultOpen
            summary={summary}
            labels={['Discord', 'Link Discord', 'Claim imported messages', 'Imported Discord messages', 'Show my imported Discord messages as me automatically']}
        >
            <div data-testid="profile-discord">
                <div className="ps-secs-head" style={{ marginTop: 0 }}>
                    <h4 id="ps-discord-h">Imported Discord messages</h4>
                    <span className="ps-count">{summary}</span>
                </div>
                <p className="su-hint" style={{ marginTop: 0 }}>
                    When a server moves from Discord to Cipherline, your old messages can come with it. Link your Discord account to show them as you.
                    Cipherline keeps only a scrambled form of your Discord account number, never your Discord name, email, servers or password.
                </p>

                {!link.status ? (
                    <div className="ps-steam" aria-live="polite"><Loader2 size={16} className="ps-spin" aria-label="Loading" /></div>
                ) : !available ? (
                    <p className="su-hint" data-testid="discord-unavailable">Linking Discord isn&rsquo;t available on this Cipherline server yet.</p>
                ) : linked ? (
                    <div className="ps-steam" data-testid="discord-linked">
                        <span className="ps-steam-av"><Link2 size={20} aria-hidden="true" /></span>
                        <span className="ps-steam-txt">
                            <b>Discord account linked</b>
                            <span className="ps-steam-ok"><BadgeCheck size={12} strokeWidth={2.5} aria-hidden="true" /> Verified by signing in on Discord</span>
                        </span>
                        <span className="ps-steam-actions">
                            <ClButton size="sm" variant="ghost" onClick={() => setConfirmUnlink(true)}>Unlink</ClButton>
                        </span>
                    </div>
                ) : (
                    <div className="ps-steam ps-steam--connect" data-testid="discord-connect" aria-live="polite">
                        <span className="ps-steam-av"><Link2 size={20} aria-hidden="true" /></span>
                        <span className="ps-steam-txt">
                            {link.waiting ? (
                                <><b>Finish in your browser</b><span>Approve on Discord&rsquo;s page (and answer there if it asks to move the link here), then come back. This updates by itself.</span></>
                            ) : (
                                <><b>Link your Discord account</b><span>You sign in on Discord&rsquo;s own page. Only your account number is checked.</span></>
                            )}
                        </span>
                        <span className="ps-steam-actions">
                            {link.waiting ? (
                                <>
                                    <Loader2 size={16} className="ps-spin" aria-label="Waiting for Discord" />
                                    <ClButton size="sm" variant="ghost" onClick={link.cancel}>Cancel</ClButton>
                                </>
                            ) : (
                                <ClButton size="sm" onClick={() => void link.connect()} loading={link.busy}>Link Discord</ClButton>
                            )}
                        </span>
                    </div>
                )}
                {!linked && available && link.status?.moved_away_at && (
                    <p className="su-hint" role="status" data-testid="discord-moved-away">
                        Your Discord account was moved to another Cipherline account{movedOn ? ` on ${movedOn}` : ''}. Imported messages it claimed no longer show as you.
                        To move it back, link Discord again (a Discord account can move once a day).
                    </p>
                )}
                {link.error && <p className="su-hint" role="alert" style={{ color: 'var(--cl-danger-text)' }}>{link.error}</p>}

                {linked && (
                    <>
                        <div className="su-row">
                            <div className="su-row-text">
                                <span className="su-row-label">Show my imported Discord messages as me automatically</span>
                                <span className="su-row-hint">When a server imports messages you wrote, they show with your name and picture right away, and you get a notice. Off: you are asked first.</span>
                            </div>
                            <div className="su-row-ctl">
                                <ClToggle checked={link.status?.auto_claim !== false} disabled={link.busy} onChange={(v) => void link.setAutoClaim(v)} aria-label="Show my imported Discord messages as me automatically" />
                            </div>
                        </div>

                        <div className="ps-secs-head">
                            <h4>Your imported messages</h4>
                            <span className="ps-count">{claims ? claims.length : ''}</span>
                        </div>
                        {claimsError ? (
                            <p className="su-hint" role="alert">{claimsError}</p>
                        ) : !claims ? (
                            <p className="su-hint">Loading…</p>
                        ) : claims.length === 0 ? (
                            <p className="su-hint" data-testid="discord-claims-empty">None yet. When a server you are in imports messages you wrote on Discord, they show up here.</p>
                        ) : (
                            <ul className="m-0 p-0 list-none flex flex-col gap-2" data-testid="discord-claims">
                                {claims.map(a => {
                                    const s = claimSummary(a);
                                    const state = a.claimed ? (a.claim_source === 'auto' ? 'Shows as you (automatic)' : 'Shows as you') : 'Ready to claim';
                                    return (
                                        <li key={a.author_id} className="ps-steam" data-claim-row>
                                            <span className="ps-steam-av"><MessagesSquare size={18} aria-hidden="true" /></span>
                                            <span className="ps-steam-txt">
                                                <b>{s.server}</b>
                                                <span>{s.count} · imported by {s.importer}{s.date && <> on {s.date}</>} · {state}</span>
                                            </span>
                                            <span className="ps-steam-actions">
                                                {a.claimed ? (
                                                    <>
                                                        <ClButton size="sm" variant="ghost" onClick={() => void unclaim(a)} loading={rowBusy === a.author_id && !deleting} disabled={!!rowBusy}>Unclaim</ClButton>
                                                        {a.message_count > 0 && (
                                                            <ClButton size="sm" variant="danger" onClick={() => setDeleting(a)} disabled={!!rowBusy}>Delete messages</ClButton>
                                                        )}
                                                    </>
                                                ) : (
                                                    <ClButton size="sm" onClick={() => setClaiming(a)} disabled={!!rowBusy}>Review and claim</ClButton>
                                                )}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </>
                )}
            </div>

            <ClConfirm
                open={confirmUnlink}
                onClose={() => setConfirmUnlink(false)}
                onConfirm={async () => { if (await link.unlink()) { setConfirmUnlink(false); setClaims(null); } }}
                title="Unlink Discord?"
                message="Every imported message you claimed goes back to showing the name it had on Discord. You can link again later."
                confirmLabel="Unlink"
                danger
                loading={link.busy}
            />
            <ClConfirm
                open={!!deleting}
                onClose={() => setDeleting(null)}
                onConfirm={() => void doDelete()}
                title="Delete your imported messages?"
                message={deleting ? `${messageCountLabel(deleting.message_count)} you wrote on Discord will be deleted from ${deleting.server_name ?? 'that server'} for everyone. This cannot be undone.` : ''}
                confirmLabel="Delete"
                danger
                loading={!!rowBusy}
            />
            {claiming && (
                <ClaimImportDialog
                    open
                    mode="claim"
                    author={claiming}
                    token={token}
                    onClose={() => setClaiming(null)}
                    onChanged={() => void loadClaims()}
                />
            )}
        </SettingsDisclosure>
    );
};

export default ProfileDiscordSection;
