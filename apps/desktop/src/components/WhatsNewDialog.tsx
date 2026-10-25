/**
 * The "What's new in <version>" dialog, and the host that decides when to show it.
 *
 * The decision (first launch after an update, never twice, never on a fresh
 * install) is utils/whatsNew.ts; the notes are CHANGELOG.md's `### What's new`,
 * baked in at build time. This file is the pixels and the wiring.
 *
 * Art: Keys unboxing himself. A box, a lid that lifts, Keys rising out and
 * waving. Transform/opacity animations only (styles/whats-new.css); under
 * reduced motion the box is already open and Keys is already out, nothing moves.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { ClButton, ClModal } from './cl';
import { DialogBody, DialogFooter, DialogHeader, useInitialFocus } from './dialog/DialogFrame';
import { Keys } from './mascot/Keys';
import { useModalExit } from '../hooks/useModalExit';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { openExternalLink } from '../utils/openExternalLink';
import secureLocalStore from '../utils/secureLocalStore';
import { APP_VERSION } from '../constants';
import type { ReleaseNotes } from '../utils/changelogParse';
import {
    CHANGELOG_URL, OPEN_WHATS_NEW_EVENT, decideWhatsNew, formatReleaseDate, notesForVersion, readSeenVersion, writeSeenVersion,
} from '../utils/whatsNew';
import '../styles/whats-new.css';

/** The unboxing: a box, its lid, and Keys coming out of it. */
const UnboxArt: React.FC<{ reduced: boolean }> = ({ reduced }) => {
    // Keys waves once he is out of the box (a controlled rising edge).
    const [wave, setWave] = useState(false);
    useEffect(() => {
        if (reduced) return;
        const t = window.setTimeout(() => setWave(true), 1250);
        return () => window.clearTimeout(t);
    }, [reduced]);
    return (
        <div className={`wn-art${reduced ? ' is-still' : ''}`} aria-hidden="true">
            <div className="wn-box-back" />
            <div className="wn-keys">
                <Keys size={64} interactive={false} waveOnMount={false} wave={wave} idleSway={false} ariaLabel="Keys, out of the box" />
            </div>
            <div className="wn-box-front" />
            <div className="wn-lid" />
        </div>
    );
};

interface DialogProps {
    notes: ReleaseNotes;
    onClose: () => void;
}

export const WhatsNewDialog: React.FC<DialogProps> = ({ notes, onClose }) => {
    const { closing, handleClose } = useModalExit(onClose, 200);
    const reduced = usePrefersReducedMotion();
    const primarySlot = useRef<HTMLDivElement>(null);
    useInitialFocus(primarySlot, !closing);
    const date = formatReleaseDate(notes.date);
    const title = notes.version === 'Unreleased' ? 'What’s new (draft)' : `What’s new in ${notes.version}`;

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={520}
            label={title}
            cardClassName="dlg-card wn-card"
            overlayStyle={{ zIndex: 10001 }}
        >
            <DialogHeader
                icon={<Sparkles size={18} strokeWidth={2.2} />}
                title={title}
                subtitle={date ? `Released ${date}` : undefined}
            />
            <DialogBody>
                <UnboxArt reduced={reduced} />
                <div className="wn-scroll" tabIndex={0} role="region" aria-label="Release notes">
                    {notes.groups.map((g, gi) => (
                        <section key={gi} className="wn-group" aria-label={g.title ?? undefined}>
                            {g.title && <h3 className="wn-gtitle">{g.title}</h3>}
                            <ul className="wn-list">
                                {g.items.map((it, ii) => (
                                    <li key={ii} className="wn-item">
                                        {it.title && <b className="wn-ititle">{it.title}</b>}
                                        <span>{it.text}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            </DialogBody>
            <DialogFooter>
                <ClButton variant="ghost" size="sm" onClick={() => { openExternalLink(CHANGELOG_URL); }}>
                    See all release notes
                </ClButton>
                <div className="dlg-focus-slot" ref={primarySlot}>
                    <ClButton size="sm" onClick={handleClose}>Got it</ClButton>
                </div>
            </DialogFooter>
        </ClModal>
    );
};

/** How long after the app is ready (and calm) before the dialog arrives. */
export const WHATS_NEW_DELAY_MS = 1200;

interface HostProps {
    /** True when it is a good moment: the app is loaded, not locked, not in or answering a call. */
    enabled: boolean;
    /** The running version; the app's own by default (a prop for tests). */
    version?: string;
}

/**
 * Mounted once in the signed-in app. Decides ONCE per session (after the
 * account's store is readable) whether this launch is the first after an
 * update; records the version the moment the dialog opens.
 */
export const WhatsNewHost: React.FC<HostProps> = ({ enabled, version = APP_VERSION }) => {
    const [notes, setNotes] = useState<ReleaseNotes | null>(null);
    const decided = useRef(false);
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;

    useEffect(() => {
        if (!enabled || decided.current) return;
        let cancelled = false;
        let timer: number | undefined;
        void secureLocalStore.whenAccountReady().catch(() => { /* read anyway */ }).then(() => {
            if (cancelled || decided.current) return;
            const d = decideWhatsNew(version, readSeenVersion());
            if (d.action === 'none') { decided.current = true; return; }
            if (d.action === 'record') { decided.current = true; writeSeenVersion(version); return; }
            // Show: after a beat, and only if it is still a good moment then.
            timer = window.setTimeout(() => {
                if (cancelled || !enabledRef.current) return;   // not decided: the next calm moment retries
                decided.current = true;
                writeSeenVersion(version);                       // seen from the moment it opens
                setNotes(d.notes);
            }, WHATS_NEW_DELAY_MS);
        });
        return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
    }, [enabled, version]);

    // On demand: Settings -> Advanced (and, in a dev build only, ?whats-new=<version|draft>).
    useEffect(() => {
        const open = (v?: string) => {
            const n = notesForVersion(v || version);
            if (n) setNotes(n);
        };
        const onOpen = (e: Event) => open((e as CustomEvent<{ version?: string } | undefined>).detail?.version);
        window.addEventListener(OPEN_WHATS_NEW_EVENT, onOpen);
        if (import.meta.env.DEV) {
            const q = new URLSearchParams(window.location.search).get('whats-new');
            if (q) open(q === 'draft' || q === 'preview' ? 'Unreleased' : q);
        }
        return () => window.removeEventListener(OPEN_WHATS_NEW_EVENT, onOpen);
    }, [version]);

    const close = useCallback(() => setNotes(null), []);
    if (!notes) return null;
    return <WhatsNewDialog notes={notes} onClose={close} />;
};

export default WhatsNewHost;
