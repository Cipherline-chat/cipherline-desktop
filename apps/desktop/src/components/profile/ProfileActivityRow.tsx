import React, { useEffect, useState } from 'react';
import { ExternalLink, Flag, Radio } from 'lucide-react';
import { GameControllerIcon } from '../GameControllerIcon';
import { ProfileLinkIcon } from '../ProfileLinkIcon';
import { isIconPlatform } from '../../utils/profileLinks';
import { safeImageSrc } from '../../utils/safeMediaUrl';
import { openExternalLink } from '../../utils/openExternalLink';
import { ActivitySourceIcon } from '../integrations/PlatformLogo';
import { useContextMenu } from '../../hooks/useContextMenu';
import { MenuHost } from '../primitives/MenuHost';
import type { ProfileActivity } from './integrationTypes';

/**
 * "Playing / Listening to / Watching / Streaming" - what someone is doing now.
 * Data: hooks/useProfileActivity.ts (INTEGRATION_SLOTS.md). Every activity gets
 * its own row: on the preview popover (`compact`: one line of detail) and on the
 * full profile (`full`: with art, detail and a live progress bar).
 */

const KIND_LABEL: Record<ProfileActivity['kind'], string> = {
    playing: 'Playing', listening: 'Listening to', watching: 'Watching', streaming: 'Streaming',
};

/**
 * A plain cube: the stand-in for a block game (Minecraft) when no picture is
 * available. Original geometry in the row's own colour, not any publisher's art.
 */
const BlockGlyph: React.FC<{ size: number }> = ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M12 2.5 20.5 7 12 11.5 3.5 7z" opacity=".95" />
        <path d="M3.5 8.2 11.2 12.3v9L3.5 17z" opacity=".6" />
        <path d="M20.5 8.2 12.8 12.3v9l7.7-4.3z" opacity=".35" />
    </svg>
);

const SourceIcon: React.FC<{ a: ProfileActivity; size: number }> = ({ a, size }) => {
    if (a.source === 'game' && a.glyph === 'block') return <BlockGlyph size={size} />;
    if (a.source === 'game') return <GameControllerIcon size={size} />;
    // The platform's logo (Spotify, YouTube, Netflix, ...), else the music note / the TV.
    if (a.kind === 'listening' || a.kind === 'watching') return <ActivitySourceIcon kind={a.kind} source={a.source} size={size} />;
    if (isIconPlatform(a.source)) return <ProfileLinkIcon platform={a.source} size={size} />;
    if (a.kind === 'streaming') return <Radio size={size} aria-hidden="true" />;
    return <GameControllerIcon size={size} />;
};

const fmt = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A live position, ticking once a second only while it is on screen. */
const Progress: React.FC<{ p: NonNullable<ProfileActivity['progress']> }> = ({ p }) => {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(t);
    }, []);
    const at = Math.min(p.durationMs, Math.max(0, now - p.startedAt));
    const f = p.durationMs > 0 ? at / p.durationMs : 0;
    return (
        <span className="pfa-prog" aria-label={`${fmt(at)} of ${fmt(p.durationMs)}`}>
            <span className="pfa-bar"><i style={{ transform: `scaleX(${f})` }} /></span>
            <span className="pfa-time" aria-hidden="true"><span>{fmt(at)}</span><span>{fmt(p.durationMs)}</span></span>
        </span>
    );
};

/**
 * A friend's end-to-end encrypted cover can be reported (the server cannot see
 * it, so the reporter's device attaches it). Reporting lives on the row's
 * right-click menu rather than a visible button, like the rest of the app's
 * per-item actions. The keyboard menu key / Shift+F10 opens it too: that
 * contextmenu event carries no pointer position, so the menu anchors to the row.
 */
const Row: React.FC<{ a: ProfileActivity; full: boolean; open?: OpenProfile }> = ({ a, full, open }) => {
    const ctx = useContextMenu();
    const row = open && !full ? <OpenableRow a={a} open={open} /> : <RowBody a={a} full={full} />;
    if (!a.report) return row;
    const report = a.report;
    const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        const keyboard = e.clientX === 0 && e.clientY === 0;
        e.preventDefault();
        e.stopPropagation();
        ctx.open(keyboard ? { clientX: r.left + 12, clientY: r.bottom } : e, [
            { icon: <Flag size={14} aria-hidden="true" />, label: 'Report this cover', danger: true, onSelect: report },
        ]);
    };
    return (
        <div className="pfa-item" data-testid="profile-activity-reportable" onContextMenu={onContextMenu}>
            {row}
            <MenuHost>{ctx.menu}</MenuHost>
        </div>
    );
};

/** On the preview card, clicking a row opens the full profile; `label` names whose. */
export interface OpenProfile { onOpen: () => void; label: string }

/**
 * A row on the preview card: the row opens the full profile, and only the title is
 * a link to the song or video. The link icon shows only while the link is hovered,
 * and sits over the text rather than taking room from it, so the name and artist
 * get the whole line the rest of the time.
 *
 * The title is an inline span rather than a button: a button is one unbreakable box,
 * so a long title would vanish whole instead of ending in an ellipsis. The row's
 * click target is a separate button stretched behind the text, since a button cannot
 * hold another control.
 */
