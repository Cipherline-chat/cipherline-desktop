import React, { useId, useRef, useState } from 'react';
import { ChevronDown, CornerDownLeft } from 'lucide-react';
import { ProfileLinkIcon } from '../../ProfileLinkIcon';
import { ReorderChips } from './ReorderChips';
import { SteamLinkRow, type SteamLinkRowProps } from './SteamLinkRow';
import { moveItem } from '../../../utils/moveItem';
import {
    LINK_PLATFORMS, PLATFORM_RULES, PROFILE_LINKS_MAX, checkLinkInput, detectPlatform, displayHandle, platformLabel,
    type LinkPlatform, type ProfileLink,
} from '../../../utils/profileLinks';

/**
 * Links editor (round 2, owner: "the UI just kinda sucks"): one combined
 * control. The platform is an icon attached to the front of the input (press
 * it for the closed list of platforms - there is no website option, and no
 * Steam option either); paste a
 * profile link and the platform switches itself and the handle is pulled
 * out; a valid entry shows as a chip preview inside the field and Enter adds
 * it. The links are chips (platform icon + handle) you drag, or move with
 * Alt + arrows, and remove with ×. Steam is never a pasted link: a Steam row
 * leads the list - "Connect Steam" (sign in with Steam, the same verified flow
 * as Settings > Steam) or the verified account with Unlink.
 *
 * Pure UI over utils/profileLinks.ts: `onChange` only ever gets a list the
 * server will accept (it re-checks everything). The caller saves at once.
 */
export const ProfileLinksEditor: React.FC<{
    links: ProfileLink[];
    disabled?: boolean;
    onChange: (next: ProfileLink[]) => void;
    /** The verified-Steam row at the top (connect / verified + unlink). Omit to hide it. */
    steam?: SteamLinkRowProps;
}> = ({ links, disabled, onChange, steam }) => {
    const [platform, setPlatform] = useState<LinkPlatform>('x');
    const [draft, setDraft] = useState('');
    const [picking, setPicking] = useState(false);
    const [tried, setTried] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const msgId = useId();
    const pickId = useId();

    const full = links.length >= PROFILE_LINKS_MAX;
    const check = checkLinkInput(platform, draft);
    const duplicate = check?.ok === true && links.some((l) => l.platform === platform && l.handle.toLowerCase() === check.handle.toLowerCase());
    const error = full ? `That's the most links (${PROFILE_LINKS_MAX}).`
        : duplicate ? 'Already on your profile.'
        : check && !check.ok && (tried || draft.length > 2) ? shortError(platform, draft)
        : '';
    const ready = !full && check?.ok === true && !duplicate;

    const onType = (v: string) => {
        setTried(false);
        // A pasted profile link picks its own platform.
        const found = detectPlatform(v);
        if (found && found.platform !== platform) setPlatform(found.platform);
        setDraft(v);
    };
    const add = () => {
        setTried(true);
        if (!ready || !check || !check.ok) return;
        onChange([...links, { platform, handle: check.handle }]);
        setDraft(''); setTried(false);
    };
    const pick = (p: LinkPlatform) => { setPlatform(p); setPicking(false); setTried(false); inputRef.current?.focus(); };

    const chips = links.map((l) => ({
        key: `${l.platform}:${l.handle}`, name: `${platformLabel(l.platform)} link ${displayHandle(l)}`,
        icon: <ProfileLinkIcon platform={l.platform} size={14} />, label: displayHandle(l),
    }));

    return (
        <div className="ps-linked" data-testid="links-editor">
            {steam && <SteamLinkRow {...steam} disabled={disabled || steam.disabled} />}
            <ReorderChips
                items={chips} disabled={disabled} label={`Your links, ${links.length} of ${PROFILE_LINKS_MAX}`}
                onMove={(a, b) => onChange(moveItem(links, a, b))}
                onRemove={(i) => onChange(links.filter((_, k) => k !== i))}
            />
            <div className="ps-combo" data-invalid={error ? 'true' : undefined} data-disabled={disabled || full ? 'true' : undefined}>
                <button
                    type="button" className="ps-combo-pick" aria-label={`Platform: ${platformLabel(platform)}. Change`}
                    aria-expanded={picking} aria-controls={pickId} disabled={disabled || full}
                    onClick={() => setPicking((v) => !v)}
                >
                    <ProfileLinkIcon platform={platform} size={15} />
                    <ChevronDown size={12} aria-hidden="true" />
                </button>
                <input
                    ref={inputRef} id="pc-link-input" className="ps-combo-input" value={draft} maxLength={200}
                    placeholder={full ? 'Remove one to add another' : `${platformLabel(platform)}: ${PLATFORM_RULES[platform].placeholder}, or paste a link`}
                    disabled={disabled || full} aria-invalid={!!error} aria-describedby={msgId}
                    aria-label={`Add a ${platformLabel(platform)} link`}
                    onChange={(e) => onType(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                />
                {ready && check?.ok && (
                    <button type="button" className="ps-combo-preview" onClick={add} aria-label={`Add ${platformLabel(platform)} ${displayHandle({ platform, handle: check.handle })}`}>
                        <ProfileLinkIcon platform={platform} size={12} />
                        <span>{displayHandle({ platform, handle: check.handle })}</span>
                        <CornerDownLeft size={12} aria-hidden="true" />
                    </button>
                )}
                {!ready && !draft && <span className="ps-combo-count" aria-hidden="true">{links.length}/{PROFILE_LINKS_MAX}</span>}
            </div>
            {picking && (
                <div id={pickId} className="ps-plats" role="listbox" aria-label="Platform">
                    {LINK_PLATFORMS.map((p) => (
                        <button key={p} type="button" role="option" aria-selected={p === platform} className="ps-plat" onClick={() => pick(p)}>
                            <ProfileLinkIcon platform={p} size={14} /><span>{platformLabel(p)}</span>
                        </button>
                    ))}
                </div>
            )}
            <p id={msgId} className={error ? 'ps-inline-err' : 'ps-inline-hint'} role={error ? 'alert' : undefined}>
                {error || (links.length === 0 ? 'Paste a profile link or type a handle. Links show as unverified.' : ' ')}
            </p>
        </div>
    );
};

/** A short, specific reason a draft cannot be added. */
function shortError(platform: LinkPlatform, draft: string): string {
    const rule = PLATFORM_RULES[platform];
    if (/^[a-z][a-z0-9+.-]*:/i.test(draft.trim()) || draft.trim().startsWith('//')) {
        return rule.hosts.length ? `Only ${rule.hosts[0]} links for ${rule.label}.` : `${rule.label} takes a username, not a link.`;
    }
    return `Not a ${rule.label} handle: ${rule.hint}.`;
}
