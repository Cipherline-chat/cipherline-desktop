/**
 * ServerChannelList — Pane 2 for a server view.
 *
 * Renders, top-to-bottom:
 *   1. Optional banner image (when server.banner_attachment is set)
 *   2. Server name + Settings (gear)
 *   3. Uncategorized text channels (parent_category_id IS NULL), sorted by position
 *   4. For each ChannelCategory: a collapsible section with header
 *      + hover-revealed `+ add channel` and `⋯ category options` buttons,
 *      then the channels under it sorted by position
 *
 * Drag-and-drop (canManage only):
 *   • Drag channels to reorder within a category or move between categories.
 *   • Drag category headers (grip handle) to reorder categories.
 *   • Activation threshold is 8 px so clicks still work normally.
 */

import secureLocalStore from '../../utils/secureLocalStore';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Hash, ChevronDown, ChevronRight, Settings,
    CheckCheck, Link as LinkIcon, Pencil, Trash2, Plus, Folder,
    MoreVertical, UserPlus, SlidersHorizontal,
} from 'lucide-react';
import axios from 'axios';
import {
    DndContext, DragOverlay, PointerSensor, closestCenter, useDroppable,
    useSensor, useSensors,
    type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import {
    SortableContext, useSortable,
    verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ChannelInfo, CategoryInfo, ServerInfo } from '../../hooks/useServers';
import { resolveDropCategoryId, moveChannelToEndOfContainer, UNCATEGORIZED_END_ID } from './channelDrop';
import { useContextMenu } from '../../hooks/useContextMenu';
import type { ContextMenuItem } from '../primitives/ContextMenu';
import { HoverActions } from '../primitives/HoverActions';
import { ConfirmDialog, type ConfirmOptions } from '../primitives/ConfirmDialog';
import { ServerIcon } from './ServerIcon';
import { ChannelSettingsDialog } from './ChannelSettingsDialog';
import { CategoryFormDialog } from './CategoryFormDialog';
import { ChannelIconRenderer } from './ChannelIconPicker';
import { API_BASE } from '../../constants';
import { Permissions, hasPermission } from '@cipherline/shared';
import { MascotEmpty } from '../MascotEmpty';
import cipherlineMark from '../../assets/cipherline-mark.svg';
import { ClButton } from '../cl';
import { writeToClipboard } from '../../utils/clipboard';
import { useToast } from '../../contexts/ToastContext';

// ── Sortable wrappers (defined at module level — no re-creation on render) ──

/** Thin horizontal drop-indicator line rendered above or below a sortable item. */
function DropIndicator({ position = 'top' }: { position?: 'top' | 'bottom' }) {
    const posClass = position === 'top' ? 'top-0 -translate-y-1/2' : 'bottom-0 translate-y-1/2';
    return (
        <div className={`absolute ${posClass} left-1 right-1 z-30 pointer-events-none flex items-center`}>
            <div className="w-2 h-2 rounded-full bg-cl-lume shrink-0 -ml-1" />
            <div className="flex-1 h-0.5 bg-cl-lume rounded-r-full" />
        </div>
    );
}

/** Wraps a channel row — entire row is draggable, shows drop-line indicator. */
function SortableChannelItem({ channel, disabled, isDragging, dropLine, children }: {
    channel: ChannelInfo;
    disabled: boolean;
    isDragging: boolean;
    dropLine: 'top' | 'bottom' | null;
    children: React.ReactNode;
}) {
    const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
        id: `ch:${channel.channel_id}`,
        disabled,
    });
    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition }}
            className="relative"
            {...(disabled ? {} : { ...attributes, ...listeners })}
        >
            {dropLine === 'top' && <DropIndicator position="top" />}
            <div style={{ opacity: isDragging ? 0.35 : 1 }} className={disabled ? '' : 'touch-none select-none'}>
                {children}
            </div>
            {dropLine === 'bottom' && <DropIndicator position="bottom" />}
        </div>
    );
}

/**
 * Wraps a category section — the category header row is the drag activator.
 * Render prop exposes `setHeaderRef` + `headerDragProps` so the caller puts them
 * on the header div (not a separate grip button).
 */
function SortableCategorySection({ catId, disabled, isDragging, dropLine, children }: {
    catId: string;
    disabled: boolean;
    isDragging: boolean;
    dropLine: 'top' | 'bottom' | null;
    children: (
        setHeaderRef: (el: HTMLElement | null) => void,
        headerDragProps: React.HTMLAttributes<HTMLElement>,
    ) => React.ReactNode;
}) {
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({
        id: `cat:${catId}`,
        disabled,
    });
    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition }}
            className="relative"
        >
            {dropLine === 'top' && <DropIndicator position="top" />}
            <div style={{ opacity: isDragging ? 0.35 : 1 }}>
                {children(
                    setActivatorNodeRef as (el: HTMLElement | null) => void,
                    disabled ? {} : { ...attributes, ...listeners } as React.HTMLAttributes<HTMLElement>,
                )}
            </div>
            {dropLine === 'bottom' && <DropIndicator position="bottom" />}
        </div>
    );
}

