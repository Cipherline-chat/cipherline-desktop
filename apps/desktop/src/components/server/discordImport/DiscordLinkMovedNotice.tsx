/**
 * "Your Discord link was moved to another Cipherline account" (Discord import
 * phase 3b, the link move). Shown to the account the link LEFT: someone signed
 * in to that Discord account from another Cipherline account and confirmed
 * moving it there. The server tells this account nothing about the other one
 * (no name, no id), so neither does this notice.
 *
 * Driven by the shared link store (useDiscordLink): `moved_away_at` comes from
 * GET /v1/discord/link at sign-in, and live from `discord:link_changed`.
 * "OK" clears it on the server, so it is shown once across all your devices.
 */
import React, { useEffect, useState } from 'react';
import { Unlink } from 'lucide-react';
import { ClButton, ClModal } from '../../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError, DialogText } from '../../dialog/DialogFrame';
import { DialogStack, DialogNote } from '../../dialog/DialogExtras';
import { formatLongMonthDayYear } from '../../../utils/messageTimeFormat';
import type { DiscordLinkHook } from '../../../hooks/useDiscordLink';

const TITLE = 'Your Discord link was moved';

export const DiscordLinkMovedNotice: React.FC<{ link: DiscordLinkHook }> = ({ link }) => {
    const [busy, setBusy] = useState(false);
    const at = link.status && !link.status.linked ? link.status.moved_away_at : null;

    // This notice opens at sign-in, while the rest of the window is still
    // mounting: the message composer focuses itself after the chat loads and
    // would take Enter / typing away from an open modal. Keep focus inside the
    // dialog (OK) while it is open, so the keyboard answers the notice.
    useEffect(() => {
        if (!at) return;
        const pull = () => {
            const d = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${TITLE}"]`);
            if (d && !d.contains(document.activeElement)) d.querySelector<HTMLButtonElement>('button')?.focus();
        };
        const t = window.setTimeout(pull, 50);
        document.addEventListener('focusin', pull);
        return () => { window.clearTimeout(t); document.removeEventListener('focusin', pull); };
    }, [at]);

    if (!at) return null;
    const t = Date.parse(at);
    const when = Number.isFinite(t) ? formatLongMonthDayYear(new Date(t)) : '';

    const ok = async () => {
        if (busy) return;
        setBusy(true);
        try { await link.ackMoved(); } finally { setBusy(false); }
    };

    return (
        <ClModal open onClose={() => void ok()} width={460} label={TITLE}>
            <DialogHeader icon={<Unlink size={18} strokeWidth={2.2} />} title={TITLE} subtitle={when ? `On ${when}` : undefined} />
            <DialogBody>
                <DialogStack>
                    <DialogText>
                        The Discord account that was linked here is now linked to <b>another Cipherline account</b>. Someone signed in to
                        that Discord account there and chose to move it.
                    </DialogText>
                    <DialogText>
                        Imported Discord messages it claimed no longer show as you.
                    </DialogText>
                    <DialogNote tone="info">
                        Not you? Change your Discord password, then link Discord again from Settings, Profile, Discord to move it back.
                        A Discord account can move once a day.
                    </DialogNote>
                </DialogStack>
            </DialogBody>
            {link.error && <DialogError>{link.error}</DialogError>}
            <DialogFooter>
                <ClButton onClick={() => void ok()} loading={busy} autoFocus>OK</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default DiscordLinkMovedNotice;
