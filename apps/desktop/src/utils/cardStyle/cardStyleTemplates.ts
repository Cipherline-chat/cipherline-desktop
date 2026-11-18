/**
 * Built-in card-style TEMPLATES ("glow in the deep"), aimed at what styled
 * messages are for: posts that should stand apart in a channel, such as
 * #rules, #announcements, an FAQ, a welcome note, a notice, an event, and the
 * bot-style success / failure cards. Styling is a deliberate, per-message
 * act: a template is only ever applied to the message being written when the
 * user picks it.
 *
 * Each one is an ordinary, already-canonical CardStyle
 * (packages/shared/card-style.ts). Their JSON is listed in
 * docs/message-card-style.md (a test keeps the two in step). Every template
 * stays readable in both built-in themes and avoids the reserved looks
 * (tested). The status templates use THEME colours, so they read right
 * whatever the viewer's theme.
 */
import type { CardStyle } from '@cipherline/shared';

export interface CardStyleTemplate {
    id: string;
    label: string;
    hint: string;
    /** Sample text (composer syntax) for previews. */
    sample: string;
    style: CardStyle;
}

export const CARD_STYLE_TEMPLATES: readonly CardStyleTemplate[] = [
    {
        id: 'rules',
        label: 'Rules',
        hint: 'A gradient frame, a centred title and room to read',
        sample: '# Server rules\n1. **Be kind.** Disagree with ideas, not people.\n2. No spam or self-promo outside #showcase.\n3. Keep it safe for work. ||Yes, that includes memes.||\n\nFull guidelines: [cipherline.chat/guidelines](https://cipherline.chat)',
        style: {
            v: 1,
            background: { type: 'linear', angle: 180, stops: [{ color: '#151d36', at: 0 }, { color: '#0f162b', at: 100 }] },
            border: { width: 2, style: 'solid', gradient: { angle: 135, stops: [{ color: 'theme(accent)', at: 0 }, { color: '#5e8ee0', at: 50 }, { color: '#a78bfa', at: 100 }] } },
            radius: 14,
            padding: 'roomy',
            shadows: [{ x: 0, y: 4, blur: 16, spread: 0, color: '#00000066' }],
            headingAlign: 'center',
        },
    },
    {
        id: 'announcement',
        label: 'Announcement',
        hint: 'Indigo into teal, centred, with a soft glow and a slow drift',
        sample: '[large]v0.2 is here[/large]\nMessage styles, rules cards and faster sync.\nUpdate from Settings → Advanced.',
        style: {
            v: 1,
            background: { type: 'linear', angle: 125, stops: [{ color: '#1d2b64', at: 0 }, { color: '#134e5e', at: 55 }, { color: '#0f3b3a', at: 100 }] },
            border: { width: 1, style: 'solid', color: '#3bead64d' },
            radius: 16,
            padding: 'roomy',
            shadows: [{ x: 0, y: 0, blur: 16, spread: 0, color: 'theme(accent / 22%)' }],
            text: '#f4fffd',
            textGlow: { color: 'theme(accent / 35%)', blur: 6 },
            align: 'center',
            animation: { name: 'drift', seconds: 14 },
        },
    },
    {
        id: 'info',
        label: 'Info / FAQ',
        hint: 'A blue info card with a stripe',
        sample: '**How do I verify someone?**\nOpen their profile → Safety number, and compare it in person or on a call.',
        style: {
            v: 1,
            background: { type: 'solid', color: 'theme(info / 10%)' },
            border: { width: 1, style: 'solid', color: 'theme(info / 35%)' },
            radius: 10,
            padding: 'roomy',
            stripe: { color: 'theme(info)', width: 4 },
        },
    },
    {
        id: 'welcome',
        label: 'Welcome',
        hint: 'Violet dusk, centred, with a passing shimmer',
        sample: '[large]Welcome in 👋[/large]\nSay hi in #introductions and grab your roles in #roles.',
        style: {
            v: 1,
            background: { type: 'linear', angle: 135, stops: [{ color: '#2a1d45', at: 0 }, { color: '#1c2a4a', at: 100 }] },
            border: { width: 1, style: 'solid', color: '#a78bfa59' },
            radius: 18,
            padding: 'roomy',
            shadows: [{ x: 0, y: 0, blur: 14, spread: 0, color: '#a78bfa2e' }],
            align: 'center',
            animation: { name: 'shimmer', seconds: 12 },
        },
    },
    {
        id: 'notice',
        label: 'Warning / Notice',
        hint: 'Amber, with a heavier top rule',
        sample: '**Maintenance tonight** 22:00-22:30 UTC.\nVoice may drop for a minute.',
        style: {
            v: 1,
            background: { type: 'solid', color: 'theme(warning / 9%)' },
            border: { width: [3, 1, 1, 1], style: 'solid', color: ['theme(warning)', 'theme(warning / 35%)', 'theme(warning / 35%)', 'theme(warning / 35%)'] },
            radius: 8,
            padding: 'cozy',
            stripe: { color: 'theme(warning)', width: 4 },
        },
    },
    {
        id: 'event',
        label: 'Event',
        hint: 'A deep stage with a gold double rule',
        sample: '## Game night\nFriday 8 PM CT in #lounge-voice. Bring snacks.',
        style: {
            v: 1,
            background: { type: 'radial', shape: 'ellipse', stops: [{ color: '#2b2350', at: 0 }, { color: '#0f1530', at: 100 }] },
            border: { width: 3, style: 'double', color: '#ffc94d73' },
            radius: 12,
            padding: 'roomy',
            shadows: [{ x: 0, y: 0, blur: 12, spread: 0, color: '#ffc94d24' }],
            headingAlign: 'center',
            letterSpacing: 0.2,
        },
    },
    {
        id: 'success',
        label: 'Success',
        hint: 'Bot-style: a green stripe for "it worked"',
        sample: '✓ Deploy passed · api 76dbcc7 → staging in 3m 12s',
        style: {
            v: 1,
            background: { type: 'solid', color: 'theme(success / 8%)' },
            border: { width: 1, style: 'solid', color: 'theme(success / 30%)' },
            radius: 8,
            padding: 'cozy',
            stripe: { color: 'theme(success)', width: 4 },
        },
    },
    {
        id: 'failure',
        label: 'Failure',
        hint: 'Bot-style: a red stripe for "it broke"',
        sample: '✕ Build failed · desktop #1842\n`apps/desktop` typecheck: 2 errors',
        style: {
            v: 1,
            background: { type: 'solid', color: 'theme(danger / 8%)' },
            border: { width: 1, style: 'solid', color: 'theme(danger / 30%)' },
            radius: 8,
            padding: 'cozy',
            stripe: { color: 'theme(danger)', width: 4 },
        },
    },
];

export function cardTemplateById(id: string): CardStyleTemplate | undefined {
    return CARD_STYLE_TEMPLATES.find(t => t.id === id);
}
