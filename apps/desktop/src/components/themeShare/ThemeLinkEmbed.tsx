/**
 * ThemeLinkEmbed — the card under a message that carries a theme link
 * (`https://cipherline.chat/theme#clth1.…`, theme/themeLink.ts).
 *
 * Everything is decided on this device from the link itself: no fetch, no
 * server, no link preview. The fragment is decoded with exactly the import
 * dialog's rules (customTheme.ts decodeShareCode: colours only, a cleaned and
 * capped name, size cap), so a crafted link can only ever produce a valid
 * theme — colours exactly as the sender picked them — or the small "can't be
 * read" card.
 *
 * The card is framed by the CURRENT app theme (styles/theme-share.css reads the
 * app's tokens); the mini preview is painted from the SHARED theme's own
 * variables (CustomThemePreview), so what you see is what you would get.
 *
 * Actions: Preview (the theme on the WHOLE app with the "Previewing" bar:
 * ThemePreviewBar, Keep / Revert, reverts by itself after 15 s; nothing is
 * stored), Save, Save and use. Saving goes through the library's own create
 * (re-validated there too); "use" saves, then PREVIEWS the saved theme: only
 * Keep on the bar makes it the device's theme (activeThemeMirror via
 * themePreviewActions.keepPreviewedTheme), so a shared theme can never strand
 * anyone in unreadable colours.
 */
import React, { useMemo, useState } from 'react';
import { Eye, Link2Off, Palette } from 'lucide-react';
import { ClButton } from '../cl';
import { useAuth } from '../../contexts/AuthContext';
import { useContextMenu } from '../../hooks/useContextMenu';
import { deriveCustomTheme, KNOB_LABELS, type CustomThemeDef, type StoredCustomTheme } from '../../theme/customTheme';
import { useCustomThemes } from '../../theme/customThemeLibrary';
import { getActiveCustomThemeId, startThemePreview, useThemePreference, useThemePreview } from '../../theme/engine';
import { THEME_CARD_SWATCHES, buildThemeLink, parseThemeLink, sameThemeLook } from '../../theme/themeLink';
import { ThemePreviewThumb } from '../settings/panes/CustomThemePreview';
import '../../styles/theme-share.css';
import { copyText } from '../../utils/clipboard';
import { useToast } from '../../contexts/ToastContext';

/** Width the preview is drawn at (16:9, so ~320 x 180). */
const THUMB_WIDTH = 320;

const stripId = ({ id: _id, ...def }: StoredCustomTheme): CustomThemeDef => { void _id; return def; };

export const ThemeLinkEmbed: React.FC<{ url: string }> = ({ url }) => {
    const parsed = useMemo(() => parseThemeLink(url), [url]);
    if (parsed.kind === 'none') return null;
    if (parsed.kind === 'invalid') return <ThemeLinkUnreadable />;
    return <ThemeLinkCard def={parsed.result.def} />;
};

export const ThemeLinkUnreadable: React.FC = () => (
    <div className="tle tle--dead mt-1" data-theme-embed="invalid">
        <span className="tle-dead-ic" aria-hidden="true"><Link2Off size={17} /></span>
        <div className="min-w-0">
            <p className="tle-dead-title">Theme link can’t be read</p>
            <p className="tle-dead-sub">It may be cut off or damaged. Ask for the link again.</p>
        </div>
    </div>
);

type Status = { kind: 'ok' | 'err'; text: string } | null;

