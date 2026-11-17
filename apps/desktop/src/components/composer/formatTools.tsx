/**
 * The formatting bar's buttons (components/composer/FormatToolbar.tsx), in
 * their groups. Data only, in its own module so the toolbar file exports only
 * components (React Fast Refresh).
 */
import React from 'react';
import {
    Bold, Italic, Underline, Strikethrough, Code, SquareCode, Link, TextQuote, List, ListOrdered,
    EyeOff, Heading1, Heading2, Heading3,
} from 'lucide-react';
import type { FormatAction } from '../../utils/formatting/composerFormat';
import { MARK, isHeadingType } from '../../utils/formatting/richDoc';
import type { ActiveFormats } from './RichComposer';

export interface ToolDef { action: FormatAction; label: string; icon: React.ReactNode }

const I = { size: 16, strokeWidth: 2.3 } as const;

/** Groups, separated by a divider in the bar. Order follows Slack's bar. */
export const TOOL_GROUPS: readonly (readonly ToolDef[])[] = [
    [
        { action: 'bold', label: 'Bold', icon: <Bold {...I} /> },
        { action: 'italic', label: 'Italic', icon: <Italic {...I} /> },
        { action: 'underline', label: 'Underline', icon: <Underline {...I} /> },
        { action: 'strike', label: 'Strikethrough', icon: <Strikethrough {...I} /> },
    ],
    [
        { action: 'link', label: 'Link', icon: <Link {...I} /> },
        { action: 'bullet', label: 'Bulleted list', icon: <List {...I} /> },
        { action: 'number', label: 'Numbered list', icon: <ListOrdered {...I} /> },
        { action: 'quote', label: 'Quote', icon: <TextQuote {...I} /> },
    ],
    [
        { action: 'code', label: 'Code', icon: <Code {...I} /> },
        { action: 'codeBlock', label: 'Code block', icon: <SquareCode {...I} /> },
    ],
    [
        { action: 'spoiler', label: 'Spoiler', icon: <EyeOff {...I} /> },
        // A heading icon (H with its level), never a bare letter. Headings come ONLY
        // from this button (owner, 2026-11-16): nothing typed makes one.
        { action: 'heading', label: 'Heading', icon: <Heading1 {...I} /> },
    ],
];

export const TOOL_HINTS: Partial<Record<FormatAction, string>> = {
    // The heading button's tooltip is just "Heading" (owner, 2026-11-16); its icon shows the
    // level at the caret (H1 / H2 / H3) and each click steps to the next one.
    // The composer's Enter rule (composerFormat enterAction): Enter sends, Shift+Enter continues a list.
    bullet: 'Shift+Enter adds the next item, Enter sends',
    number: 'Shift+Enter adds the next item, Enter sends',
    spoiler: 'Hidden until someone clicks it',
};

/** Whether a button's style is on, from what the box reports at the caret. */
export function isActionActive(action: FormatAction, f: ActiveFormats | null | undefined): boolean {
    if (!f) return false;
    switch (action) {
        case 'bold': return !!(f.marks & MARK.b);
        case 'italic': return !!(f.marks & MARK.i);
        case 'underline': return !!(f.marks & MARK.u);
        case 'strike': return !!(f.marks & MARK.s);
        case 'spoiler': return !!(f.marks & MARK.sp);
        case 'code': return !!(f.marks & MARK.c);
        case 'bullet': return f.block === 'ul';
        case 'number': return f.block === 'ol';
        case 'quote': return f.quote;
        case 'heading': return isHeadingType(f.block);
        case 'codeBlock': return f.block === 'code';
        default: return false;
    }
}

/** The heading button's icon: the level at the caret (H2 / H3), else H1 — what a click starts. */
export function headingIconFor(f: ActiveFormats | null | undefined): React.ReactNode {
    if (f?.block === 'h2') return <Heading2 {...I} />;
    if (f?.block === 'h3') return <Heading3 {...I} />;
    return <Heading1 {...I} />;
}
