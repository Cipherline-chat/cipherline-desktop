/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import { ServerChannelList } from '../src/components/server/ServerChannelList';
import type { ChannelInfo, CategoryInfo, ServerInfo } from '../src/hooks/useServers';

/**
 * The REAL ServerChannelList in a sidebar frame, with a server of 25 text
 * channels in 3 categories (+ 4 uncategorized).
 *
 *   ?scene=below     unreads below the fold, plain            -> "New unreads" (lume)
 *   ?scene=mentions  two @mentions below the fold             -> "2 mentions" (red)
 *   ?scene=both      scrolled mid-list: unread above, mention below
 *   ?scene=quiet     server on "@mentions only", plain unread below -> grey pill
 *   ?scene=collapsed  a mention hidden in a category the driver collapses
 *   ?scene=none      nothing unread (negative control: no pill)
 *   &h=<px>          frame height (default 560)
 *
 * The driver (offscreen-unread-drive.mjs) clicks / scrolls it from outside.
 */
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'below';
const H = Number(q.get('h') ?? 560);

const SERVER = {
    server_id: 's1', name: 'Lumen Collective', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'u1', created_at: '',
} as ServerInfo;

const LAYOUT: Array<[string | null, string, string[]]> = [
    [null, '', ['welcome', 'announcements', 'rules', 'general']],
    ['community', 'Community', ['introductions', 'general-chat', 'memes', 'music', 'gaming', 'events', 'help']],
    ['projects', 'Projects', ['design', 'frontend', 'backend', 'mobile', 'release-notes', 'bugs', 'roadmap']],
    ['offtopic', 'Off topic', ['random', 'pets', 'food', 'books', 'movies', 'travel', 'cursed-images']],
];

const channels: ChannelInfo[] = [];
const categories: CategoryInfo[] = [];
let pos = 0;
for (const [catId, catName, names] of LAYOUT) {
    if (catId) categories.push({ category_id: catId, server_id: 's1', name: catName, position: categories.length, kind: 'text', icon_name: null });
    for (const n of names) {
        channels.push({
            channel_id: n, server_id: 's1', kind: 'text', name: n, topic: null, icon_emoji: null, icon_name: null,
            position: pos++, parent_category_id: catId, active_call_session_id: null, member_limit: null, max_calls: null,
        });
    }
}

let unreadCounts: Record<string, number> = {};
let mentionCounts: Record<string, number> = {};
let serverNotifMode: 'all' | 'mentions' = 'all';
let initialScroll = 0;
switch (scene) {
    case 'below':
        unreadCounts = { rules: 2, 'general-chat': 1, design: 4, backend: 1, bugs: 12, random: 3 };
        break;
    case 'mentions':
        unreadCounts = { rules: 2, design: 4, bugs: 12 };
        mentionCounts = { backend: 1, travel: 1 };
        break;
    case 'both':
        unreadCounts = { rules: 2, 'general-chat': 1, random: 2 };
        mentionCounts = { travel: 2 };
        initialScroll = 230;
        break;
    case 'collapsed':
        unreadCounts = { rules: 2, design: 4 };
        mentionCounts = { travel: 2 };
        break;
    case 'quiet':
        serverNotifMode = 'mentions';
        unreadCounts = { rules: 2, design: 4, bugs: 12 };
        break;
    case 'none':
        break;
}

function Frame() {
    const [active, setActive] = React.useState<string | null>('general');
    React.useEffect(() => {
        const el = document.querySelector<HTMLElement>('[tabindex="-1"].custom-scrollbar');
        if (el && initialScroll) el.scrollTop = initialScroll;
        (window as unknown as { __ready: boolean }).__ready = true;
    }, []);
    return (
        <div style={{ padding: 28, display: 'flex', justifyContent: 'center' }}>
            <div
                style={{
                    width: 272, height: H, background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
                    borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column',
                    boxShadow: '0 20px 60px rgba(0,0,0,.45)',
                }}
            >
                <ServerChannelList
                    server={SERVER}
                    channels={channels}
                    categories={categories}
                    loading={false}
                    activeChannelId={active}
                    onSelectChannel={(c) => setActive(c.channel_id)}
                    token={null}
                    userId={null}
                    unreadCounts={unreadCounts}
                    mentionCounts={mentionCounts}
                    serverNotifMode={serverNotifMode}
                />
            </div>
        </div>
    );
}

loadWebFonts();
createRoot(document.getElementById('root')!).render(<Frame />);
