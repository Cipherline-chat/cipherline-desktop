import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, HelpCircle } from 'lucide-react';

/**
 * "How to import a template" — a quiet disclosure on the link step of
 * "Import from a Discord template" (DiscordTemplateImport).
 *
 * Inline, not a second modal: the import already lives in a modal, and a
 * guide that replaces the field you are about to paste into is worse than one
 * that opens right under it. Same disclosure pattern (dlg-linkbtn +
 * aria-expanded / aria-controls) as the preview step's "What won't be
 * imported", so it is a real <button>: Tab to it, Enter / Space to toggle.
 *
 * Scrolling: the guide is taller than the space left in a small window, so it
 * relies on the dialog body being the scroll container between the fixed
 * header and footer (the house `dlg-body--scroll` pattern, set by the host).
 * Three things keep all of it reachable:
 *   - opening it scrolls the toggle to the top of the body, so the guide
 *     starts in view instead of below the footer;
 *   - the panel is a focusable region (tabIndex 0), so a keyboard user can
 *     Tab onto it (focus scrolls it into view) and read on with the arrow /
 *     Page keys. Without it the body has no focus stop past the toggle, so
 *     the bottom of the guide was reachable only with a mouse wheel;
 *   - bottom padding on the wrapper, so the last line clears the footer
 *     rule instead of sitting flush against it.
 *
 * Every claim below is derived from the import code, not from memory — keep
 * them in step if that code changes:
 *   - accepted link forms: utils/discordTemplate.ts `looksLikeTemplateLink`
 *     (the API's `parseTemplateLink` in apps/api/.../discord-template.parse.ts
 *     is the real gate; the client copy mirrors it). TEMPLATE_LINK_EXAMPLES
 *     is asserted against `looksLikeTemplateLink` in the test.
 *   - "your device never connects to Discord": the API fetches the template
 *     (discord-template.fetcher.ts); the client only POSTs the link.
 *   - what comes across / what doesn't: discord-template.mapper.ts
 *     (`kindFor`, the `skipped` reasons) and the 500-channel / 250-role caps
 *     in discord-template.parse.ts (MAX_TEMPLATE_CHANNELS / _ROLES).
 *   - name 2–50 characters, owner above every role: DiscordTemplateImport +
 *     the API's import DTO.
 * The Discord-side steps (Server Settings → Server Template → Generate
 * Template; needs Manage Server there) are Discord's own UI.
 */

/** Example inputs shown in step 2. Each must pass `looksLikeTemplateLink`. */
export const TEMPLATE_LINK_EXAMPLES = [
    'discord.new/abc123',
    'https://discord.com/template/abc123',
    'abc123',
] as const;

const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <code className="font-mono text-[11.5px] text-cl-text bg-cl-surface/80 border border-cl-border/60 rounded-md px-1 py-[1px] whitespace-nowrap">
        {children}
    </code>
);

export const TemplateImportGuide: React.FC = () => {
    const [open, setOpen] = useState(false);
    const panelId = useId();
    const wrapRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // `start` (+ scroll-mt-3, so the toggle and its focus ring sit clear
        // of the header) puts the toggle at the top of the scrolling body with the
        // guide under it; when everything already fits nothing moves.
        wrapRef.current?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }, [open]);
    return (
        <div ref={wrapRef} className={open ? "pb-4 scroll-mt-3" : undefined} data-testid="template-guide">
            <button
                type="button"
                className="dlg-linkbtn"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen(o => !o)}
            >
                <HelpCircle size={14} aria-hidden="true" />
                How to import a template
                {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            </button>
            {open && (
                <section
                    id={panelId}
                    role="region"
                    tabIndex={0}
                    aria-label="How to import a template"
                    className="mt-2 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cl-lume bg-cl-sink/60 border border-cl-border p-3.5 text-[12.5px] leading-[1.5] text-cl-muted"
                >
                    <ol className="m-0 p-0 list-none space-y-2.5">
                        <GuideStep n={1} title="Get a template link from Discord">
                            In the Discord server you want to copy, open <b className="text-cl-text">Server Settings → Server Template</b>,
                            give the template a name, choose <b className="text-cl-text">Generate Template</b>, then copy the link.
                            You need the Manage Server permission in that Discord server. A template link someone shared with you works too.
                        </GuideStep>
                        <GuideStep n={2} title="Paste it above">
                            Any of these forms works:{' '}
                            {TEMPLATE_LINK_EXAMPLES.map((ex, i) => (
                                <React.Fragment key={ex}>
                                    {i > 0 && (i === TEMPLATE_LINK_EXAMPLES.length - 1 ? ', or just the code ' : ', ')}
                                    <Code>{ex}</Code>
                                </React.Fragment>
                            ))}.
                        </GuideStep>
                        <GuideStep n={3} title="Preview it">
                            Choose <b className="text-cl-text">Preview template</b>. Cipherline fetches the template for you, so your
                            device never connects to Discord. You’ll see the channels and roles it will create, anything worth a
                            second look, and a list of what won’t be imported.
                        </GuideStep>
                        <GuideStep n={4} title="Name it and create">
                            Change the name if you like (2–50 characters), optionally add an icon, then choose{' '}
                            <b className="text-cl-text">Create server</b>. You’re the owner, above every role.
                        </GuideStep>
                    </ol>

                    <div className="mt-3 pt-3 border-t border-white/[0.06] grid gap-3 sm:grid-cols-2">
                        <div>
                            <h3 className="text-[11px] uppercase tracking-wide text-cl-faint font-semibold m-0 mb-1">Comes across</h3>
                            <div>
                                Categories, text channels, voice channels (as Calls channels), roles with their colors and
                                permissions, channel permission overrides, the server description and default notification setting.
                            </div>
                        </div>
                        <div>
                            <h3 className="text-[11px] uppercase tracking-wide text-cl-faint font-semibold m-0 mb-1">Doesn’t</h3>
                            <div>
                                Messages and members (a template never contains them), member-specific overrides, slowmode,
                                the AFK channel, verification level and role icons. Announcement, forum and media channels become
                                text channels; stage channels become Calls channels.
                            </div>
                        </div>
                    </div>
                    <div className="mt-3 text-[11.5px] text-cl-faint">
                        Templates with more than 500 channels or 250 roles can’t be imported.
                    </div>
                </section>
            )}
        </div>
    );
};

const GuideStep: React.FC<{ n: number; title: string; children: React.ReactNode }> = ({ n, title, children }) => (
    <li className="flex gap-2.5 min-w-0">
        <span
            className="shrink-0 w-5 h-5 mt-[1px] rounded-full flex items-center justify-center text-[11px] font-bold"
            style={{ background: 'var(--cl-lume-tint)', color: 'var(--cl-lume-text)' }}
            aria-hidden="true"
        >
            {n}
        </span>
        <div className="min-w-0">
            <span className="block text-cl-text font-semibold">{title}</span>
            {children}
        </div>
    </li>
);

export default TemplateImportGuide;
