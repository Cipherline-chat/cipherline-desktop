/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import React from 'react';
import { StorageSettings } from '../src/components/StorageSettings';
import { DepthGauge } from '../src/components/settings/DepthGauge';

/**
 * ?view=storage  REAL StorageSettings with mock DMs / group / notes-to-self / a deleted chat / servers.
 * ?view=nav      REAL DepthGauge inside .sd-root.sd-arrived (add &old=1 to re-apply the pre-fix
 *                inline transition-delay + 200 ms colour transition: the negative control).
 */
const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'storage';
const DAY = 24 * 3600 * 1000;

function msgs(prefix: string, n: number, spread: number[], withFiles = 0) {
    const now = Date.now();
    return Array.from({ length: n }, (_, i) => ({
        id: `${prefix}${i}`,
        timestamp: now - spread[i % spread.length] * DAY,
        content: i < withFiles
            ? { type: 'attachment', attachment_id: `${prefix}-att-${i}`, filename: 'shot.png', byte_size: 340_000 + i * 11_000 }
            : { type: 'text', text: 'hello there '.repeat(1 + (i % 4)) },
    }));
}

const conversations = [
    { conversation_id: 'c1', type: 'dm', title: 'Mira', other_user_id: 'user-mira', avatar_url: 'img-mira' },
    { conversation_id: 'c2', type: 'group', title: 'Weekend crew', avatar_url: 'img-crew' },
    { conversation_id: 'c3', type: 'dm', title: 'Jonas', other_user_id: 'user-jonas', avatar_url: null },
    { conversation_id: 'c4', type: 'group', title: 'Book club', avatar_url: null },
    { conversation_id: 'c5', type: 'dm', title: 'Notes to self', other_user_id: 'user-me', avatar_url: 'img-me', is_self: true },
];
const messagesState: Record<string, any[]> = {
    c1: msgs('d', 1240, [2, 5, 12, 40, 90, 200, 400], 30),
    c2: msgs('g', 460, [1, 3, 9, 25, 60, 150, 300], 12),
    c3: msgs('j', 210, [1, 9, 60, 200]),
    c4: msgs('b', 130, [3, 30, 100]),
    c5: msgs('s', 48, [1, 20, 90]),
    gone: msgs('x', 60, [100, 300]),
};
const servers = [{ server_id: 'S1', name: 'Neon Guild' }, { server_id: 'S2', name: 'Design Team' }];
const serverChannels = { S1: [{ channel_id: 'n1', name: 'general' }], S2: [{ channel_id: 'd1', name: 'crit' }] };
const channelMessages: Record<string, any[]> = { n1: msgs('n1-', 900, [1, 4, 20, 100]), d1: msgs('d1-', 200, [2, 30, 200]) };
const noop = () => {};
const retention: any = {
    policy: { messageRetention: 'never', attachmentRetention: 'never' },
    setDmMessageRetention: noop, setGroupMessageRetention: noop, setServerMessageRetention: noop,
    setDmAttachmentRetention: noop, setGroupAttachmentRetention: noop, setServerAttachmentRetention: noop,
};

const Storage: React.FC = () => (
    <div style={{ padding: '24px 0 300px' }}>
        <div style={{ width: 640, margin: '0 auto' }} id="pane">
            <StorageSettings
                retention={retention}
                messagesState={messagesState}
                conversations={conversations}
                onClearAllMessages={noop}
                onPurgeConversation={noop}
                onPurgeTypeNow={noop}
                serverStorage={{
                    servers, serverChannels, channelMessages, leftServerChannels: {}, protectedIds: {},
                    token: 'harness-token', loading: false, error: false,
                    onPurge: async () => ({ purged: 0, skippedChannels: 0 }),
                } as any}
            />
        </div>
    </div>
);

const OLD_CSS = `.sd-root .sd-nitem{transition:color .2s,background .2s,transform .5s var(--cl-spring),opacity .4s ease}`;

const Nav: React.FC = () => {
    const [active, setActive] = React.useState<any>('profile');
    React.useEffect(() => {
        if (q.get('old') !== '1') return;
        const st = document.createElement('style');
        st.textContent = OLD_CSS;
        document.head.appendChild(st);
        // the pre-fix inline style: `transition-delay` on every nav item
        const apply = () => document.querySelectorAll<HTMLElement>('.sd-nitem').forEach((el, i) => {
            const zi = [0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3][i] ?? 0;
            const ii = [0, 1, 0, 1, 2, 3, 4, 0, 1, 2, 0, 1][i] ?? 0;
            el.style.transitionDelay = `${0.2 + (zi * 3 + ii) * 0.035}s`;
        });
        apply();
        return () => st.remove();
    }, []);
    return (
        <div className="sd-root sd-arrived" style={{ position: 'static', width: 300, height: 560, padding: 16 }}>
            <DepthGauge active={active} onSelect={setActive} appVersion="harness" />
        </div>
    );
};

createRoot(document.getElementById('root')!).render(view === 'nav' ? <Nav /> : <Storage />);