const OpenableRow: React.FC<{ a: ProfileActivity; open: OpenProfile }> = ({ a, open }) => {
    const art = safeImageSrc(a.art ?? null);
    const text = `${KIND_LABEL[a.kind]} ${a.title}${a.detail ? ` \u00b7 ${a.detail}` : ''}`;
    const url = a.url;
    const linkLabel = a.linkLabel ?? `Open ${a.title} in your browser`;
    const follow = (e: React.SyntheticEvent) => {
        e.stopPropagation();
        if (url) openExternalLink(url);
    };
    return (
        <div className="pfa-row" data-variant="compact" data-opens-profile="" data-link={url ? (a.linkLabel ? 'item' : 'url') : undefined}>
            <button type="button" className="pfa-open" aria-label={`${open.label}. ${text}`} title={text}
                onClick={(e) => { e.stopPropagation(); open.onOpen(); }} />
            <span className="pfa-art" data-kind={a.kind} data-source={a.source} data-shape={art ? a.artShape ?? undefined : undefined}>
                {art ? <img key={art} src={art} alt="" draggable={false} /> : <SourceIcon a={a} size={14} />}
            </span>
            <span className="pfa-line">
                {KIND_LABEL[a.kind]}{' '}
                {url ? (
                    <span className="pfa-link" role="link" tabIndex={0} aria-label={linkLabel} title={linkLabel} onClick={follow}
                        onKeyDown={(e) => { if (e.key === 'Enter') follow(e); }}>
                        <b>{a.title}</b>
                    </span>
                ) : <b>{a.title}</b>}
                {a.detail && <span className="pfa-detail"> · {a.detail}</span>}
            </span>
            {url && <ExternalLink className="pfa-ext" size={12} aria-hidden="true" data-testid="profile-activity-ext" />}
        </div>
    );
};

const RowBody: React.FC<{ a: ProfileActivity; full: boolean }> = ({ a, full }) => {
    const art = safeImageSrc(a.art ?? null);
    // The whole text, for when it is cut short with an ellipsis (long video titles).
    const text = `${KIND_LABEL[a.kind]} ${a.title}${a.detail ? ` \u00b7 ${a.detail}` : ''}`;
    const body = (
        <>
            <span className="pfa-art" data-kind={a.kind} data-source={a.source} data-shape={art ? a.artShape ?? undefined : undefined}>
                {/* Keyed by the picture: a better one replaces it in the same box and fades in (no layout change). */}
                {art ? <img key={art} src={art} alt="" draggable={false} /> : <SourceIcon a={a} size={full ? 20 : 14} />}
            </span>
            {full ? (
                <span className="pfa-txt">
                    <span className="pfa-kind">{KIND_LABEL[a.kind]}</span>
                    <b className="pfa-title">{a.title}</b>
                    {a.detail && <span className="pfa-detail">{a.detail}</span>}
                    {a.progress && <Progress p={a.progress} />}
                </span>
            ) : (
                // One line: "Listening to <b>Song</b> · Artist".
                <span className="pfa-line">
                    {KIND_LABEL[a.kind]} <b>{a.title}</b>{a.detail && <span className="pfa-detail"> · {a.detail}</span>}
                </span>
            )}
        </>
    );
    if (a.url) {
        const url = a.url;
        const label = a.linkLabel ?? `${KIND_LABEL[a.kind]} ${a.title}${a.detail ? `, ${a.detail}` : ''}. Opens in your browser.`;
        // A media link names where it goes first ("Open Midnight City on Spotify"), then what is playing.
        return (
            <button type="button" className="pfa-row" data-variant={full ? 'full' : 'compact'} data-link={a.linkLabel ? 'item' : 'url'}
                onClick={(e) => { e.stopPropagation(); openExternalLink(url); }}
                aria-label={a.linkLabel ? `${label}. ${text}` : label}
                title={a.linkLabel ? `${label}\n${text}` : text}>
                {body}
                <ExternalLink className="pfa-ext" size={full ? 14 : 12} aria-hidden="true" data-testid="profile-activity-ext" />
            </button>
        );
    }
    return <div className="pfa-row" data-variant={full ? 'full' : 'compact'} title={text}>{body}</div>;
};

export const ProfileActivityRow: React.FC<{
    activities: readonly ProfileActivity[];
    variant: 'compact' | 'full';
    className?: string;
    /** Preview card only: what clicking a row does. */
    open?: OpenProfile;
}> = ({ activities, variant, className, open }) => {
    if (activities.length === 0) return null;
    const full = variant === 'full';
    return (
        <div className={`pfa${className ? ` ${className}` : ''}`} data-testid="profile-activity">
            {activities.map((a, i) => <Row key={`${a.kind}:${a.source}:${a.title}:${i}`} a={a} full={full} open={open} />)}
        </div>
    );
};

export default ProfileActivityRow;
