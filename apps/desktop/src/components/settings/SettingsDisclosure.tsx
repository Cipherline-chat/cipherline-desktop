import React, { useContext, useEffect, useId, useRef } from 'react';
import { SettingsDisclosureFlatCards } from './settingsDisclosureFlat';
import { ChevronDown } from 'lucide-react';
import { useDisclosureOpen } from './settingsDisclosureStore';
import { REVEAL_EVENT } from './revealSetting';

/**
 * A "more options" row for Settings: the everyday controls stay visible and
 * the expert / rarely-touched ones fold behind one well-labelled row
 * ("Advanced audio", "Troubleshooting", …). Open state is remembered per
 * disclosure id (settingsDisclosureStore).
 *
 * The body stays MOUNTED while closed (`hidden`, i.e. display:none): every
 * setting inside keeps exactly the lifecycle it had before it was folded away,
 * and the settings search can still find its text and open the row for you
 * (revealSetting dispatches REVEAL_EVENT on this element).
 *
 * `labels` lists search-index labels (settingsSearchIndex.ts) whose visible
 * text differs from the row they point at, so a search for them still lands
 * here.
 *
 * Every row is independent: it stays open until YOU close it, and opening one
 * never folds another (owner, 2026-10-24 - the old accordion `group` is gone).
 */
export interface SettingsDisclosureProps {
    /** Stable id, namespaced by pane: `voice.advanced-audio`. Persisted. */
    id: string;
    title: string;
    /** One plain line saying what is inside, so nobody has to open it to find out. */
    summary?: string;
    icon?: React.ReactNode;
    /** Small trailing note on the closed row (a count, a current value). */
    badge?: React.ReactNode;
    defaultOpen?: boolean;
    /** `card`: a standalone card. `inset` (default): the last row of a card. */
    variant?: 'inset' | 'card';
    labels?: string[];
    /** A control shown beside the header (never inside the toggle button), e.g. an "Add" button. */
    action?: React.ReactNode;
    children: React.ReactNode;
}

export const SettingsDisclosure: React.FC<SettingsDisclosureProps> = ({
    id, title, summary, icon, badge, defaultOpen = false, variant = 'inset', labels, action, children,
}) => {
    const flat = useContext(SettingsDisclosureFlatCards) && variant === 'card';
    const [storedOpen, setOpen] = useDisclosureOpen(id, defaultOpen);
    const open = flat || storedOpen;
    const bodyId = useId();
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const onReveal = () => setOpen(true);
        el.addEventListener(REVEAL_EVENT, onReveal);
        return () => el.removeEventListener(REVEAL_EVENT, onReveal);
    }, [setOpen]);

    if (flat) {
        return (
            <div
                ref={rootRef} className="sd-card sx-disc sx-disc--flat" data-open="true" data-disclosure={id}
                data-labels={labels?.join('|') || undefined}
            >
                {action && <div className="sx-flat-head"><div className="sx-disc-action">{action}</div></div>}
                <div id={bodyId} className="sx-disc-body" role="region" aria-label={title}>{children}</div>
            </div>
        );
    }

    return (
        <div
            ref={rootRef}
            className={`${variant === 'card' ? 'sd-card ' : ''}sx-disc sx-disc--${variant}`}
            data-open={open ? 'true' : 'false'}
            data-disclosure={id}
            data-labels={labels?.join('|') || undefined}
        >
            <div className={action ? 'sx-disc-top' : undefined}>
                <button
                    type="button"
                    className="sx-disc-head"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    onClick={() => setOpen(!open)}
                >
                    {icon && <span className="sx-disc-ico" aria-hidden="true">{icon}</span>}
                    <span className="sx-disc-txt">
                        <b>{title}</b>
                        {summary && <span>{summary}</span>}
                    </span>
                    {badge != null && badge !== false && <span className="sx-disc-badge">{badge}</span>}
                    <ChevronDown size={16} className="sx-disc-chev" aria-hidden="true" />
                </button>
                {action && <div className="sx-disc-action">{action}</div>}
            </div>
            <div id={bodyId} className="sx-disc-body" role="region" aria-label={title} hidden={!open}>
                {children}
            </div>
        </div>
    );
};
