/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import React, { useState } from 'react';
import { StorageSettings } from '../src/components/StorageSettings';

/**
 * Renders the REAL StorageSettings (Settings -> Storage) with mock DM and server data.
 *
 * Query: ?state=empty   -> no servers      ?state=loading -> server list loading
 *        ?state=error   -> server list failed
 *        ?state=pending -> one server's channel list hasn't loaded (its row shows "Loading…",
 *                          and Left/Other rows are withheld until it does)
 *        (default)      -> a realistic spread: big/small/empty servers and a "Left" server
 *                          with leftover history.
 */
const q = new URLSearchParams(location.search);
const state = q.get('state') ?? 'full';
const DAY = 24 * 3600 * 1000;

function msgs(prefix: string, n: number, spread: number[], withFiles = 0) {
    const now = Date.now();
    return Array.from({ length: n }, (_, i) => {
        const isFile = i < withFiles;
        return {
            id: `${prefix}${i}`,
            timestamp: now - spread[i % spread.length] * DAY,
            content: isFile
                ? { type: 'attachment', attachment_id: `${prefix}-att-${i}`, filename: 'shot.png', byte_size: 340_000 + i * 11_000 }
                : { type: 'text', text: 'hello there '.repeat(1 + (i % 4)) },
        };
    });
}

const conversations = [
    { conversation_id: 'c1', type: 'dm', title: 'Mira' },
    { conversation_id: 'c2', type: 'group', title: 'Weekend crew' },
];
const messagesState: Record<string, any[]> = {
    c1: msgs('d', 1240, [2, 5, 12, 40, 90, 200, 400, 520]),
    c2: msgs('g', 460, [1, 3, 9, 25, 60, 150, 300]),
};

const servers = [
    { server_id: 'S1', name: 'Neon Guild' },
    { server_id: 'S2', name: 'Design Team' },
    { server_id: 'S3', name: 'Book Club' },
    { server_id: 'S4', name: 'Quiet Corner' },
    { server_id: 'S5', name: 'Just Joined' },
];
const serverChannels: Record<string, { channel_id: string; name: string }[]> = {
    S1: [{ channel_id: 'n1', name: 'general' }, { channel_id: 'n2', name: 'clips' }, { channel_id: 'n3', name: 'dev' }],
    S2: [{ channel_id: 'd1', name: 'crit' }, { channel_id: 'd2', name: 'assets' }],
    S3: [{ channel_id: 'b1', name: 'reading' }],
    S4: [{ channel_id: 'q1', name: 'lounge' }],
    ...(state === 'pending' ? {} : { S5: [{ channel_id: 'j1', name: 'welcome' }] }),   // ?state=pending: S5's channel list not loaded yet
};
const channelMessages: Record<string, any[]> = {
    n1: msgs('n1-', 2600, [1, 2, 4, 9, 20, 45, 100, 220, 420], 40),
    n2: msgs('n2-', 380, [3, 11, 33, 70, 140, 300], 90),
    n3: msgs('n3-', 900, [1, 6, 21, 50, 130, 380]),
    d1: msgs('d1-', 540, [2, 8, 27, 60, 190], 12),
    d2: msgs('d2-', 60, [5, 40, 400], 20),
    b1: msgs('b1-', 120, [1, 14, 90]),
    // q1: nothing cached
    j1: msgs('j1-', 4, [0, 1]),
    x1: msgs('x1-', 210, [60, 120, 300, 500], 6),
};
const leftServerChannels = { SL: [{ channel_id: 'x1', name: 'lobby' }, { channel_id: 'x2', name: 'memes' }] };

const noop = () => {};
const retention: any = {
    policy: { messageRetention: 'never', attachmentRetention: 'never' },
    setDmMessageRetention: noop, setGroupMessageRetention: noop, setServerMessageRetention: noop,
    setDmAttachmentRetention: noop, setGroupAttachmentRetention: noop, setServerAttachmentRetention: noop,
};

const App: React.FC = () => {
    const [log, setLog] = useState<string>('');
    const none = state === 'empty' || state === 'loading' || state === 'error';
    const serverStorage = {
        servers: none ? [] : servers,
        serverChannels: none ? {} : serverChannels,
        channelMessages: none ? {} : channelMessages,
        leftServerChannels: none ? {} : leftServerChannels,
        protectedIds: { n1: Array.from({ length: 6 }, (_, i) => `n1-${i + 60}`) },
        token: null,
        loading: state === 'loading',
        error: state === 'error',
        onPurge: async (ids: string[], ms: number) => {
            (window as any).__purged = { ids, ms };
            setLog(JSON.stringify({ ids, ms }));
            return { purged: 3, skippedChannels: 0 };
        },
    };
    return (
        <div style={{ padding: '24px 0 600px' }}>
            <div style={{ width: 640, margin: '0 auto' }} id="pane">
                <StorageSettings
                    retention={retention}
                    messagesState={messagesState}
                    conversations={conversations}
                    onClearAllMessages={noop}
                    onPurgeConversation={noop}
                    onPurgeTypeNow={noop}
                    serverStorage={serverStorage}
                />
            </div>
            <pre id="log" style={{ display: 'none' }}>{log}</pre>
        </div>
    );
};

createRoot(document.getElementById('root')!).render(<App />);