const ThemeLinkCard: React.FC<{ def: CustomThemeDef }> = ({ def }) => {
    const { userId, user } = useAuth();
    const uid = userId ?? user?.user_id ?? null;
    const lib = useCustomThemes(uid);
    const pref = useThemePreference();
    const theme = useMemo(() => deriveCustomTheme(def), [def]);
    const previewing = useThemePreview();
    const [status, setStatus] = useState<Status>(null);
    const ctx = useContextMenu();
    const toast = useToast();

    const saved = lib.items.find((t) => sameThemeLook(t, def)) ?? null;
    const inUse = !!saved && pref === 'custom' && getActiveCustomThemeId() === saved.id;
    const thisPreviewing = !!previewing?.def && sameThemeLook(previewing.def, def);
    const refusal = !lib.ready ? 'Your themes are still loading.' : lib.full ? 'You have 24 themes. Delete one to add another.' : null;

    // "Use" never applies a theme blind: it previews it, and Keep on the preview
    // bar (ThemePreviewBar) makes it stick. Without Keep it reverts by itself.
    const tryIt = (entry: StoredCustomTheme) => { startThemePreview(stripId(entry), { libraryId: entry.id }); };
    const save = (use: boolean): StoredCustomTheme | null => {
        if (saved) {
            if (use) { tryIt(saved); setStatus({ kind: 'ok', text: `Press Keep to use ${saved.name}.` }); }
            return saved;
        }
        const entry = lib.create(def);
        if (!entry) { setStatus({ kind: 'err', text: refusal ?? 'Could not save this theme.' }); return null; }
        if (use) tryIt(entry);
        setStatus({ kind: 'ok', text: use ? `Saved as ${entry.name}. Press Keep to use it.` : `Saved to your themes as ${entry.name}.` });
        return entry;
    };

    const link = buildThemeLink(def);
    const onContextMenu = (e: React.MouseEvent) => {
        ctx.open(e, [{
            label: 'Copy theme link',
            onSelect: () => {
                void copyText(link).then(ok => toast.push(ok
                    ? { kind: 'success', message: 'Theme link copied.' }
                    : { kind: 'error', message: 'Could not copy the theme link.' }));
            },
        }]);
    };

    return (
        <>
            <div className="tle mt-1 select-none" data-theme-embed="ok" onContextMenu={onContextMenu}>
                <div className="tle-eyebrow"><Palette size={12} strokeWidth={2.6} aria-hidden="true" />Cipherline theme</div>
                <div className="tle-head">
                    <p className="tle-name" title={def.name}>{def.name}</p>
                    <span className="tle-base">{def.base === 'dark' ? 'Dark' : 'Light'}{def.glow ? ' · glow' : ''}</span>
                </div>
                <div className="tle-shot">
                    <ThemePreviewThumb theme={theme} maxWidth={THUMB_WIDTH} label={`Preview of the theme ${def.name}`} />
                </div>
                <div className="tle-swatches" aria-label="Theme colours">
                    {THEME_CARD_SWATCHES.map((k) => (
                        <i key={k} className="tle-sw" style={{ background: def.colors[k] }} title={`${KNOB_LABELS[k].label} ${def.colors[k]}`} />
                    ))}
                </div>
                {status && <p className={`tle-status${status.kind === 'err' ? ' tle-status--err' : ''}`} role="status">{status.text}</p>}
                <div className="tle-foot">
                    <ClButton
                        variant="ghost"
                        size="sm"
                        fullWidth
                        onClick={() => startThemePreview(def, { libraryId: saved?.id ?? null })}
                        disabled={inUse}
                        tooltip={inUse ? 'You are using this theme' : thisPreviewing ? 'Previewing now' : 'Try it on the whole app. Nothing is saved.'}
                        ariaPressed={thisPreviewing}
                    >
                        <Eye size={14} /> {thisPreviewing ? 'Previewing' : 'Preview'}
                    </ClButton>
                    <ClButton
                        variant="ghost"
                        size="sm"
                        fullWidth
                        onClick={() => { save(false); }}
                        disabled={!!saved || (!lib.ready || lib.full)}
                        tooltip={saved ? `Already in your themes as ${saved.name}` : refusal ?? undefined}
                    >
                        {saved ? 'Saved' : 'Save'}
                    </ClButton>
                    <ClButton
                        size="sm"
                        fullWidth
                        onClick={() => { save(true); }}
                        disabled={inUse || (!saved && (!lib.ready || lib.full))}
                        tooltip={inUse ? 'You are using this theme' : !saved ? refusal ?? undefined : undefined}
                    >
                        {inUse ? 'In use' : saved ? 'Use' : 'Save and use'}
                    </ClButton>
                </div>
            </div>
            {ctx.menu}
        </>
    );
};

export default ThemeLinkEmbed;
