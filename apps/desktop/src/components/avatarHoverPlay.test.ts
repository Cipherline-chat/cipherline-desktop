import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickDisplayUrl } from '../utils/animatedImage';
import { enterAuthorName, leaveAuthorName, _peekAuthorNameHover } from '../utils/authorNameHover';

/**
 * Hover-to-play for animated avatars, driven by a PARENT (member row / author
 * name). The vitest env is 'node' with no render harness, so the component
 * layer is pinned by source guards (same idiom as EncryptedAvatar.brokenImage
 * .test.ts) and the decision it feeds is exercised through the real helper.
 */

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const avatar = read('EncryptedAvatar.tsx');
const panel = read('server/ServerContextPanel.tsx');
const chat = read('ChatPane.tsx');
const dash = read('Dashboard.tsx');

const FULL = 'blob:full-gif';
const STILL = 'blob:first-frame';

describe('EncryptedAvatar `playing` prop', () => {
    it('is OR-ed into the still gate next to animate and its own hover', () => {
        // Being the focused window is the gate's own rule (utils/animatedImage.ts).
        expect(avatar).toMatch(/useStillGate\(fullUrl, fullMime, animate \|\| hovered \|\| playing \|\| talking\)/);
        expect(avatar).toMatch(/playing\?: boolean/);
        expect(avatar).toMatch(/playing = false,/);
    });

    it('does not change what `animate` means or the hover / prefetch / boing paths', () => {
        // the image's own hover handlers are still gated on `!animate`, untouched by `playing`
        expect(avatar).toContain('const hoverHandlers = canMove');
        expect(avatar).toContain('scheduleProfilePrefetch');
        expect(avatar).toContain('enc-av-boing');
        expect(avatar).not.toMatch(/const hoverHandlers = canMove && !playing/);
    });

    it('shows the first frame when not playing and the full animated URL when playing', () => {
        // the gate input is `animate || hovered || playing`
        const gate = (animate: boolean, hovered: boolean, playing: boolean) => animate || hovered || playing;
        expect(pickDisplayUrl(FULL, 'image/gif', gate(false, false, false), STILL)).toBe(STILL);
        expect(pickDisplayUrl(FULL, 'image/gif', gate(false, false, true), STILL)).toBe(FULL);
        expect(pickDisplayUrl(FULL, 'image/webp', gate(false, false, true), STILL)).toBe(FULL);
        // hover alone still plays, and animate keeps playing without it
        expect(pickDisplayUrl(FULL, 'image/gif', gate(false, true, false), STILL)).toBe(FULL);
        expect(pickDisplayUrl(FULL, 'image/gif', gate(true, false, false), STILL)).toBe(FULL);
    });

    it('leaves static images alone either way', () => {
        expect(pickDisplayUrl('blob:png', 'image/png', false, null)).toBe('blob:png');
        expect(pickDisplayUrl('blob:png', 'image/png', true, null)).toBe('blob:png');
    });
});

describe('server member rows pass hover state to the avatar', () => {
    it('renders the member row, the in-call row and the voice-channel row through HoverPlayRow', () => {
        expect(panel).toContain("import { HoverPlayRow } from './HoverPlayRow'");
        expect((panel.match(/<HoverPlayRow\b/g) ?? []).length).toBe(3);
        expect((panel.match(/<\/HoverPlayRow>/g) ?? []).length).toBe(3);
        expect((panel.match(/\{\(playing\) => \(<>/g) ?? []).length).toBe(3);
    });

    it('hands `playing` to the avatar in each of them (the drag overlay chip stays static)', () => {
        expect((panel.match(/playing=\{playing\}/g) ?? []).length).toBe(3);
        const memberTile = panel.slice(panel.indexOf('const renderMemberTile'), panel.indexOf('// ── Huddle channel delete'));
        expect(memberTile).toContain('<HoverPlayRow');
        expect(memberTile).toContain('playing={playing}');
    });

    it('tracks hover per row, not in the panel', () => {
        const row = read('server/HoverPlayRow.tsx');
        expect(row).toContain('onMouseEnter');
        expect(row).toContain('onMouseLeave');
        expect(row).toContain('onFocus');
        expect(row).toContain('onBlur');
        expect(row).toContain('contains(e.relatedTarget');
        expect(row).toContain('hover || focus');
        // module-level component: a component declared in the panel body would remount every row
        expect(panel).not.toMatch(/const HoverPlayRow\b/);
    });
});

describe('group chat right-hand member list passes hover state to the avatar', () => {
    it('renders each member row through HoverPlayRow and plays that member\'s avatar', () => {
        expect(dash).toContain("import { HoverPlayRow } from './server/HoverPlayRow'");
        const start = dash.indexOf('<GroupMembersHeading');
        const end = dash.indexOf('end detailsPanelTopRef wrapper');
        const list = dash.slice(start, end);
        expect(list).toContain('<HoverPlayRow');
        expect(list).toContain('</HoverPlayRow>');
        expect(list).toContain('{(playing) => (<>');
        expect(list).toMatch(/<EncryptedAvatar[^>]*playing=\{playing\}/);
    });
});

describe('chat author name plays the author avatar', () => {
    it('renders the message avatar through AuthorHoverAvatar keyed by message id', () => {
        expect(chat).toContain("import { AuthorHoverAvatar } from './AuthorHoverAvatar'");
        expect(chat).toMatch(/<AuthorHoverAvatar[\s\S]{0,200}hoverKey=\{msg\.id\}/);
    });

    it('reports name enter / leave under the same message id, on the name span only', () => {
        expect(chat).toContain('onMouseEnter={() => enterAuthorName(msg.id)}');
        expect(chat).toContain('onMouseLeave={() => leaveAuthorName(msg.id)}');
        expect((chat.match(/enterAuthorName\(/g) ?? []).length).toBe(1);
    });

    it('AuthorHoverAvatar forwards the hover to EncryptedAvatar `playing`', () => {
        const wrap = read('AuthorHoverAvatar.tsx');
        expect(wrap).toContain('useAuthorNameHovered(hoverKey)');
        expect(wrap).toMatch(/playing=\{!!playing \|\| nameHovered\}/);
    });
});

describe('authorNameHover store', () => {
    beforeEach(() => { leaveAuthorName(_peekAuthorNameHover() ?? ''); });

    it('tracks the hovered message and clears on leave', () => {
        enterAuthorName('m1');
        expect(_peekAuthorNameHover()).toBe('m1');
        leaveAuthorName('m1');
        expect(_peekAuthorNameHover()).toBeNull();
    });

    it('a late leave from the previous name does not clear the new one', () => {
        enterAuthorName('m1');
        enterAuthorName('m2');
        leaveAuthorName('m1');
        expect(_peekAuthorNameHover()).toBe('m2');
    });
});
