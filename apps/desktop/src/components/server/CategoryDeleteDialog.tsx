/**
 * CategoryDeleteDialog — the two-choice delete for a category / sub-category
 * (user request, owner-forwarded 2026-11-17).
 *
 *   ( ) Delete category only            - what Delete always did: nothing
 *                                          inside is deleted, it moves up a
 *                                          level (copy from categoryDeleteConfirm,
 *                                          which says exactly where).
 *   ( ) Delete category and everything  - the category, its sub-categories,
 *       in it                              every channel and divider, with the
 *                                          counts, ONE server transaction.
 *
 * The second choice is irreversible (channel history cannot be recovered),
 * so it needs an explicit second confirmation: a checkbox that repeats the
 * channel count, and a danger button that names it ("Delete 3 channels").
 * The safe choice is preselected, and ClModal's initial focus lands on the
 * first focusable - the "only" radio - so Enter can never confirm the
 * irreversible choice by accident.
 *
 * When "category only" is not possible (a PRIVATE parent with sub-categories:
 * the server refuses it, 409) that choice is disabled with the reason, and the
 * everything-choice is still offered - deleting the contents too exposes
 * nothing.
 *
 * An empty category has nothing to choose between: it is a plain confirm.
 */

import React, { useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ClButton, ClModal, ClCheckbox, ClRadio } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText, DialogCallout } from '../dialog/DialogFrame';
import {
    contentsSummary, deleteEverythingLabel, isEmptyContents,
    type CategoryContents, type CategoryDeleteConfirm,
} from './categoryDelete';

const EXIT_MS = 200;

export type CategoryDeleteChoice = 'only' | 'everything';

interface Props {
    name: string;
    isSub: boolean;
    /** What "delete only" does / why it is blocked (categoryDeleteConfirm). */
    only: CategoryDeleteConfirm;
    contents: Pick<CategoryContents, 'channels' | 'subcategories' | 'dividers'>;
    /** Calls categories say "Calls channels". */
    panel?: 'text' | 'calls';
    onConfirm: (choice: CategoryDeleteChoice) => void;
    onCancel: () => void;
    /** Start on this choice (screenshots / tests); default = the safe one. */
    initialChoice?: CategoryDeleteChoice;
}

export const CategoryDeleteDialog: React.FC<Props> = ({
    name, isSub, only, contents, panel = 'text', onConfirm, onCancel, initialChoice,
}) => {
    const noun = isSub ? 'sub-category' : 'category';
    const onlyBlocked = !!only.confirmDisabled;
    const empty = isEmptyContents(contents);
    const [choice, setChoice] = useState<CategoryDeleteChoice>(initialChoice ?? (onlyBlocked && !empty ? 'everything' : 'only'));
    const [understood, setUnderstood] = useState(false);
    const [closing, setClosing] = useState(false);
    const pending = useRef<(() => void) | null>(null);

    const startClose = (action: () => void) => {
        if (closing) return;
        pending.current = action;
        setClosing(true);
        window.setTimeout(() => { pending.current?.(); }, EXIT_MS);
    };

    const channelWord = panel === 'calls' ? 'Calls channel' : 'channel';
    const everything = choice === 'everything';
    // Nothing irreversible to acknowledge when there are no channels.
    const needsAck = everything && contents.channels > 0;
    const canConfirm = everything ? (!needsAck || understood) : !onlyBlocked;

    // Empty, or "only" blocked and nothing else to offer: the old single confirm.
    if (empty) {
        return (
            <ClModal open={!closing} onClose={() => startClose(onCancel)} cardClassName="dlg-card dlg-card--confirm" label={only.title}>
                <DialogHeader tone="danger" icon={<AlertTriangle size={18} strokeWidth={2.2} />} title={only.confirmDisabled ? only.title : `Delete "${name}"?`} />
                <DialogBody>
                    <DialogText>{onlyBlocked ? only.message : `This ${noun} is empty.`}</DialogText>
                </DialogBody>
                <DialogFooter hint={only.hint}>
                    {onlyBlocked ? (
                        <ClButton size="sm" onClick={() => startClose(onCancel)}>Got it</ClButton>
                    ) : (
                        <>
                            <ClButton variant="ghost" size="sm" onClick={() => startClose(onCancel)}>Cancel</ClButton>
                            <ClButton variant="danger" size="sm" onClick={() => startClose(() => onConfirm('only'))}>Delete</ClButton>
                        </>
                    )}
                </DialogFooter>
            </ClModal>
        );
    }

    const option = (value: CategoryDeleteChoice, title: string, body: React.ReactNode, disabled = false) => (
        <div
            className={`rounded-[10px] border border-solid px-3 py-2.5 transition-colors ${
                choice === value ? (value === 'everything' ? 'border-cl-flash/50 bg-cl-flash/[0.06]' : 'border-cl-lume/40 bg-cl-lume/[0.05]') : 'border-cl-border'
            } ${disabled ? 'opacity-60' : ''}`}
            data-choice={value}
        >
            <ClRadio
                checked={choice === value}
                disabled={disabled}
                onChange={() => { setChoice(value); setUnderstood(false); }}
                label={<span className="text-[13px] font-semibold text-cl-text">{title}</span>}
            />
            <div className="text-[12px] text-cl-muted mt-1 pl-[26px] leading-snug">{body}</div>
        </div>
    );

    const summary = contentsSummary(contents);
    return (
        <ClModal open={!closing} onClose={() => startClose(onCancel)} cardClassName="dlg-card dlg-card--confirm" label={`Delete ${name}`}>
            <DialogHeader tone="danger" icon={<AlertTriangle size={18} strokeWidth={2.2} />} title={`Delete "${name}"?`} subtitle={`Contains ${summary}.`} />
            <DialogBody>
                <div role="radiogroup" aria-label={`How to delete the ${noun}`} className="flex flex-col gap-2">
                    {option(
                        'only',
                        `Delete ${noun} only`,
                        onlyBlocked ? <>{only.message}{only.hint ? <div className="mt-1 text-cl-faint">{only.hint}</div> : null}</> : only.message,
                        onlyBlocked,
                    )}
                    {option(
                        'everything',
                        `Delete ${noun} and everything in it`,
                        <>Permanently deletes {summary}.</>,
                    )}
                </div>
                {everything && contents.channels > 0 && (
                    <div className="mt-3 flex flex-col gap-2.5">
                        <DialogCallout tone="danger">
                            Deleted {channelWord}s can&apos;t be recovered. Their message history, pins and server-saved messages are gone for everyone{panel === 'calls' ? ', and any call in them ends' : ''}.
                        </DialogCallout>
                        <ClCheckbox
                            checked={understood}
                            onChange={setUnderstood}
                            label={<span className="text-[12.5px] text-cl-text">I understand {contents.channels === 1 ? `1 ${channelWord}` : `${contents.channels} ${channelWord}s`} will be deleted for good</span>}
                        />
                    </div>
                )}
            </DialogBody>
            <DialogFooter hint={needsAck && !understood ? 'Tick the box to confirm' : undefined}>
                <ClButton variant="ghost" size="sm" onClick={() => startClose(onCancel)}>Cancel</ClButton>
                <ClButton variant="danger" size="sm" disabled={!canConfirm} onClick={() => { if (canConfirm) startClose(() => onConfirm(choice)); }}>
                    {everything ? deleteEverythingLabel(contents) : `Delete ${noun}`}
                </ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default CategoryDeleteDialog;
