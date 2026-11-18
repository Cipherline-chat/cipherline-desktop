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
import { CategoryFormDialog } from '../src/components/server/CategoryFormDialog';
import { CategoryDeleteDialog } from '../src/components/server/CategoryDeleteDialog';
import { ToastProvider } from '../src/contexts/ToastContext';
import { ALL_PERMISSIONS } from '@cipherline/shared';
import type { ChannelInfo, CategoryInfo, DividerInfo, ServerInfo } from '../src/hooks/useServers';

/**
 * 2026-11-17 channel-list round: category hierarchy, divider categories, and
 * the two-choice category delete. The REAL components in a sidebar frame.
 *
 *   ?scene=list           the channel list (a divider category with a
 *                         sub-category, next to an ordinary category)
 *     &before=1           re-applies the OLD category-label CSS values
 *                         (10px, semibold, --cl-faint, 1.1px tracking) on top,
 *                         for the before/after comparison
 *     &theme=light        a LIGHT surface (simulated: the desktop app ships a
 *                         dark theme only; this checks the divider colours and
 *                         the hierarchy still read on a light background)
 *   ?scene=create         Create Category with "Divider category" picked
 *   ?scene=delete         the two-choice delete (&choice=everything&ack=1)
 *
 * Shot by harness/category-round-shots.mjs.
 */
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'list';
const light = q.get('theme') === 'light';

if (light) {
    const css = `
      :root { --cl-deep:#f4f6fb; --cl-abyss:#ffffff; --cl-raise:#e7ebf4; --cl-surface:#eef1f8; --cl-text:#101828; --cl-muted:#3d4863; --cl-faint:#6b7591; --cl-border:rgba(16,24,40,.12); }
      body { background:#dfe4ee !important; }
      .text-cl-text { color:#101828 !important; } .text-cl-muted { color:#3d4863 !important; } .text-cl-faint { color:#6b7591 !important; }
      .group:hover .group-hover\\:text-cl-text { color:#101828 !important; }
      .bg-cl-deep { background:#f4f6fb !important; } .bg-cl-abyss { background:#fff !important; }
      .border-cl-border { border-color:rgba(16,24,40,.12) !important; }
    `;
    const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el);
}
if (q.get('before') === '1') {
    // The label exactly as origin/main draws it (ServerChannelList before this branch).
    const el = document.createElement('style');
    el.textContent = `[aria-label$=", category"] span.uppercase { font-size:10px !important; font-weight:600 !important; color:#5E6B8F !important; letter-spacing:1.1px !important; }`;
    document.head.appendChild(el);
}

const SERVER = {
    server_id: 's1', name: 'Maker Collective', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'owner', created_at: '',
} as ServerInfo;
const cat = (id: string, name: string, position: number, parent: string | null = null, extra: Partial<CategoryInfo> = {}): CategoryInfo =>
    ({ category_id: id, server_id: 's1', name, position, kind: 'text', icon_name: null, parent_category_id: parent, ...extra });
const ch = (id: string, parent: string | null, position: number): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind: 'text', name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
});

const style = q.get('style') ?? 'header';
const categories: CategoryInfo[] = [
    cat('craft', 'Crafting', 1000),
    cat('wood', 'Woodworking', 2000, 'craft'),
    cat('metal', 'Metalwork', 3000, 'craft'),
    cat('games', 'Game Nights', 2000, null, (style === 'none' ? {} : { header_style: style, header_color: q.get('color') ?? '#25e0c8' })),
    cat('tabletop', 'Tabletop', 3000, 'games'),
    cat('events', 'Events', 3000),
];
const channels: ChannelInfo[] = [
    ch('welcome', null, 1000), ch('general', null, 2000),
    ch('crafting-chat', 'craft', 1000),
    ch('joinery', 'wood', 1000), ch('finishes', 'wood', 2000),
    ch('welding', 'metal', 1000),
    ch('lfg', 'games', 1000), ch('game-chat', 'games', 2000),
    ch('dnd-tuesday', 'tabletop', 1000), ch('board-games', 'tabletop', 2000),
    ch('build-nights', 'events', 1000),
];
const dividers: DividerInfo[] = [];

function Frame() {
    const [active, setActive] = React.useState<string | null>('joinery');
    React.useEffect(() => { (window as unknown as { __ready: boolean }).__ready = true; }, []);
    if (scene === 'create') {
        return (
            <CategoryFormDialog
                serverId="s1" token={null} kind="text" ownerUserId="owner" currentUserId="owner"
                category={q.get('edit') === '1' ? categories[3] : null}
                categories={categories}
                onClose={() => {}} onSaved={() => {}}
            />
        );
    }
    if (scene === 'delete') {
        return (
            <CategoryDeleteDialog
                name="Game Nights" isSub={false}
                only={{ title: 'Delete "Game Nights"?', message: 'Channels inside will become uncategorized; its sub-categories become categories.' }}
                contents={{ channels: 4, subcategories: 1, dividers: 2 }}
                initialChoice={q.get('choice') === 'everything' ? 'everything' : 'only'}
                onConfirm={() => {}} onCancel={() => {}}
            />
        );
    }
    return (
        <div style={{ padding: 28, display: 'flex', justifyContent: 'center' }}>
            <div
                style={{
                    width: 280, height: 720, background: light ? '#f4f6fb' : 'var(--cl-deep)', border: '1px solid var(--cl-border)',
                    borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column',
                    boxShadow: light ? '0 20px 60px rgba(16,24,40,.18)' : '0 20px 60px rgba(0,0,0,.45)',
                }}
            >
                <ServerChannelList
                    server={SERVER}
                    channels={channels}
                    categories={categories}
                    dividers={dividers}
                    loading={false}
                    activeChannelId={active}
                    onSelectChannel={(c) => setActive(c.channel_id)}
                    token={null}
                    userId="owner"
                    myPermissions={ALL_PERMISSIONS}
                    unreadCounts={{ 'dnd-tuesday': 4, lfg: 2 }}
                    mentionCounts={{ 'board-games': 1 }}
                    serverNotifMode="all"
                    onDeleteCategoryApi={async () => {}}
                    onDeleteCategoryWithContentsApi={async () => {}}
                />
            </div>
        </div>
    );
}

loadWebFonts();
createRoot(document.getElementById('root')!).render(<ToastProvider><Frame /></ToastProvider>);
