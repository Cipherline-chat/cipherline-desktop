import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

describe('profile customisation wiring', () => {
    it('display names are gone from the profile surfaces', () => {
        for (const f of ['./FriendsPane.tsx', './ProfileModal.tsx', './settings/panes/ProfilePane.tsx', './settings/panes/ProfileVisibilitySection.tsx', './settings/panes/ProfileCosmeticsSection.tsx', '../utils/profileCache.ts']) {
            expect(read(f)).not.toMatch(/display_name|displayName state|setDisplayName/);
        }
    });
    it('decorations render on the card, the Friends rows and the rail avatar', () => {
        expect(read('./ProfileCardParts.tsx')).toContain('<AvatarDecoration');
        expect(read('./profile/ProfilePopoutCard.tsx')).toContain('<AvatarDecoration decoration={data?.decoration}');
        expect(read('./profile/ProfileFullView.tsx')).toContain('<AvatarDecoration decoration={data?.decoration}');
        expect(read('./ProfileModal.tsx')).toContain('decoration: profile.avatar_decoration');
        expect(read('./FriendsPane.tsx')).toContain('decoration={f.avatar_decoration}');
        expect(read('./StatusPicker.tsx')).toContain('<AvatarDecoration');
        expect(read('./Dashboard.tsx')).toContain('avatarDecoration={user?.avatar_decoration ?? null}');
    });
    it('the effect and the theme belong to the card only', () => {
        // Both profile surfaces loop the effect (it keeps playing while the window is in front).
        const card = read('./profile/ProfilePopoutCard.tsx');
        expect(card).toContain('<ProfileEffect effect={data?.effect} tint={tint} options={data?.effectOptions} loop={loop} />');
        expect(card).toContain('themeCardStyle(theme)');
        const fullView = read('./profile/ProfileFullView.tsx');
        expect(fullView).toContain('<ProfileEffect effect={data?.effect} tint={tint} options={data?.effectOptions} loop />');
        expect(fullView).toContain('themeCardStyle(theme)');
        const modal = read('./ProfileModal.tsx');
        expect(modal).toContain('effect: profile.profile_effect');
        expect(modal).toContain('theme: readTheme(profile.profile_theme)');
        // The Settings preview is the same card component (the preview popover), not a copy of it.
        expect(read('./settings/panes/ProfilePreviewCard.tsx')).toContain('<ProfilePopoutCard');
        expect(read('./FriendsPane.tsx')).not.toMatch(/ProfileEffect|themeCardStyle/);
    });
    it('animation plays on the card and in settings; lists default to the first frame', () => {
        for (const f of ['./profile/ProfilePopoutCard.tsx', './profile/ProfileFullView.tsx']) {
            const card = read(f);
            expect(card).toMatch(/<EncryptedAvatar[^>]*\banimate\b[^>]*\/>/);
            expect(card).toMatch(/<Banner[\s\S]*?animate/);
        }
        expect(read('./FriendsPane.tsx')).not.toMatch(/<EncryptedAvatar[^>]*\banimate(?![-\w])/);
        expect(read('./EncryptedAvatar.tsx')).toMatch(/animate = false/);
        expect(read('./Banner.tsx')).toMatch(/animate = false/);
    });
    it('animation is not gated on Pro anywhere', () => {
        for (const f of ['./EncryptedAvatar.tsx', './Banner.tsx', '../utils/animatedImage.ts', './settings/panes/AnimatedImageDialog.tsx', './settings/panes/ProfileCosmeticsSection.tsx', './settings/panes/ProfileExtrasSection.tsx']) {
            expect(read(f)).not.toMatch(/is_pro|isPro|isPaid|canPublishVideo/);
        }
    });
    it('an animated pick skips the cropper and uploads with its own MIME type', () => {
        const pane = read('./settings/panes/ProfilePane.tsx');
        expect(pane).toContain('isAnimatedFile(result.file)');
        expect(pane).toContain('<AnimatedImageDialog');
        expect(pane).toMatch(/avatarFile\.type \|\| 'image\/jpeg'/);
        expect(pane).toMatch(/bannerFile\.type \|\| 'image\/jpeg'/);
    });
    it('pronouns and the pinned image are gone from every client surface', () => {
        for (const f of ['./ProfileModal.tsx', './ProfileCardParts.tsx', './profile/ProfilePopoutCard.tsx', './profile/ProfileFullView.tsx', './settings/panes/ProfilePane.tsx', './settings/panes/ProfileCosmeticsSection.tsx', './settings/panes/ProfileExtrasSection.tsx', './settings/panes/ProfilePreviewCard.tsx', './settings/panes/ProfileVisibilitySection.tsx', '../utils/profileVisibility.ts', '../utils/profileCache.ts', '../utils/profileCosmetics.ts', '../contexts/AuthContext.tsx']) {
            expect(read(f)).not.toMatch(/pronoun|widget_image|widgetImage|PinnedImage|Pinned image/i);
        }
        for (const f of ['./settings/panes/ProfileCosmeticsSection.tsx', './settings/panes/ProfileExtrasSection.tsx']) {
            expect(read(f)).not.toMatch(/uploadEncryptedFile|broadcastProfileAvatarKey|saveAvatarKey/);
        }
    });
    it('links save as one PATCH key and open only through the validated path', () => {
        const sec = read('./settings/panes/ProfileExtrasSection.tsx');
        expect(sec).toContain('save({ links: next }');
        expect(read('./ProfileCardParts.tsx')).toContain('openProfileLink');
        expect(read('./profile/ProfileFullView.tsx')).toContain('<ProfileCardLinks');
        // The preview (and so the Settings preview) draws no links at all: they live on the full profile.
        expect(read('./profile/ProfilePopoutCard.tsx')).not.toMatch(/ProfileCardLinks|openProfileLink|openExternalLink/);
    });
    it('every profile customisation save PATCHes exactly one changed key', () => {
        const calls = ['./settings/panes/ProfileCosmeticsSection.tsx', './settings/panes/ProfileExtrasSection.tsx']
            .flatMap((f) => [...read(f).matchAll(/(?:void|await) save\(\{ (\w+):/g)].map((m) => m[1]));
        expect(calls.length).toBeGreaterThanOrEqual(8);
        for (const k of calls) {
            expect(['profile_theme', 'avatar_decoration', 'profile_effect', 'cosmetic_options', 'widgets', 'links', 'profile_showcase', 'interests']).toContain(k);
        }
    });
    it('no new persisted client setting was added (nothing for backupRegistry to classify)', () => {
        for (const f of ['./settings/panes/ProfileCosmeticsSection.tsx', './settings/panes/ProfileExtrasSection.tsx', './profile/ProfilePopoutCard.tsx', './profile/ProfileFullView.tsx', './profile/ProfileShareDialog.tsx', '../utils/palette.ts', '../utils/shareCard.ts', './profile/AchievementsPanel.tsx', './ProfileBadgeRow.tsx', '../utils/profileCardLayout.ts', './ProfileCosmetics.tsx', '../utils/profileCosmetics.ts', '../utils/profileTheme.ts', '../utils/animatedImage.ts']) {
            expect(read(f)).not.toMatch(/secureLocalStore\.setItem|secureStore\.set|localStorage/);
        }
    });
    it('a locked decoration / effect is only ever tried on, never saved; the try-on ends when you leave it', () => {
        const sec = read('./settings/panes/ProfileCosmeticsSection.tsx');
        expect(sec).toContain("if (it && !unlocked(it)) { setTryDeco(id); return; } // preview only");
        expect(sec).toContain("if (it && !unlocked(it)) { setTryFx(id); return; }");
        // another studio, or leaving the Style tab, ends the try-on
        expect(sec).toContain("const endTryOns = () => { setProposals(null); setTryDeco(null); setTryFx(null); setPointDeco(undefined); setPointFx(undefined); };");
        expect(sec).toMatch(/const chooseStudio = [\s\S]*?endTryOns\(\);/);
        expect(sec).toContain("if (!active) endTryOns();");
        expect(read('./settings/panes/ProfilePane.tsx')).toContain("active={tab === 'style'}");
        // the duplicate "Trying on X. Locked: ..." banner over the preview is gone (the inspector explains locks)
        expect(read('./settings/panes/ProfilePreviewCard.tsx')).not.toMatch(/tryOn|Trying on/);
        // the native OS color input is gone from every profile / personalize / role picker
        for (const f of ['./settings/panes/ProfileCosmeticsSection.tsx', './settings/panes/CallPersonalizeCard.tsx', './server/roles/RoleDisplayEditor.tsx']) {
            expect(read(f)).not.toMatch(/type="color"/);
        }
    });
});
