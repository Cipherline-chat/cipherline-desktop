/**
 * Server Settings > Roles: what the Discord import is holding for people
 * (plan D5b). One quiet line ("Discord import: roles waiting for 12 people,
 * given to 3") that opens a list with Revoke per person. Only for managers;
 * nothing is shown when the server was not imported or the API predates it.
 *
 * Unclaimed people have no name here on purpose: the server keeps only a
 * keyed hash of their Discord account, never who they are.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { ClButton, ClModal } from '../../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../../dialog/DialogFrame';
import { DialogStack, DialogNote } from '../../dialog/DialogExtras';
import { ConfirmDialog } from '../../primitives/ConfirmDialog';
import { fetchImportMemberGrants, revokeImportMemberGrants, grantsBarLabel, type ImportGrantPerson } from '../../../utils/importMemberGrants';
import { claimErrorMessage } from '../../../utils/discordClaims';

const STATE_LABEL: Record<string, string> = {
    pending: 'Waiting', applied: 'Given', held: 'Already theirs', revoked: 'Revoked',
};
const KIND_LABEL: Record<string, string> = {
    role: 'Role', channel: 'Channel', category: 'Category', nickname: 'Nickname', ban: 'Ban',
};

export const ImportedRoleGrantsBar: React.FC<{ serverId: string; token: string | null; canManage: boolean }> = ({ serverId, token, canManage }) => {
    const [people, setPeople] = useState<ImportGrantPerson[] | null>(null);
    const [open, setOpen] = useState(false);
    const [confirm, setConfirm] = useState<ImportGrantPerson | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [tick, setTick] = useState(0);
    const load = useCallback(() => setTick(t => t + 1), []);
    useEffect(() => {
        if (!token || !canManage) return;
        let live = true;
        fetchImportMemberGrants(token, serverId)
            .then(p => { if (live) setPeople(p); })
            .catch(() => { if (live) setPeople([]); });
        return () => { live = false; };
    }, [token, canManage, serverId, tick]);

    if (!canManage || !people || people.length === 0) return null;
    const label = grantsBarLabel(people);

    return (
        <>
            <div className="flex items-center gap-2 px-4 py-2 border-b border-cl-border/40 text-[12.5px]" data-import-grants-bar style={{ color: 'var(--cl-muted)' }}>
                <Download size={14} aria-hidden="true" />
                <span className="flex-1 min-w-0 truncate">{label}</span>
                <ClButton size="sm" variant="ghost" onClick={() => setOpen(true)}>Review</ClButton>
            </div>
            <ClModal open={open} onClose={() => setOpen(false)} width={560} label="Discord import: people">
                <DialogHeader icon={<Download size={18} />} title="From the Discord import" subtitle={label} />
                <DialogBody className="dlg-body--scroll">
                    <DialogStack>
                        <DialogNote tone="info">
                            Each person gets what they had on Discord when they join and link the same Discord account. Revoke stops that (and takes back anything already given). People who have not claimed their Discord account have no name here: Cipherline never keeps who they are.
                        </DialogNote>
                        <ul className="m-0 p-0 list-none rounded-lg border divide-y" style={{ borderColor: 'var(--cl-border)' }} data-import-grants-list>
                            {people.map((p, i) => {
                                const live = p.items.filter(it => it.state !== 'revoked');
                                return (
                                    <li key={p.author_id} className="flex items-start gap-3 px-3 py-2" style={{ borderColor: 'var(--cl-border)' }}>
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--cl-bright)' }}>
                                                {p.claimed_user ? `@${p.claimed_user.username}` : `Discord member ${i + 1} (not claimed)`}
                                            </div>
                                            <div className="text-[11.5px] flex flex-wrap gap-x-2" style={{ color: 'var(--cl-faint)' }}>
                                                {p.items.map(it => (
                                                    <span key={it.id}>{KIND_LABEL[it.kind] ?? it.kind}: {it.name ?? '(deleted)'} · {STATE_LABEL[it.state] ?? it.state}</span>
                                                ))}
                                            </div>
                                        </div>
                                        {live.length > 0 && (
                                            <ClButton size="sm" variant="ghost" onClick={() => setConfirm(p)}>Revoke</ClButton>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </DialogStack>
                </DialogBody>
                {error && <DialogError>{error}</DialogError>}
                <DialogFooter>
                    <ClButton onClick={() => setOpen(false)}>Done</ClButton>
                </DialogFooter>
            </ClModal>
            {confirm && (
                <ConfirmDialog
                    title="Revoke what the import holds for this person?"
                    message={confirm.claimed_user
                        ? `@${confirm.claimed_user.username} loses the roles, permissions and nickname the import gave them, and never gets them from the import again.`
                        : 'This person will not get these roles, permissions or nickname when they link their Discord account.'}
                    confirmLabel="Revoke"
                    onConfirm={async () => {
                        const target = confirm;
                        setConfirm(null); setError(null);
                        try { await revokeImportMemberGrants(token!, serverId, target.author_id); load(); }
                        catch (e) { setError(claimErrorMessage(e, 'Could not revoke. Try again.')); }
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </>
    );
};

export default ImportedRoleGrantsBar;
