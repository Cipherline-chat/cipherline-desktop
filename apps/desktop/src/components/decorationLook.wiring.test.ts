import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every place an avatar decoration is drawn must draw it the way its owner set it
 * up: the per-item `options` (hue, glow...) AND the "Match theme" `tint`, exactly
 * like the profile card. A call site that passes only `decoration` shows the stock
 * teal ring for everyone (the bug behind "my halo colour isn't reflected in the
 * friends list / bottom-left").
 *
 * Satisfied by spreading a `DecorationLook` (`{...decorationLook(row)}`, the
 * utils/decorationLook.ts helper) or by passing BOTH `tint=` and `options=`.
 * Use ALLOWED_WITHOUT_LOOK only for a surface that deliberately draws the stock
 * art (none today); adding to it needs a reason.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');

const ALLOWED_WITHOUT_LOOK: ReadonlyArray<{ file: string; why: string }> = [];

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== 'node_modules') sourceFiles(p, out); continue; }
        if (/\.tsx$/.test(name) && !/\.(test|spec)\.tsx$/.test(name)) out.push(p);
    }
    return out;
}

/** The text of each `<AvatarDecoration ...>` opening tag (braces/strings balanced, so `=>` and `>` inside props do not end it). */
export function openingTags(src: string): string[] {
    const tags: string[] = [];
    let at = src.indexOf('<AvatarDecoration');
    while (at !== -1) {
        let depth = 0;
        let i = at + '<AvatarDecoration'.length;
        let quote: string | null = null;
        for (; i < src.length; i++) {
            const c = src[i];
            if (quote) { if (c === quote) quote = null; continue; }
            if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
            if (c === '{') depth++;
            else if (c === '}') depth--;
            else if (c === '>' && depth === 0) break;
        }
        tags.push(src.slice(at, i + 1));
        at = src.indexOf('<AvatarDecoration', i);
    }
    return tags;
}

export const hasFullLook = (tag: string): boolean => /\{\s*\.\.\./.test(tag) || (/\btint=/.test(tag) && /\boptions=/.test(tag));

describe('every <AvatarDecoration> call site draws the owner\'s look', () => {
    const sites: Array<{ file: string; tag: string }> = [];
    for (const f of sourceFiles(SRC)) {
        if (f.endsWith('/components/ProfileCosmetics.tsx')) continue; // the component itself
        for (const tag of openingTags(readFileSync(f, 'utf8'))) sites.push({ file: relative(SRC, f), tag });
    }

    it('finds the known call sites (positive control: the scan is not vacuous)', () => {
        const files = new Set(sites.map(s => s.file));
        for (const f of ['components/StatusPicker.tsx', 'components/FriendsPane.tsx', 'components/ProfileCardParts.tsx', 'components/profile/ProfilePopoutCard.tsx', 'components/profile/ProfileFullView.tsx', 'components/settings/panes/ProfileCosmeticsSection.tsx']) {
            expect(files.has(f), f).toBe(true);
        }
    });

    it('the check itself rejects a decoration-only call site (negative control)', () => {
        expect(hasFullLook('<AvatarDecoration decoration={f.avatar_decoration} block compact className="w-full h-full">')).toBe(false);
        expect(hasFullLook('<AvatarDecoration decoration={d} tint={t} block>')).toBe(false);
        expect(hasFullLook('<AvatarDecoration decoration={d} options={o} block>')).toBe(false);
        expect(hasFullLook('<AvatarDecoration decoration={d} tint={t} options={o} block>')).toBe(true);
        expect(hasFullLook('<AvatarDecoration {...decorationLook(f)} block>')).toBe(true);
        // `>` inside a prop expression must not end the tag early and hide the later props.
        expect(openingTags('<AvatarDecoration decoration={a > b ? x : y} tint={t} options={o}>kid</AvatarDecoration>')[0]).toContain('options={o}');
    });

    it('passes the colour (options) and the Match-theme tint at every site', () => {
        const allowed = new Set(ALLOWED_WITHOUT_LOOK.map(a => a.file));
        const bad = sites.filter(s => !allowed.has(s.file) && !hasFullLook(s.tag)).map(s => `${s.file}: ${s.tag.replace(/\s+/g, ' ')}`);
        expect(bad).toEqual([]);
    });

    it('the allowlist has no stale entries', () => {
        for (const a of ALLOWED_WITHOUT_LOOK) expect(sites.some(s => s.file === a.file), a.file).toBe(true);
    });

    it('the rail avatar and the Friends rows are fed from the live sources', () => {
        const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
        const dash = read('components/Dashboard.tsx');
        // Own look: from the user record that Settings > Profile refreshes after a save.
        expect(dash).toMatch(/myDecorationLook = React\.useMemo\(\s*\(\) => decorationLook\(\{ avatar_decoration: user\?\.avatar_decoration, profile_theme: user\?\.profile_theme, cosmetic_options: user\?\.cosmetic_options \}\)/);
        expect(dash).toContain('decorationLook={myDecorationLook}');
        // Friends: patched by the realtime event, own record re-read.
        expect(dash).toMatch(/cosmeticsUpdatedEvent[\s\S]*setGlobalFriends[\s\S]*avatar_decoration, profile_theme, cosmetic_options[\s\S]*refreshProfile\(\)/);
        expect(read('hooks/useRealtime.ts')).toContain("msg.event === 'user:cosmetics_updated'");
        expect(read('components/FriendsPane.tsx')).toContain('<AvatarDecoration {...decorationLook(f, peekProfile(f.user_id))}');
    });
});