/**
 * Sentinel drop target for "the very end of the uncategorized channel list".
 * Always mounted — including when the uncategorized list is empty — so
 * there is never a boundary with no valid droppable to land on (see
 * channelDrop.ts's header comment for the bug this fixes). Only meaningfully
 * sized while a channel drag is in progress; otherwise it's a hairline that
 * doesn't disturb the resting layout.
 */
function UncategorizedDropzone({ dragActive }: { dragActive: boolean }) {
    const { setNodeRef, isOver } = useDroppable({ id: UNCATEGORIZED_END_ID });
    return (
        <div
            ref={setNodeRef}
            className={`rounded-md transition-all ${
                dragActive ? (isOver ? 'h-7 my-0.5 bg-cl-lume/10 ring-1 ring-cl-lume/30' : 'h-2') : 'h-0'
            }`}
        />
    );
}

// ── Props ────────────────────────────────────────────────────────────────────

type NotifMode = 'all' | 'mentions' | 'none';

interface Props {
    server: ServerInfo;
    channels: ChannelInfo[];
    categories: CategoryInfo[];
    loading: boolean;
    activeChannelId: string | null;
    onSelectChannel: (channel: ChannelInfo) => void;
    /** Opens the per-member "Server Options" modal (notifs, nickname, retention, cache).
     *  Always rendered — all members have this. */
    onOpenMemberOptions?: () => void;
    /** Opens the full admin "Manage Server" modal. Only passed when caller has
     *  MANAGE_SERVER / MANAGE_ROLES / ADMINISTRATOR or is the owner. */
    onOpenServerSettings?: () => void;
    userId?: string | null;
    token: string | null;
    /** Caller's resolved server-level permission bitfield (0n = no perms). */
    myPermissions?: bigint;
    mutedChannelIds?: Set<string>;
    onMarkChannelRead?: (channelId: string) => void;
    unreadCounts?: Record<string, number>;
    /** @mention counts per channel — shown as amber badge, always visible regardless of server mute. */
    mentionCounts?: Record<string, number>;
    /** Effective server-level notification mode (after applying user's server pref). */
    serverNotifMode?: NotifMode;
    onChannelsChanged?: () => void;
    onDeleteChannelApi?: (channel: ChannelInfo) => Promise<void>;
    onDeleteCategoryApi?: (category: CategoryInfo) => Promise<void>;
    onOpenInvite?: () => void;
    /** Fired after a successful text/voice channel create (not edit). */
    onChannelCreated?: (channel: ChannelInfo) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export const ServerChannelList: React.FC<Props> = ({
    server, channels, categories, loading,
    activeChannelId, onSelectChannel, onOpenServerSettings, onOpenMemberOptions,
    token, userId, myPermissions = 0n,
    mutedChannelIds, onMarkChannelRead, unreadCounts,
    mentionCounts, serverNotifMode = 'all',
    onChannelsChanged, onDeleteChannelApi, onDeleteCategoryApi, onOpenInvite,
    onChannelCreated,
}) => {
    const ctx = useContextMenu();
    const toast = useToast();
    // canManage: true when the caller has MANAGE_CHANNELS or ADMINISTRATOR.
    // The API returns ALL_PERMISSIONS for the server owner, so owners pass too.
    const canManage = !!userId && (
        hasPermission(myPermissions, Permissions.MANAGE_CHANNELS) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );

    // ── Local state for optimistic DnD updates ──────────────────────────
    // Sorted by position initially; updated by DnD then re-synced from props.
    const [localChannels, setLocalChannels] = useState<ChannelInfo[]>(() =>
        [...channels].sort((a, b) => a.position - b.position)
    );
    const [localCategories, setLocalCategories] = useState<CategoryInfo[]>(() =>
        categories.filter(c => !c.kind || c.kind === 'text').sort((a, b) => a.position - b.position)
    );

    // Refs: always current values, safe to read inside DnD callbacks.
    const localChannelsRef = useRef(localChannels);
    const localCategoriesRef = useRef(localCategories);
    const backupRef = useRef({ channels: localChannels, categories: localCategories });

    useEffect(() => {
        const sorted = [...channels].sort((a, b) => a.position - b.position);
        setLocalChannels(sorted);
        localChannelsRef.current = sorted;
        backupRef.current.channels = sorted;
    }, [channels]);

    useEffect(() => {
        const textCats = categories
            .filter(c => !c.kind || c.kind === 'text')
            .sort((a, b) => a.position - b.position);
        setLocalCategories(textCats);
        localCategoriesRef.current = textCats;
        backupRef.current.categories = textCats;
    }, [categories]);

    // ── Inline form dialog state ─────────────────────────────────────────
    const [channelDialog, setChannelDialog] = useState<
        | { mode: 'create'; defaultCategoryId: string | null; defaultKind: 'text' }
        | { mode: 'edit'; channel: ChannelInfo }
        | null
    >(null);
    const [categoryDialog, setCategoryDialog] = useState<
        | { mode: 'create' }
        | { mode: 'edit'; category: CategoryInfo }
        | null
    >(null);
    const [pendingConfirm, setPendingConfirm] = useState<ConfirmOptions | null>(null);

    const createMenu = useContextMenu();

    // ── Category collapse state ──────────────────────────────────────────
    const collapseKey = userId ? `cipherline_category_collapsed_${userId}_${server.server_id}` : null;
    const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>(() => {
        if (!collapseKey) return {};
        try { return JSON.parse(secureLocalStore.getItem(collapseKey) || '{}'); } catch { return {}; }
    });
    useEffect(() => {
        if (!collapseKey) { setCollapsedCats({}); return; }
        try { setCollapsedCats(JSON.parse(secureLocalStore.getItem(collapseKey) || '{}')); } catch { setCollapsedCats({}); }
    }, [collapseKey]);

    const toggleCategory = (id: string) => {
        setCollapsedCats(prev => {
            const next = { ...prev, [id]: !prev[id] };
            if (collapseKey) {
                try { secureLocalStore.setItem(collapseKey, JSON.stringify(next)); } catch { /* full / disabled */ }
            }
            return next;
        });
    };

    // ── DnD setup ────────────────────────────────────────────────────────
    const [activeId, setActiveId] = useState<string | null>(null);
    const [overId,   setOverId]   = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    );

