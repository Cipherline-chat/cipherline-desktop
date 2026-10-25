import React, { useEffect, useState } from 'react';
import { Headphones, Radio, Tv } from 'lucide-react';
import { GameControllerIcon } from '../GameControllerIcon';
import { ProfileLinkIcon } from '../ProfileLinkIcon';
import { isLinkPlatform } from '../../utils/profileLinks';
import { safeImageSrc } from '../../utils/safeMediaUrl';
import { openExternalLink } from '../../utils/openExternalLink';
import type { ProfileActivity } from './integrationTypes';

/**
 * "Playing / Listening to / Watching / Streaming" - what someone is doing now.
 * Data: hooks/useProfileActivity.ts (INTEGRATION_SLOTS.md). Drawn on the
 * preview popover (`compact`: the first one, one line of detail) and the full
 * profile (`full`: all of them, with art, detail and a live progress bar).
 */

const KIND_LABEL: Record<ProfileActivity['kind'], string> = {
    playing: 'Playing', listening: 'Listening to', watching: 'Watching', streaming: 'Streaming',
};

const SourceIcon: React.FC<{ a: ProfileActivity; size: number }> = ({ a, size }) => {
    if (a.source === 'game') return <GameControllerIcon size={size} />;
    if (isLinkPlatform(a.source)) return <ProfileLinkIcon platform={a.source} size={size} />;
    if (a.kind === 'listening') return <Headphones size={size} aria-hidden="true" />;
    if (a.kind === 'watching') return <Tv size={size} aria-hidden="true" />;
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

const Row: React.FC<{ a: ProfileActivity; full: boolean }> = ({ a, full }) => {
    const art = safeImageSrc(a.art ?? null);
    const body = (
        <>
            <span className="pfa-art" data-kind={a.kind} data-source={a.source}>
                {art ? <img src={art} alt="" draggable={false} /> : <SourceIcon a={a} size={full ? 20 : 14} />}
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
        return (
            <button type="button" className="pfa-row" data-variant={full ? 'full' : 'compact'}
                onClick={(e) => { e.stopPropagation(); openExternalLink(url); }}
                aria-label={`${KIND_LABEL[a.kind]} ${a.title}${a.detail ? `, ${a.detail}` : ''}. Opens in your browser.`}>
                {body}
            </button>
        );
    }
    return <div className="pfa-row" data-variant={full ? 'full' : 'compact'}>{body}</div>;
};

export const ProfileActivityRow: React.FC<{
    activities: readonly ProfileActivity[];
    variant: 'compact' | 'full';
    className?: string;
}> = ({ activities, variant, className }) => {
    if (activities.length === 0) return null;
    const full = variant === 'full';
    const shown = full ? activities : activities.slice(0, 1);
    const more = activities.length - shown.length;
    return (
        <div className={`pfa${className ? ` ${className}` : ''}`} data-testid="profile-activity">
            {shown.map((a, i) => <Row key={`${a.kind}:${a.source}:${a.title}:${i}`} a={a} full={full} />)}
            {more > 0 && <span className="pfa-more">+{more} more</span>}
        </div>
    );
};

export default ProfileActivityRow;
