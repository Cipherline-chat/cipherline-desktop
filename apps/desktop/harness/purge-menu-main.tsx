/* eslint-disable -- visual/geometry harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import React from 'react';
import { StorageSettings } from '../src/components/StorageSettings';

/**
 * Renders the REAL StorageSettings (Settings -> Storage) with mock data so the
 * "Conversation storage" cards carry the real PurgeDropdown.
 *
 * Query: ?scroller=1 -> wrap the pane in a small overflow:auto box (the real settings
 *                     pane scrolls; the portaled menu must not be clipped by it).
 */
const q = new URLSearchParams(location.search);
const DAY = 24 * 3600 * 1000;

function msgs(n: number, spread: number[]) {
    const now = Date.now();
    return Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        timestamp: now - spread[i % spread.length] * DAY,
        content: { type: 'text', text: 'hello there '.repeat(1 + (i % 4)) },
    }));
}

const conversations = [
    { conversation_id: 'c1', type: 'dm', title: 'Mira' },
    { conversation_id: 'c2', type: 'group', title: 'Weekend crew' },
    { conversation_id: 'c3', type: 'dm', title: 'Jun' },
];
const messagesState: Record<string, any[]> = {
    c1: msgs(1240, [2, 5, 12, 40, 90, 200, 400, 520]),
    c2: msgs(460, [1, 3, 9, 25, 60, 150, 300]),
    c3: msgs(1, [3]),
};
const noop = () => {};
const retention: any = {
    policy: { messageRetention: 'never', attachmentRetention: 'never' },
    setDmMessageRetention: noop, setGroupMessageRetention: noop, setServerMessageRetention: noop,
    setDmAttachmentRetention: noop, setGroupAttachmentRetention: noop, setServerAttachmentRetention: noop,
};

const App: React.FC = () => {
    const pane = (
        <div style={{ width: 640, margin: '0 auto' }} id="pane">
            <StorageSettings
                retention={retention}
                messagesState={messagesState}
                conversations={conversations}
                onClearAllMessages={noop}
                onPurgeConversation={(id, ms) => { (window as any).__purged = { id, ms }; }}
                onPurgeTypeNow={noop}
            />
        </div>
    );
    if (q.get('scroller') === '1') {
        return <div id="scroller" style={{ height: 520, overflow: 'auto', margin: '20px auto', width: 680, border: '1px dashed #2A3558' }}>{pane}</div>;
    }
    return <div style={{ padding: '24px 0 600px' }}>{pane}</div>;
};

createRoot(document.getElementById('root')!).render(<App />);