    function onDragStart({ active }: DragStartEvent) {
        setActiveId(active.id as string);
        setOverId(null);
        backupRef.current = {
            channels: localChannelsRef.current,
            categories: localCategoriesRef.current,
        };
    }

    function onDragOver({ active, over }: DragOverEvent) {
        setOverId(over ? (over.id as string) : null);
        if (!over || !canManage) return;
        const dragId = active.id as string;
        if (!dragId.startsWith('ch:')) return; // categories don't need live cross-container

        const channelId = dragId.slice(3);
        const chs = localChannelsRef.current;
        const activeCh = chs.find(c => c.channel_id === channelId);
        if (!activeCh) return;

        const currentCatId = activeCh.parent_category_id ?? null;
        const overId = over.id as string;

        const resolved = resolveDropCategoryId(overId, chs);
        const targetCatId: string | null = resolved === undefined ? currentCatId : resolved;

        if (targetCatId === currentCatId) return;

        // Move to new container (optimistic)
        const targetChs = chs.filter(c => c.kind === 'text' && (c.parent_category_id ?? null) === targetCatId);
        const newPos = targetChs.length > 0
            ? Math.max(...targetChs.map(c => c.position)) + 1000
            : 1000;

        const newChannels = chs.map(c =>
            c.channel_id === channelId
                ? { ...c, parent_category_id: targetCatId, position: newPos }
                : c
        );
        setLocalChannels(newChannels);
        localChannelsRef.current = newChannels;
    }

