/**
 * What the report dialog shows of the custom emoji in a reported message, so
 * the reporter sees exactly what will be included before sending
 * (utils/reportEmoji.ts):
 *
 *   - ReportEmojiText: the message text with each `<:name:id>` token drawn as
 *     its picture, at text size.
 *   - ReportEmojiList: "Emoji in this message" - each emoji with its name and
 *     what our team will see of it.
 *
 * A personal emoji is drawn from the very bytes that will be uploaded (object
 * URLs the dialog made from them). A server emoji is drawn from this session's
 * emoji lists when this device has the server's list; the API attaches its own
 * copy either way.
 */
import React from 'react';
import { EmojiImage } from './server/EmojiImage';
import { emojiListCache } from '../utils/emojiListCache';
import { reportEmojiTokens, type PersonalEmojiCollection, type ReportEmojiToken } from '../utils/reportEmoji';
import { findMentionTokens, parseMentionToken } from '../utils/mentionTokens';

const INLINE: React.CSSProperties = { display: 'inline-block', width: '1.4em', height: '1.4em', verticalAlign: '-0.35em', objectFit: 'contain' };
const LIST: React.CSSProperties = { width: 28, height: 28, objectFit: 'contain', flex: 'none' };

interface GlyphProps {
    t: ReportEmojiToken;
    /** Object URLs of the personal emoji images that will be sent, by id. */
    personalUrls: Record<string, string>;
    token: string;
    style: React.CSSProperties;
    compact?: boolean;
}

function NameBox({ t, style, compact }: { t: ReportEmojiToken; style: React.CSSProperties; compact?: boolean }) {
    if (compact) {
        // In the list the name is already beside it: a same-size dashed square says "no picture".
        return (
            <span
                data-testid="report-emoji-missing"
                title={`:${t.name}: (no picture)`}
                style={{ ...style, display: 'inline-grid', placeItems: 'center', border: '1px dashed rgb(var(--cl-bright-rgb) / 0.3)', borderRadius: 6, fontSize: 13, color: 'rgb(var(--cl-bright-rgb) / 0.5)' }}
            >
                ?
            </span>
        );
    }
    return (
        <span
            data-testid="report-emoji-missing"
            title={`:${t.name}:`}
            style={{ ...style, width: 'auto', minWidth: style.width, padding: '0 3px', border: '1px dashed rgb(var(--cl-bright-rgb) / 0.3)', borderRadius: 4, fontSize: '0.85em', lineHeight: 1.3, textAlign: 'center' }}
        >
            :{t.name}:
        </span>
    );
}

function EmojiGlyph({ t, personalUrls, token, style, compact }: GlyphProps) {
    if (t.source === 'personal') {
        const url = personalUrls[t.id];
        if (!url) return <NameBox t={t} style={style} compact={compact} />;
        return <img data-testid="report-emoji-img" data-emoji-id={t.id} src={url} alt={`:${t.name}:`} title={`:${t.name}:`} draggable={false} style={style} />;
    }
    const e = emojiListCache.find(t.id);
    if (!e) return <NameBox t={t} style={style} compact={compact} />;
    return (
        <span data-testid="report-emoji-server" data-emoji-id={t.id} title={`:${t.name}:`} style={{ display: 'inline-block', width: style.width, height: style.height, verticalAlign: style.verticalAlign, flex: style.flex }}>
            <EmojiImage
                name={e.name}
                serverId={e.server_id}
                attachmentId={e.attachment_id}
                keyB64={e.key_b64}
                nonceB64={e.nonce_b64}
                token={token}
                saveable={false}
                style={{ width: '100%', height: '100%' }}
            />
        </span>
    );
}

/** Message text with its custom-emoji tokens drawn as pictures. */
export function ReportEmojiText({ text, personalUrls, token }: { text: string; personalUrls: Record<string, string>; token: string }) {
    if (!text.includes('<:')) return <>{text}</>;
    const parts: React.ReactNode[] = [];
    let last = 0;
    for (const m of findMentionTokens(text, 'emoji')) {
        const p = parseMentionToken(m[0]);
        const t = p?.kind === 'emoji' ? reportEmojiTokens(m[0])[0] : undefined;
        if (!t) continue;
        if (m.index > last) parts.push(text.slice(last, m.index));
        parts.push(<EmojiGlyph key={`${m.index}`} t={t} personalUrls={personalUrls} token={token} style={INLINE} />);
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return <>{parts}</>;
}

/** What our team will see of each emoji, in words. */
function emojiNote(t: ReportEmojiToken, collection: PersonalEmojiCollection | null, imagesAllowed: boolean): string {
    if (t.source === 'server') return 'Server emoji — our team sees Cipherline’s copy';
    if (!imagesAllowed) return 'Personal emoji — only its name is sent with this kind of report';
    if (!collection) return 'Personal emoji — checking…';
    if (collection.included.some(e => e.id === t.id)) return 'Personal emoji — this image is sent with your report';
    const miss = collection.missing.find(m => m.id === t.id);
    if (miss?.reason === 'over_limit') return 'Personal emoji — over the limit for one report, only its name is sent';
    if (miss?.reason === 'too_large') return 'Personal emoji — too large to send, only its name is sent';
    return 'Personal emoji — not on this device, only its name is sent';
}

export function ReportEmojiList({ tokens, collection, personalUrls, token, imagesAllowed }: {
    tokens: ReportEmojiToken[];
    collection: PersonalEmojiCollection | null;
    personalUrls: Record<string, string>;
    token: string;
    /** False on a child-safety report: no images are sent with it. */
    imagesAllowed: boolean;
}) {
    if (tokens.length === 0) return null;
    return (
        <ul data-testid="report-emoji-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tokens.map(t => (
                <li key={t.id} data-testid="report-emoji-row" data-emoji-source={t.source} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                    <EmojiGlyph t={t} personalUrls={imagesAllowed ? personalUrls : {}} token={token} style={LIST} compact />
                    <span title={`:${t.name}:`} style={{ fontFamily: 'var(--cl-font-mono)', flex: '0 1 auto', maxWidth: '45%', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>:{t.name}:</span>
                    <span style={{ color: 'rgb(var(--cl-bright-rgb) / 0.6)', fontSize: 12, flex: '1 1 0', minWidth: 0 }}>{emojiNote(t, collection, imagesAllowed)}</span>
                </li>
            ))}
        </ul>
    );
}
