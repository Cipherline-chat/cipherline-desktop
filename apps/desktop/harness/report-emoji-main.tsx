/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import { ReportModal } from '../src/components/ReportModal';
import { emojiListCache } from '../src/utils/emojiListCache';
import { personalEmojiIdFromBytes } from '../src/utils/personalEmoji/token';
import { frankForSend, ingestInboundFranking, type ReportedMessageRef } from '../src/utils/franking';
import { serverEmojiPictures } from './report-emoji-image-stub';

/** ?scene=verified | unverified  — the report dialog over a chat-like backdrop. */
loadWebFonts();
const scene = new URLSearchParams(location.search).get('scene') ?? 'verified';
const SENDER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const DEVICE = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const CONV = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const SRV_EMOJI = '0f1e2d3c-4b5a-4968-8776-655443322110';

/** A 128 px emoji picture drawn on a canvas: a face of `color` with a `glyph` on it. */
async function drawEmoji(color: string, glyph: string): Promise<Uint8Array> {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = color;
    g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#111';
    g.font = 'bold 64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(glyph, 64, 70);
    const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}
const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));

async function main() {
    const clown = await drawEmoji('#f87171', '!');
    serverEmojiPictures.set('att-clown', URL.createObjectURL(new Blob([clown as BlobPart], { type: 'image/png' })));
    emojiListCache.set('srv-1', [{
        emoji_id: SRV_EMOJI, server_id: 'srv-1', name: 'clown', attachment_id: 'att-clown', key_b64: 'k', nonce_b64: 'n',
        animated: false, created_by: null, created_at: '2026-11-01T00:00:00Z',
    }]);
    const trash = await drawEmoji('#facc15', 'X');
    const skull = await drawEmoji('#a5b4fc', '?');
    const trashId = await personalEmojiIdFromBytes(trash);
    const skullId = await personalEmojiIdFromBytes(skull);
    const goneId = await personalEmojiIdFromBytes(new Uint8Array([1, 2, 3]));
    const store = { read: async (id: string) => (id === trashId ? trash : id === skullId ? skull : null) };

    const text = `nobody wants you here <:clown:${SRV_EMOJI}> you are <:trash_bag:${trashId}><:trash_bag:${trashId}> just leave <:skull_laugh:${skullId}> <:old_one:${goneId}>`;
    let message: ReportedMessageRef;
    if (scene === 'verified') {
        const sent = await frankForSend(JSON.stringify({ type: 'text', text }), { contextKind: 'dm', contextId: CONV, senderUserId: SENDER, senderDeviceId: DEVICE });
        const wire = { c: sent.commitment_b64!, t: b64(new Uint8Array(32).fill(2)), kid: 'k1', ts: Date.now() };
        const { content, franking } = ingestInboundFranking(JSON.parse(sent.contentJson), { wire, contextKind: 'dm', contextId: CONV, senderUserId: SENDER, senderDeviceId: DEVICE });
        message = { content, franking, sender_user_id: SENDER };
    } else {
        message = { content: { type: 'text', text }, franking: null, sender_user_id: SENDER };
    }

    const App = () => (
        <div style={{ position: 'relative', minHeight: '100vh', background: 'linear-gradient(180deg,#10162b,#0B0F1E)', color: '#F4F7FF', fontFamily: 'Nunito, sans-serif' }}>
            <div style={{ padding: 24, opacity: .6 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Direct message · Mira</div>
            </div>
            <ReportModal targetUserId={SENDER} targetUsername="Mira" token="tok" onClose={() => {}} initialSnippet={text} message={message} emojiStore={store} />
        </div>
    );
    createRoot(document.getElementById('root')!).render(<App />);
}
void main();