    function onDragEnd({ active, over }: DragEndEvent) {
        setActiveId(null);
        setOverId(null);

        if (!over || !canManage) {
            // Cancelled — revert
            setLocalChannels(backupRef.current.channels);
            localChannelsRef.current = backupRef.current.channels;
            setLocalCategories(backupRef.current.categories);
            localCategoriesRef.current = backupRef.current.categories;
            return;
        }

        const dragId = active.id as string;
        const overId = over.id as string;
        if (dragId === overId) return;

        const chs = localChannelsRef.current;
        const cats = localCategoriesRef.current;

        // ── Category reorder ───────────────────────────────────────────
        if (dragId.startsWith('cat:') && overId.startsWith('cat:')) {
            const activeIdx = cats.findIndex(c => c.category_id === dragId.slice(4));
            const overIdx   = cats.findIndex(c => c.category_id === overId.slice(4));
            if (activeIdx === -1 || overIdx === -1) return;

            const newCats = arrayMove(cats, activeIdx, overIdx).map((c, i) => ({
                ...c, position: (i + 1) * 1000,
            }));
            setLocalCategories(newCats);
            localCategoriesRef.current = newCats;

            axios.patch(`${API_BASE}/servers/${server.server_id}/categories/reorder`, {
                category_ids: newCats.map(c => c.category_id),
            }, { headers: { Authorization: `Bearer ${token}` } })
                .then(() => onChannelsChanged?.())
                .catch(() => {
                    setLocalCategories(backupRef.current.categories);
                    localCategoriesRef.current = backupRef.current.categories;
                });
            return;
        }

        // ── Channel reorder / move ─────────────────────────────────────
        if (dragId.startsWith('ch:')) {
            const channelId = dragId.slice(3);
            const activeCh = chs.find(c => c.channel_id === channelId);
            if (!activeCh) return;

            const catId = activeCh.parent_category_id ?? null;
            let finalChannels = chs;

            // Explicit "drop at the very end of the uncategorized list" target.
            // By this point `catId` is already null — either it was already
            // uncategorized (a same-container move-to-bottom, which the
            // same-container `ch:`-over-`ch:` branch below can't express
            // because there's no item below the last one to hover over), or
            // onDragOver already relocated it here as part of a cross-
            // container move (in which case this just guarantees it lands
            // LAST rather than wherever the optimistic append put it).
            if (overId === UNCATEGORIZED_END_ID && catId === null) {
                const containerChans = chs
                    .filter(c => c.kind === 'text' && (c.parent_category_id ?? null) === null)
                    .sort((a, b) => a.position - b.position);
                const reordered = moveChannelToEndOfContainer(containerChans, channelId);
                finalChannels = [
                    ...chs.filter(c => !(c.kind === 'text' && (c.parent_category_id ?? null) === null)),
                    ...reordered,
                ];
                setLocalChannels(finalChannels);
                localChannelsRef.current = finalChannels;
            } else if (overId.startsWith('ch:')) {
                const overChannelId = overId.slice(3);
                const overCh = chs.find(c => c.channel_id === overChannelId);

                if (overCh && (overCh.parent_category_id ?? null) === catId) {
                    const containerChans = chs
                        .filter(c => c.kind === 'text' && (c.parent_category_id ?? null) === catId)
                        .sort((a, b) => a.position - b.position);
                    const fromIdx = containerChans.findIndex(c => c.channel_id === channelId);
                    const toIdx   = containerChans.findIndex(c => c.channel_id === overChannelId);

                    if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                        const reordered = arrayMove(containerChans, fromIdx, toIdx)
                            .map((c, i) => ({ ...c, position: (i + 1) * 1000 }));
                        finalChannels = [
                            ...chs.filter(c => !(c.kind === 'text' && (c.parent_category_id ?? null) === catId)),
                            ...reordered,
                        ];
                        setLocalChannels(finalChannels);
                        localChannelsRef.current = finalChannels;
                    }
                }
            }

            // Build full ordered text-channel list for the API
            const sortedCats = [...cats].sort((a, b) => a.position - b.position);
            const uncatChans = finalChannels
                .filter(c => c.kind === 'text' && !c.parent_category_id)
                .sort((a, b) => a.position - b.position);
            const catChans = sortedCats.flatMap(cat =>
                finalChannels
                    .filter(c => c.kind === 'text' && c.parent_category_id === cat.category_id)
                    .sort((a, b) => a.position - b.position)
            );

            const items = [...uncatChans, ...catChans].map(c => ({
                channel_id: c.channel_id,
                parent_category_id: c.parent_category_id ?? null,
            }));
            if (items.length === 0) return;

            axios.patch(`${API_BASE}/servers/${server.server_id}/channels/reorder`, { items }, {
                headers: { Authorization: `Bearer ${token}` },
            })
                .then(() => onChannelsChanged?.())
                .catch(() => {
                    setLocalChannels(backupRef.current.channels);
                    localChannelsRef.current = backupRef.current.channels;
                });
        }
    }

    // ── Drop-line helper ─────────────────────────────────────────────────
    /** Returns 'top' | 'bottom' | null for the drop indicator on `itemKey`. */
    const getDropLine = (
        itemKey: string,
        containerKeys: string[],
    ): 'top' | 'bottom' | null => {
        if (!activeId || overId !== itemKey) return null;
        const aIdx = containerKeys.indexOf(activeId);
        const oIdx = containerKeys.indexOf(itemKey);
        if (oIdx === -1) return null;
        // Dragging from above (or cross-container) → drop below; dragging from below → drop above
        return (aIdx === -1 || aIdx < oIdx) ? 'bottom' : 'top';
    };

    // ── Group channels ───────────────────────────────────────────────────
    // Uses localChannels / localCategories so DnD optimistic updates are reflected.
    const groups = useMemo(() => {
        const text = localChannels.filter(c => c.kind === 'text').sort((a, b) => a.position - b.position);
        const uncategorized = text.filter(c => !c.parent_category_id);
        const byCat: Record<string, ChannelInfo[]> = {};
        for (const c of text) {
            if (c.parent_category_id) (byCat[c.parent_category_id] ||= []).push(c);
        }
        return { uncategorized, sortedCats: localCategories, byCat };
    }, [localChannels, localCategories]);

    // ── Context menu builders ────────────────────────────────────────────
    const buildChannelMenu = (ch: ChannelInfo): ContextMenuItem[] => {
        const hasUnread = ((unreadCounts?.[ch.channel_id] ?? 0) + (mentionCounts?.[ch.channel_id] ?? 0)) > 0;
        return [
            ...(onMarkChannelRead ? [{
                icon: <CheckCheck />, label: 'Mark as Read',
                disabled: !hasUnread,
                onSelect: () => onMarkChannelRead(ch.channel_id),
            }] : []),
            {
                icon: <LinkIcon />, label: 'Copy Channel ID',
                onSelect: () => writeToClipboard(ch.channel_id).catch(() => toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })),
            },
            ...(canManage ? [
                { divider: true as const },
                {
                    icon: <Pencil />, label: 'Edit Channel',
                    onSelect: () => setChannelDialog({ mode: 'edit', channel: ch }),
                },
                ...(onDeleteChannelApi ? [{
                    icon: <Trash2 />, label: 'Delete Channel', danger: true,
                    onSelect: () => setPendingConfirm({
                        title: `Delete "#${ch.name}"?`,
                        message: 'This channel will be permanently removed.',
                        confirmLabel: 'Delete',
                        onConfirm: async () => {
                            try { await onDeleteChannelApi(ch); onChannelsChanged?.(); }
                            catch (e) { console.error('[ServerChannelList] delete channel:', e); }
                        },
                    }),
                }] : []),
            ] : []),
        ];
    };

    // Every item here is a MANAGE_CHANNELS-gated action (create/edit/delete),
    // so the whole menu is empty for a member who lacks it — the server
    // still refuses these calls independently; this is UX only. "Create
    // Channel Here" used to sit outside the canManage check (only Edit/Delete
    // were gated), so any member could right-click a category header and see
    // the option, even though POST /channels would 403.
    const buildCategoryMenu = (cat: CategoryInfo): ContextMenuItem[] => (canManage ? [
        {
            icon: <Plus />, label: 'Create Channel Here',
            onSelect: () => setChannelDialog({ mode: 'create', defaultCategoryId: cat.category_id, defaultKind: 'text' }),
        },
        { divider: true as const },
        {
            icon: <Pencil />, label: 'Edit Category',
            onSelect: () => setCategoryDialog({ mode: 'edit', category: cat }),
        },
        ...(onDeleteCategoryApi ? [{
            icon: <Trash2 />, label: 'Delete Category', danger: true,
            onSelect: () => setPendingConfirm({
                title: `Delete "${cat.name}"?`,
                message: 'Channels inside will become uncategorized.',
                confirmLabel: 'Delete',
                onConfirm: async () => {
                    try { await onDeleteCategoryApi(cat); onChannelsChanged?.(); }
                    catch (e) { console.error('[ServerChannelList] delete category:', e); }
                },
            }),
        }] : []),
    ] : []);

    // ── Render helpers ───────────────────────────────────────────────────
    // Menu vocabulary (selm/ctxm): active rows glow lume, hover is a faint
    // lume wash — not the flat raise box.
    const channelRowCls = (channelId: string) =>
        `group flex items-center gap-2 px-2 py-1.5 rounded-[9px] cursor-pointer transition-all text-sm select-none relative ${
            activeChannelId === channelId
                ? 'bg-cl-lume/10 text-cl-lume font-semibold'
                : 'text-cl-muted font-medium hover:text-cl-text hover:bg-cl-lume/[0.06]'
        }`;

    const renderChannelRow = (ch: ChannelInfo) => {
        const isMuted = mutedChannelIds?.has(ch.channel_id) ?? false;
        const isChannelMuted = serverNotifMode === 'none' || isMuted;
        const unread = unreadCounts?.[ch.channel_id] ?? 0;
        const mentions = mentionCounts?.[ch.channel_id] ?? 0;
        const hasUnread = unread > 0 && !isChannelMuted;
        const hasMention = mentions > 0;
        // Quiet (grey) rather than lume when pings are off for this server but
        // it is NOT muted: "there is something new here" without claiming it
        // wants attention. Muted is handled by isChannelMuted above, which
        // suppresses the plain-unread badge entirely — an @mention still gets
        // its own badge either way.
        const quietUnread = serverNotifMode === 'mentions';
        return (
            <div
                key={ch.channel_id}
                onClick={() => onSelectChannel(ch)}
                onContextMenu={(e) => ctx.open(e, buildChannelMenu(ch), `${ch.icon_emoji ?? '#'} ${ch.name}`)}
                className={channelRowCls(ch.channel_id)}
                title={ch.topic ?? ch.name}
            >
                {ch.icon_name ? (
                    <ChannelIconRenderer
                        name={ch.icon_name}
                        size={16}
                        className={`shrink-0 ${activeChannelId === ch.channel_id ? 'text-cl-lume' : 'text-cl-faint group-hover:text-cl-muted'}`}
                    />
                ) : ch.icon_emoji ? (
                    <span className="shrink-0 text-[15px] leading-none w-4 text-center">{ch.icon_emoji}</span>
                ) : (
                    <Hash
                        size={16}
                        className={`shrink-0 ${activeChannelId === ch.channel_id ? 'text-cl-lume' : 'text-cl-faint group-hover:text-cl-muted'}`}
                    />
                )}
                <span className={`truncate flex-1 ${isChannelMuted ? 'opacity-50' : ''}`}>{ch.name}</span>
                {/* @mention badge — always shown regardless of mute */}
                {hasMention && activeChannelId !== ch.channel_id && (
                    <span className="ml-auto min-w-[16px] h-4 px-0.5 rounded-full bg-cl-flash text-cl-text text-[9px] font-bold flex items-center justify-center group-hover:opacity-0 transition-opacity shrink-0">
                        {mentions > 99 ? '99+' : mentions}
                    </span>
                )}
                {/* Unread badge — only when not muted and no mention badge */}
                {/* @mentions-only draws a plain grey dot, no number: there is
                    something new, but the user asked not to be pinged for it.
                    Same treatment as the rail (components/RailBadge.tsx). */}
                {hasUnread && !hasMention && activeChannelId !== ch.channel_id && (quietUnread ? (
                    <span
                        role="img"
                        aria-label="Unread"
                        className="ml-auto mr-1 w-2 h-2 rounded-full bg-cl-faint group-hover:opacity-0 transition-opacity shrink-0"
                    />
                ) : (
                    <span
                        className="ml-auto w-4 h-4 rounded-full bg-cl-lume text-[9px] font-bold flex items-center justify-center group-hover:opacity-0 transition-opacity shrink-0"
                        style={{ color: 'var(--cl-on-lume)' }}
                    >
                        {unread > 99 ? '99+' : unread}
                    </span>
                ))}
            </div>
        );
    };

    // ── Active drag overlay (ghost item) ─────────────────────────────────
    const activeChannel = activeId?.startsWith('ch:')
        ? localChannels.find(c => c.channel_id === activeId.slice(3)) ?? null
        : null;
    const activeCat = activeId?.startsWith('cat:')
        ? localCategories.find(c => c.category_id === activeId.slice(4)) ?? null
        : null;

    if (loading && channels.length === 0 && categories.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-white/20 border-t-cl-lume rounded-full animate-spin" />
            </div>
        );
    }

    const hasBanner = !!(server.banner_attachment && server.banner_key_b64 && server.banner_nonce_b64);
    const isEmpty = channels.length === 0 && categories.length === 0;

    return (
        <div className="flex flex-col h-full w-full overflow-hidden min-w-0">
            {/* ── Masthead — the server's flag. Banner servers fly their photo;
                   bannerless ones get the lume-glow + watermark identity strip
                   (same placeholder language as the DM context card). Actions are
                   QUIET flat icons (msgbar vocabulary), not solid kit capsules —
                   three primary buttons in a header is a wall of chrome. ── */}
            <div className={`relative shrink-0 w-full overflow-hidden ${hasBanner ? 'h-36' : 'h-[92px]'}`}>
                {hasBanner ? (
                    <ServerIcon
                        serverId={server.server_id}
                        name={server.name}
                        attachmentId={server.banner_attachment}
                        keyB64={server.banner_key_b64}
                        nonceB64={server.banner_nonce_b64}
                        token={token}
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div
                        className="absolute inset-0 flex items-center justify-center"
                        style={{ background: 'radial-gradient(150px 100px at 50% 135%, var(--cl-lume-tint), transparent 72%), var(--cl-sink)' }}
                    >
                        <img src={cipherlineMark} alt="" width={34} style={{ opacity: 0.14, marginBottom: 18 }} />
                    </div>
                )}
                {/* Gradient so the title blends naturally into the list below */}
                <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-cl-deep via-cl-deep/70 to-transparent pointer-events-none ${hasBanner ? 'h-24' : 'h-14'}`} />
                {/* Title + quiet actions overlaid on the gradient */}
                <div className="absolute inset-x-0 bottom-0 flex items-end justify-between px-3 pb-2 gap-1.5">
                    <h2
                        className="text-[18px] font-semibold text-cl-text truncate flex-1 leading-tight m-0"
                        style={{ fontFamily: 'var(--cl-font-display)', textShadow: '0 1px 10px rgba(0,0,0,0.7)' }}
                    >
                        {server.name}
                    </h2>
                    <div className="flex items-center gap-0.5 shrink-0">
                        {onOpenInvite && (
                            <button
                                type="button"
                                className="msgbar-btn"
                                title="Invite People"
                                aria-label="Invite People"
                                onClick={onOpenInvite}
                                /* Invite is the one primary action here — it keeps a lume tint at rest. */
                                style={{ color: 'var(--cl-lume)', background: 'rgba(37,224,200,.10)' }}
                            >
                                <UserPlus size={15} />
                            </button>
                        )}
                        {onOpenMemberOptions && (
                            <button type="button" className="msgbar-btn" title="Server Options" aria-label="Server Options" onClick={onOpenMemberOptions}>
                                <SlidersHorizontal size={15} />
                            </button>
                        )}
                        {onOpenServerSettings && (
                            <button type="button" className="msgbar-btn" title="Manage Server" aria-label="Manage Server" onClick={onOpenServerSettings}>
                                <Settings size={15} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <DndContext
                sensors={sensors}
                // dnd-kit's own recommendation for sortable lists. The default
                // `rectIntersection` requires the dragged rect to literally
                // overlap a droppable's rect, which leaves a dead zone past
                // the last item in a list (and in any gap between sections) —
                // that dead zone was the reason a channel could never be
                // dropped at the very BOTTOM of the uncategorized list.
                // `closestCenter` always resolves to the nearest droppable's
                // center, so there is no boundary with no valid target.
                collisionDetection={closestCenter}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragEnd={onDragEnd}
            >
                <div
                    className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-4 custom-scrollbar"
                    onContextMenu={(e) => {
                        if (!canManage) return;
                        createMenu.open(e, [
                            { icon: <Hash />,   label: 'Create Channel',
                              onSelect: () => setChannelDialog({ mode: 'create', defaultCategoryId: null, defaultKind: 'text' }) },
                            { icon: <Folder />, label: 'Create Category',
                              onSelect: () => setCategoryDialog({ mode: 'create' }) },
                        ]);
                    }}
                >
                    {isEmpty ? (
                        <MascotEmpty
                            title="No channels yet"
                            sub={canManage
                                ? 'Every channel is end-to-end encrypted. Raise the first one.'
                                : 'Wait for an admin to add some — they’ll be encrypted like everything else.'}
                        >
                            {canManage && (
                                <ClButton
                                    size="sm"
                                    onClick={() => setChannelDialog({ mode: 'create', defaultCategoryId: null, defaultKind: 'text' })}
                                >
                                    <Plus size={12} /> Create your first channel
                                </ClButton>
                            )}
                        </MascotEmpty>
                    ) : (
                        <>
                            {/* Uncategorized channels */}
                            <SortableContext
                                items={groups.uncategorized.map(c => `ch:${c.channel_id}`)}
                                strategy={verticalListSortingStrategy}
                            >
                                {groups.uncategorized.map(ch => {
                                    const key = `ch:${ch.channel_id}`;
                                    const keys = groups.uncategorized.map(c => `ch:${c.channel_id}`);
                                    return (
                                        <SortableChannelItem
                                            key={ch.channel_id}
                                            channel={ch}
                                            disabled={!canManage}
                                            isDragging={activeId === key}
                                            dropLine={getDropLine(key, keys)}
                                        >
                                            {renderChannelRow(ch)}
                                        </SortableChannelItem>
                                    );
                                })}
                            </SortableContext>
                            {canManage && (
                                <UncategorizedDropzone dragActive={!!activeId && activeId.startsWith('ch:')} />
                            )}

                            {/* Categories */}
                            <SortableContext
                                items={groups.sortedCats.map(c => `cat:${c.category_id}`)}
                                strategy={verticalListSortingStrategy}
                            >
                                {groups.sortedCats.map(cat => {
                                    const catChannels = groups.byCat[cat.category_id] ?? [];
                                    const collapsed = !!collapsedCats[cat.category_id];
                                    const catKey  = `cat:${cat.category_id}`;
                                    const catKeys = groups.sortedCats.map(c => `cat:${c.category_id}`);
                                    return (
                                        <SortableCategorySection
                                            key={cat.category_id}
                                            catId={cat.category_id}
                                            disabled={!canManage}
                                            isDragging={activeId === catKey}
                                            dropLine={getDropLine(catKey, catKeys)}
                                        >
                                            {(setHeaderRef, headerDragProps) => (
                                                <div className="mt-4">
                                                    {/* Entire header row is the drag activator */}
                                                    <div
                                                        ref={canManage ? setHeaderRef : undefined}
                                                        {...(canManage ? headerDragProps : {})}
                                                        className={`group flex items-center gap-2 w-full px-2 pt-0.5 pb-0 rounded relative hover:bg-cl-raise/40 transition-colors ${canManage ? 'cursor-grab active:cursor-grabbing select-none touch-none' : 'cursor-pointer'}`}
                                                        onContextMenu={(e) => {
                                                            e.stopPropagation();
                                                            // No actionable items for a member without MANAGE_CHANNELS —
                                                            // don't pop an empty menu.
                                                            if (!canManage) { e.preventDefault(); return; }
                                                            ctx.open(e, buildCategoryMenu(cat), cat.name);
                                                        }}
                                                        onClick={() => toggleCategory(cat.category_id)}
                                                    >
                                                        <span className="shrink-0 text-cl-faint group-hover:text-cl-text transition-colors w-4 flex items-center justify-center">
                                                            {collapsed
                                                                ? <ChevronRight size={16} />
                                                                : <ChevronDown  size={16} />}
                                                        </span>
                                                        {cat.icon_name && (
                                                            <ChannelIconRenderer
                                                                name={cat.icon_name}
                                                                size={13}
                                                                className="shrink-0 text-cl-faint group-hover:text-cl-muted transition-colors"
                                                            />
                                                        )}
                                                        <span
                                                            className="truncate flex-1 text-[10px] font-semibold uppercase text-cl-faint group-hover:text-cl-muted transition-colors"
                                                            style={{ fontFamily: 'var(--cl-font-mono)', letterSpacing: '1.1px' }}
                                                        >
                                                            {cat.name}
                                                        </span>
                                                        {canManage && (
                                                            <HoverActions
                                                                actions={[
                                                                    {
                                                                        icon: <Plus />, label: 'Create channel here',
                                                                        onClick: () => setChannelDialog({ mode: 'create', defaultCategoryId: cat.category_id, defaultKind: 'text' }),
                                                                    },
                                                                    {
                                                                        icon: <MoreVertical />, label: 'Category options',
                                                                        onClick: (e: React.MouseEvent) => { e.stopPropagation(); ctx.open(e, buildCategoryMenu(cat), cat.name); },
                                                                    },
                                                                ]}
                                                            />
                                                        )}
                                                    </div>
                                                    {!collapsed && (
                                                        <div>
                                                            <SortableContext
                                                                items={catChannels.map(c => `ch:${c.channel_id}`)}
                                                                strategy={verticalListSortingStrategy}
                                                            >
                                                                {catChannels.map(ch => {
                                                                    const chKey  = `ch:${ch.channel_id}`;
                                                                    const chKeys = catChannels.map(c => `ch:${c.channel_id}`);
                                                                    return (
                                                                        <SortableChannelItem
                                                                            key={ch.channel_id}
                                                                            channel={ch}
                                                                            disabled={!canManage}
                                                                            isDragging={activeId === chKey}
                                                                            dropLine={getDropLine(chKey, chKeys)}
                                                                        >
                                                                            {renderChannelRow(ch)}
                                                                        </SortableChannelItem>
                                                                    );
                                                                })}
                                                            </SortableContext>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </SortableCategorySection>
                                    );
                                })}
                            </SortableContext>
                        </>
                    )}
                </div>

                {/* Drag overlay — ghost of the item being dragged */}
                <DragOverlay dropAnimation={null}>
                    {activeChannel && (
                        <div className="opacity-80 pointer-events-none shadow-2xl">
                            {renderChannelRow(activeChannel)}
                        </div>
                    )}
                    {activeCat && (
                        <div className="opacity-80 pointer-events-none shadow-2xl px-2 py-0.5 text-[12px] font-medium text-cl-muted bg-cl-deep rounded border border-cl-border">
                            {activeCat.name}
                        </div>
                    )}
                </DragOverlay>
            </DndContext>

            {/* Inline dialogs */}
            {channelDialog && (
                <ChannelSettingsDialog
                    serverId={server.server_id}
                    token={token}
                    channel={channelDialog.mode === 'edit' ? channelDialog.channel : null}
                    defaultCategoryId={channelDialog.mode === 'create' ? channelDialog.defaultCategoryId : undefined}
                    defaultKind={channelDialog.mode === 'create' ? channelDialog.defaultKind : undefined}
                    categories={categories}
                    canManage={true}
                    ownerUserId={server.owner_user_id}
                    currentUserId={userId ?? null}
                    myPermissions={myPermissions}
                    channels={channels}
                    onClose={() => setChannelDialog(null)}
                    onSaved={() => { setChannelDialog(null); onChannelsChanged?.(); }}
                    onCreated={onChannelCreated}
                    onCreatedKeepOpen={() => onChannelsChanged?.()}
                    onDelete={onDeleteChannelApi ? async (ch) => {
                        try { await onDeleteChannelApi(ch); setChannelDialog(null); onChannelsChanged?.(); }
                        catch (e) { console.error('[ServerChannelList] delete channel:', e); }
                    } : undefined}
                />
            )}
            {categoryDialog && (
                <CategoryFormDialog
                    serverId={server.server_id}
                    token={token}
                    category={categoryDialog.mode === 'edit' ? categoryDialog.category : null}
                    kind="text"
                    ownerUserId={server.owner_user_id}
                    currentUserId={userId ?? null}
                    myPermissions={myPermissions}
                    categories={categories}
                    channels={channels}
                    onClose={() => setCategoryDialog(null)}
                    onSaved={() => onChannelsChanged?.()}
                    onDelete={onDeleteCategoryApi ? async (cat) => {
                        try { await onDeleteCategoryApi(cat); onChannelsChanged?.(); }
                        catch (e) { console.error('[ServerChannelList] delete category:', e); }
                    } : undefined}
                />
            )}

            {pendingConfirm && (
                <ConfirmDialog
                    {...pendingConfirm}
                    onConfirm={() => { pendingConfirm.onConfirm(); setPendingConfirm(null); }}
                    onCancel={() => setPendingConfirm(null)}
                />
            )}

            {ctx.menu}
            {createMenu.menu}
        </div>
    );
};

export default ServerChannelList;
