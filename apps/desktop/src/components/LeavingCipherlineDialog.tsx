/**
 * "You're leaving Cipherline" — the one dialog every untrusted external link
 * goes through (utils/openExternalLink.ts raises it; utils/externalLinks/
 * leaveGate.ts holds the pending request). Mounted ONCE at the app root.
 *
 * Shows the full destination with the registrable domain in bold, an
 * internationalised host in punycode when it could imitate another site
 * (utils/externalLinks/idnDisplay.ts), a masked link's mismatch in words,
 * and an "Always trust links to <site>" box (per account; Settings → Privacy
 * lists and removes them).
 *
 * Keyboard: Esc cancels (ClModal). Focus starts on Cancel, so an Enter that
 * was meant for the link — or a key held down — can never visit; Tab moves
 * Cancel → Visit → the trust box. The open itself is in confirmLeave, which
 * opens only the request this dialog is showing, and only on a live gesture.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ExternalLink, Mail } from 'lucide-react';
import { ClButton, ClCheckbox, ClModal } from './cl';
import { DialogBody, DialogCallout, DialogFooter, DialogHeader, DialogText } from './dialog/DialogFrame';
import {
    cancelLeave, confirmLeave, getLeaveSnapshot, registerLeaveHost, subscribeLeave, type LeaveRequest,
} from '../utils/externalLinks/leaveGate';
import type { HttpsLinkModel, LinkModel, MailtoLinkModel } from '../utils/externalLinks/describeLink';
import { canPersistTrust } from '../utils/externalLinks/trustedDomains';
import { registrableDomain } from '../utils/externalLinks/registrableDomain';
import '../styles/leaving-dialog.css';

function UrlLine({ m }: { m: HttpsLinkModel }) {
    const p = m.parts;
    return (
        <div className="lcd-url" data-lcd-url="" aria-label={`Destination: ${m.href}`}>
            <span className="lcd-dim">{p.scheme}</span>
            {p.userinfo && <span className="lcd-userinfo">{p.userinfo}@</span>}
            <span className="lcd-host">{p.subdomain}<b data-lcd-site="">{p.site}</b>{p.port}</span>
            <span className="lcd-dim">{p.rest}</span>
        </div>
    );
}

function SpoofNote({ verdict }: { verdict: string }) {
    return (
        <DialogCallout icon={<AlertTriangle size={14} strokeWidth={2.4} />}>
            {verdict === 'invalid'
                ? 'This address is written in a form that can’t be read normally, so it is shown exactly as your browser will use it.'
                : 'This address uses international letters that can imitate another site’s name, so it is shown in its raw form, the way your browser will use it.'}
        </DialogCallout>
    );
}

function HttpsBody({ m }: { m: HttpsLinkModel }) {
    return (
        <>
            <DialogText>This link opens in your browser. Check it goes where you expect:</DialogText>
            <UrlLine m={m} />
            {m.host.verdict === 'unicode' && (
                <div className="lcd-note" data-lcd-idn="">International address. Raw form: <span className="lcd-mono">{m.host.ascii}</span></div>
            )}
            {m.spoofed && <SpoofNote verdict={m.host.verdict} />}
            {m.parts.userinfo && (
                <DialogCallout icon={<AlertTriangle size={14} strokeWidth={2.4} />}>
                    The part before the @ is a user name, not the site. This link goes to <b>{m.parts.site}</b>.
                </DialogCallout>
            )}
        </>
    );
}

function MailtoBody({ m }: { m: MailtoLinkModel }) {
    const list = m.recipients.length ? m.recipients : null;
    return (
        <>
            <DialogText>
                {list ? (
                    <>Open your email app to write to {list.map((r, i) => (
                        <React.Fragment key={i}>{i > 0 && ', '}<b className="lcd-addr">{r.address}</b></React.Fragment>
                    ))}?</>
                ) : (
                    <>Open your email app with a new message? It doesn’t say who it’s to.</>
                )}
            </DialogText>
            <div className="lcd-url" data-lcd-url="" aria-label={`Link: ${m.href}`}><span className="lcd-dim">{m.href}</span></div>
            {m.prefills && <div className="lcd-note">It also fills in a subject or message. Read it before you send.</div>}
            {m.spoofed && <SpoofNote verdict={m.recipients.find(r => r.host.verdict !== 'unicode' && r.host.verdict !== 'ascii')?.host.verdict ?? 'mixed-script'} />}
        </>
    );
}

function LeavingDialog({ req, open }: { req: LeaveRequest; open: boolean }) {
    const m: LinkModel = req.model;
    const [trust, setTrust] = useState(false);
    const cancelSlot = useRef<HTMLSpanElement>(null);
    // Focus lands on Cancel, deterministically: ClModal focuses its first
    // focusable (the trust box) in a frame callback registered by its own
    // (child) effect, so a frame callback registered here runs after it in the
    // same frame; the second frame and the timer cover a slow first frame.
    // (useInitialFocus's lone 80 ms timer can lose that race under load.)
    useEffect(() => {
        if (!open) return;
        const focusCancel = () => { cancelSlot.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus(); };
        let r2 = 0;
        const r1 = requestAnimationFrame(() => { focusCancel(); r2 = requestAnimationFrame(focusCancel); });
        const t = window.setTimeout(focusCancel, 80);
        return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); window.clearTimeout(t); };
    }, [open]);
    const warn = !!m.mismatch || m.spoofed;
    const mail = m.kind === 'mailto';
    const offerTrust = !!m.trustDomain && !!m.trustDomainShown && canPersistTrust();
    const exactOnly = offerTrust && registrableDomain(m.trustDomain!).exactOnly;

    const cancel = () => { cancelLeave(req.id); };
    const visit = () => { confirmLeave(req.id, { trust: offerTrust && trust }); };
    const title = mail ? 'Open your email app?' : 'You’re leaving Cipherline';

    return (
        <ClModal open={open} onClose={cancel} width={500} cardClassName="dlg-card dlg-card--confirm lcd-card" label={title}>
            <DialogHeader
                tone={warn ? 'danger' : 'default'}
                icon={warn ? <AlertTriangle size={18} strokeWidth={2.2} /> : mail ? <Mail size={18} strokeWidth={2.2} /> : <ExternalLink size={18} strokeWidth={2.2} />}
                title={title}
            />
            <DialogBody>
                {m.mismatch && (
                    <div className="lcd-mismatch" role="alert" data-lcd-mismatch="">
                        <AlertTriangle size={15} strokeWidth={2.4} />
                        <span>The link text says <b>{m.mismatch.says}</b> but it goes to <b>{m.mismatch.goesTo}</b>.</span>
                    </div>
                )}
                {m.kind === 'https' ? <HttpsBody m={m} /> : <MailtoBody m={m} />}
                {offerTrust && (
                    <div className="lcd-trust">
                        <ClCheckbox
                            checked={trust}
                            onChange={setTrust}
                            label={<span>Always trust {mail ? 'email links to' : 'links to'} <b>{m.trustDomainShown}</b></span>}
                        />
                        <div className="lcd-trust-help">
                            {exactOnly ? 'Only this exact address. ' : mail ? 'Includes its subdomains. ' : `Includes its subdomains, like www.${m.trustDomainShown}. `}
                            Remove it any time in Settings → Privacy.
                        </div>
                    </div>
                )}
            </DialogBody>
            <DialogFooter>
                <span ref={cancelSlot} className="dlg-focus-slot">
                    <ClButton variant="ghost" size="sm" onClick={cancel}>Cancel</ClButton>
                </span>
                <ClButton variant={warn ? 'danger' : 'primary'} size="sm" onClick={visit} className="lcd-visit">
                    {mail ? 'Open email app' : warn ? 'Visit anyway' : 'Visit site'}
                </ClButton>
            </DialogFooter>
        </ClModal>
    );
}

/** The single host — mount once, at the app root. */
const LeavingCipherlineHost: React.FC = () => {
    useEffect(() => registerLeaveHost(), []);
    const req = useSyncExternalStore(subscribeLeave, getLeaveSnapshot, getLeaveSnapshot);
    // Keep the last request mounted through ClModal's exit transition.
    // Adjusted during render (React's derived-state pattern), not in an effect.
    const [shown, setShown] = useState<LeaveRequest | null>(req);
    if (req && req !== shown) setShown(req);
    if (!shown) return null;
    return <LeavingDialog key={shown.id} req={shown} open={req?.id === shown.id} />;
};

export default LeavingCipherlineHost;
