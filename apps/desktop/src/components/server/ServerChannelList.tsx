/**
 * ServerChannelList — Pane 2 for a server view.
 *
 * Renders, top-to-bottom:
 *   1. Optional banner image (when server.banner_attachment is set)
 *   2. Server name + Settings (gear)
 *   3. The top of the list: uncategorized text channels and dividers
 *   4. For each top-level ChannelCategory: a collapsible section with header
 *      + hover-revealed `+ add channel` and `⋯ category options` buttons,
 *      then its items - channels, dividers and SUB-CATEGORIES (one level;
 *      each collapsible on its own, indented with a guide line) - in one
 *      order (channelTree.ts).
 *
 * Dividers are purely visual (ChannelDividerRow); every divider the server
 * sends is drawn where it was placed (channelTree.dividerVisibility).
 *
 * Drag-and-drop (canManage only):
 *   • Drag channels, dividers and sub-categories anywhere they may live; the
 *     drop is planned once, from the layout at drag start (layoutDrop.ts),
 *     applied optimistically and saved with PATCH .../channel-layout.
 *     A sub-category may only sit inside a top-level category: over the top
 *     of the list its drop line / zone and ghost turn red (not-allowed
 *     cursor + inline hint), and releasing there explains why in a dialog
 *     instead of moving it (layoutDrop.decideLayoutDrop).
 *   • Drag category headers to reorder top-level categories.
 *   • Activation threshold is 8 px so clicks still work normally.
 */

import secureLocalStore from '../../utils/secureLocalStore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Hash, ChevronDown, ChevronRight, Settings, ShieldAlert,
    CheckCheck, Link as LinkIcon, Pencil, Trash2, Plus, Folder,
    MoreVertical, UserPlus, SlidersHorizontal, CornerDownRight, Minus, Ban,
} from 'lucide-react';
import axios from 'axios';
import {
    DndContext, DragOverlay, MeasuringStrategy, PointerSensor, useDroppable,
    useSensor, useSensors,
    type DragEndEvent, type DragOverEvent, type DragStartEvent, type Active, type Over,
} from '@dnd-kit/core';
import {
    SortableContext, useSortable,
    verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ChannelInfo, CategoryInfo, DividerInfo, ServerInfo } from '../../hooks/useServers';
import { UNCATEGORIZED_END_ID } from './channelDrop';
import { buildChannelTree, channelsIn, dividerAriaLabel, dividerVisibility, parseItemKey, type TreeItem, type TreeLeaf, type TreeSub } from './channelTree';
import { decideLayoutDrop, layoutOrderFromTree, layoutPatchBody, applyPlanPositions, layoutCollisionDetection, type DropPlace, type LayoutOrder } from './layoutDrop';
import type { ChannelOptimism } from './ChannelSettingsDialog';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useChannelMutes } from '../../contexts/ChannelMuteContext';
import { effectiveMutedChannels } from '../../utils/channelMute';
import { buildMuteItems, MutedGlyph } from './muteMenu';
import type { ContextMenuItem } from '../primitives/ContextMenu';
import { HoverActions } from '../primitives/HoverActions';
import { ConfirmDialog, type ConfirmOptions } from '../primitives/ConfirmDialog';
import { ServerIcon } from './ServerIcon';
import { ChannelSettingsDialog } from './ChannelSettingsDialog';
import { CategoryFormDialog } from './CategoryFormDialog';
import { DividerFormDialog, type DividerValues } from './DividerFormDialog';
import { ChannelDividerVisual, DividerHitArea } from './ChannelDividerRow';
import { ChannelIconRenderer } from './ChannelIconPicker';
import { apiUrl } from '../../utils/apiPath';
import { Permissions, hasPermission } from '@cipherline/shared';
import { MascotEmpty } from '../MascotEmpty';
import cipherlineMark from '../../assets/cipherline-mark.svg';
import { ClButton } from '../cl';
import { writeToClipboard } from '../../utils/clipboard';
import { useToast } from '../../contexts/ToastContext';
import { hoverPrefetchChannelViewers, cancelHoverPrefetch } from '../../utils/channelViewerCache';
import { revealChannelRow } from '../../utils/channelRefs';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { buildUnreadModel, channelBadgeKind, channelKey, categoryKey, strongerKind, type UnreadKind } from './offscreenUnread';
import { useOffscreenUnread } from './useOffscreenUnread';
import { OffscreenUnreadPill } from './OffscreenUnreadPill';
import { categoryDeleteConfirm, categoryRestrictsView, categoryContents, expectedCounts, type CategoryContents, type CategoryDeleteConfirm } from './categoryDelete';
import { CategoryDeleteDialog } from './CategoryDeleteDialog';
import { CategoryHeading } from './CategoryHeading';
import { categoryDividerLook, CATEGORY_HEADER_ACTIONS_CLASS } from './categoryHeadingStyle';
import { overrideFromWire, roleFromWire } from './channelPerms/effectivePermissions';

// ── Sortable wrappers (defined at module level — no re-creation on render) ──

/**
 * Thin horizontal drop-indicator line rendered above or below a sortable item.
 * `refused`: the dragged item cannot land here (a sub-category over the top of
 * the list), drawn in the danger colour instead of the accent.
 */
function DropIndicator({ position = 'top', refused = false }: { position?: 'top' | 'bottom'; refused?: boolean }) {
    const posClass = position === 'top' ? 'top-0 -translate-y-1/2' : 'bottom-0 translate-y-1/2';
    const tone = refused ? 'bg-cl-flash' : 'bg-cl-lume';
    return (
        <div
            className={`absolute ${posClass} left-1 right-1 z-30 pointer-events-none flex items-center`}
            data-drop-indicator={refused ? 'refused' : 'ok'}
        >
            <div className={`w-2 h-2 rounded-full ${tone} shrink-0 -ml-1`} />
            <div className={`flex-1 h-0.5 ${tone} rounded-r-full`} />
        </div>
    );
}

/** Wraps a channel or divider row — the entire row is draggable, shows the drop line. */
function SortableLeaf({ id, disabled, isDragging, dropLine, dropRefused = false, children }: {
    id: string;
    disabled: boolean;
    isDragging: boolean;
    dropLine: 'top' | 'bottom' | null;
    /** The drop line marks a spot the dragged item cannot land (drawn red). */
    dropRefused?: boolean;
    children: React.ReactNode;
}) {
    const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id, disabled });
    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition }}
            className="relative"
            {...(disabled ? {} : { ...attributes, ...listeners })}
        >
            {dropLine === 'top' && <DropIndicator position="top" refused={dropRefused} />}
            <div style={{ opacity: isDragging ? 0.35 : 1 }} className={disabled ? '' : 'touch-none select-none'}>
                {children}
            </div>
            {dropLine === 'bottom' && <DropIndicator position="bottom" refused={dropRefused} />}
        </div>
    );
}

/**
 * Wraps a category section or a sub-category block — the header row is the
 * drag activator. Render prop exposes `setHeaderRef` + `headerDragProps` so
 * the caller puts them on the header (not a separate grip button).
 */
function SortableSection({ id, disabled, isDragging, dropLine, children }: {
    id: string;
    disabled: boolean;
    isDragging: boolean;
    dropLine: 'top' | 'bottom' | null;
    children: (
        setHeaderRef: (el: HTMLElement | null) => void,
        headerDragProps: React.HTMLAttributes<HTMLElement>,
    ) => React.ReactNode;
}) {
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({ id, disabled });
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
 * sized while a drag is in progress; otherwise it's a hairline that doesn't
 * disturb the resting layout.
 */
function UncategorizedDropzone({ dragActive, overHere = false, refused = false }: {
    dragActive: boolean;
    /** The list's own over-tracking (onDragOver) says the pointer is here - the same signal `refused` comes from. */
    overHere?: boolean;
    /** The dragged item cannot land here (a sub-category): drawn red. */
    refused?: boolean;
}) {
    const { setNodeRef, isOver: dndOver } = useDroppable({ id: UNCATEGORIZED_END_ID });
    const isOver = dndOver || overHere;
    return (
        <div
            ref={setNodeRef}
            data-drop-zone={dragActive && isOver ? (refused ? 'refused' : 'ok') : undefined}
            // No height transition: the zone opens the moment a drag starts and
            // the drop targets below it are measured right then; an animated
            // height left them measured mid-animation, a few px off.
            className={`rounded-md transition-colors ${
                dragActive
                    ? (isOver
                        ? (refused ? 'h-7 my-0.5 bg-cl-flash/10 ring-1 ring-cl-flash/40' : 'h-7 my-0.5 bg-cl-lume/10 ring-1 ring-cl-lume/30')
                        : 'h-5')
                    : 'h-0'
            }`}
        />
    );
}

/** Which half of the drop target the dragged item's centre is in. */
function dropPlace(active: Active, over: Over | null): DropPlace {
    const a = active.rect.current.translated;
    if (!a || !over) return 'after';
    return a.top + a.height / 2 > over.rect.top + over.rect.height / 2 ? 'after' : 'before';
}

/** Open a context menu from the keyboard (Shift+F10 / the Menu key) at the element. */
function isMenuKey(e: React.KeyboardEvent) {
    return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}
function anchorOf(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return { clientX: r.left + 24, clientY: r.bottom };
}

/** A menu hanging off a button: its left edge, just under the button. */
function buttonAnchor(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return { clientX: r.left, clientY: r.bottom + 2 };
}

// ── Props ────────────────────────────────────────────────────────────────────

type NotifMode = 'all' | 'mentions' | 'none';

interface Props {
    server: ServerInfo;
    channels: ChannelInfo[];
    categories: CategoryInfo[];
    /** Channel-list dividers (already limited by the server to containers this member can see). */
    dividers?: DividerInfo[];
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
    /** Apply a change to this server's channel list in the parent's state at
     *  once (no refetch) - how create / rename / delete show up instantly. */
    onApplyChannels?: (update: (list: ChannelInfo[]) => ChannelInfo[]) => void;
    /** Same, for categories (sub-category create / move) and dividers. */
    onApplyCategories?: (update: (list: CategoryInfo[]) => CategoryInfo[]) => void;
    onApplyDividers?: (update: (list: DividerInfo[]) => DividerInfo[]) => void;
    onDeleteChannelApi?: (channel: ChannelInfo) => Promise<void>;
    onDeleteCategoryApi?: (category: CategoryInfo) => Promise<void>;
    /** Delete a category AND everything in it (one server transaction; the
     *  counts are the ones the dialog showed). Absent = only "delete category
     *  only" is offered. */
    onDeleteCategoryWithContentsApi?: (category: CategoryInfo, expected: ReturnType<typeof expectedCounts>) => Promise<void>;
    onOpenInvite?: () => void;
    /** Fired after a successful text/voice channel create (not edit). */
    onChannelCreated?: (channel: ChannelInfo) => void | Promise<void>;
}

const NO_DIVIDERS: DividerInfo[] = [];
const isTextCategory = (c: CategoryInfo) => !c.kind || c.kind === 'text';
const errMsg = (e: unknown) =>
    ((e as { response?: { data?: { message?: unknown } } })?.response?.data?.message as string | undefined) ?? null;

// ── Component ────────────────────────────────────────────────────────────────

export const ServerChannelList: React.FC<Props> = ({
    server, channels, categories, dividers: allDividers = NO_DIVIDERS, loading,
    activeChannelId, onSelectChannel, onOpenServerSettings, onOpenMemberOptions,
    token, userId, myPermissions = 0n,
    mutedChannelIds, onMarkChannelRead, unreadCounts,
    mentionCounts, serverNotifMode = 'all',
    onChannelsChanged, onApplyChannels, onApplyCategories, onApplyDividers,
    onDeleteChannelApi, onDeleteCategoryApi, onDeleteCategoryWithContentsApi, onOpenInvite,
    onChannelCreated,
}) => {
    const ctx = useContextMenu();
    const toast = useToast();
    // Mute (utils/channelMute.ts): a channel is muted by its own mute, its
    // category's (or parent category's), or the server's. Merged with the
    // caller's `mutedChannelIds` so either source dims + silences the row.
    const mute = useChannelMutes();
    const mutedSet = useMemo(() => {
        const cats = new Map(categories.map(c => [c.category_id, c.parent_category_id ?? null]));
        const own = effectiveMutedChannels(mute.mutes, channels.map(c => c.channel_id), {
            categoryOfChannel: id => channels.find(c => c.channel_id === id)?.parent_category_id ?? null,
            parentOfCategory: id => cats.get(id) ?? null,
            serverOfChannel: () => server.server_id,
        }, mute.now);
        if (mutedChannelIds) for (const id of mutedChannelIds) own.add(id);
        return own;
    }, [mute.mutes, mute.now, channels, categories, server.server_id, mutedChannelIds]);
    // canManage: true when the caller has MANAGE_CHANNELS or ADMINISTRATOR.
    // The API returns ALL_PERMISSIONS for the server owner, so owners pass too.
    // UX only - every write below is re-checked by the server.
    const canManage = !!userId && (
        hasPermission(myPermissions, Permissions.MANAGE_CHANNELS) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );

    // ── Local state for optimistic DnD updates ──────────────────────────
    // Sorted by position initially; updated by DnD then re-synced from props.
    // This list draws TEXT-list dividers only; Calls-panel dividers belong to ServerContextPanel.
    const dividers = useMemo(() => allDividers.filter(d => d.list_kind !== 'calls'), [allDividers]);
    const [localChannels, setLocalChannels] = useState<ChannelInfo[]>(() =>
        [...channels].sort((a, b) => a.position - b.position)
    );
    const [localCategories, setLocalCategories] = useState<CategoryInfo[]>(() =>
        categories.filter(isTextCategory).sort((a, b) => a.position - b.position)
    );
    const [localDividers, setLocalDividers] = useState<DividerInfo[]>(dividers);

    // Refs: always current values, safe to read inside DnD callbacks.
    const localChannelsRef = useRef(localChannels);
    const localCategoriesRef = useRef(localCategories);
    const localDividersRef = useRef(localDividers);
    const backupRef = useRef({ channels: localChannels, categories: localCategories, dividers: localDividers });
    const dragStartOrderRef = useRef<LayoutOrder | null>(null);

    // Channels being created, shown the instant the dialog is submitted and
    // swapped for the server's row when it answers (or dropped, with a toast,
    // if it refuses). Local to this list on purpose: they are not real channels
    // yet, so nothing else in the app (key sweeps, unread, selection) sees them.
    const [pendingChannels, setPendingChannels] = useState<ChannelInfo[]>([]);
    const isPending = (c: { channel_id: string }) => c.channel_id.startsWith('pending:');

    useEffect(() => {
        const sorted = [...channels].sort((a, b) => a.position - b.position);
        setLocalChannels(sorted);
        localChannelsRef.current = sorted;
        backupRef.current.channels = sorted;
    }, [channels]);

    useEffect(() => {
        const textCats = categories.filter(isTextCategory).sort((a, b) => a.position - b.position);
        setLocalCategories(textCats);
        localCategoriesRef.current = textCats;
        backupRef.current.categories = textCats;
    }, [categories]);

    // Re-sync from props during render (not in an effect), then mirror into
    // the refs the DnD callbacks read.
    const [syncedDividers, setSyncedDividers] = useState(dividers);
    if (dividers !== syncedDividers) {
        setSyncedDividers(dividers);
        setLocalDividers(dividers);
    }
    useEffect(() => {
        localDividersRef.current = localDividers;
    }, [localDividers]);
    useEffect(() => {
        backupRef.current.dividers = dividers;
    }, [dividers]);

    // ── The tree ─────────────────────────────────────────────────────────
    // Uses the local lists so DnD optimistic updates are reflected.
    const tree = useMemo(() => buildChannelTree(
        [...localChannels, ...pendingChannels].filter(c => c.kind === 'text'),
        localCategories,
        localDividers,
    ), [localChannels, localCategories, localDividers, pendingChannels]);
    const visibleDividers = useMemo(() => dividerVisibility(tree), [tree]);
    const topLevelIds = useMemo(() => new Set(tree.categories.map(c => c.category.category_id)), [tree]);
    const categoryName = (id: string | null | undefined) =>
        (id ? localCategories.find(c => c.category_id === id)?.name : null) ?? null;

    /** End position of a container in the CURRENT tree (channels, dividers, sub-categories alike). */
    const endOf = (container: string | null): number => {
        const items: TreeItem[] = container === null ? tree.top
            : tree.categories.find(c => c.category.category_id === container)?.items
                ?? tree.categories.flatMap(c => c.items).find((i): i is TreeSub => i.kind === 'subcategory' && i.id === container)?.items
                ?? [];
        return (items.length ? Math.max(...items.map(i => i.position)) : 0) + 1000;
    };

    // ── Inline form dialog state ─────────────────────────────────────────
    const optimism: ChannelOptimism = {
        addPending: (temp) => setPendingChannels(prev => [...prev, { ...temp, position: endOf(temp.parent_category_id ?? null) }]),
        settle: (tempId, saved) => {
            setPendingChannels(prev => prev.filter(c => c.channel_id !== tempId));
            onApplyChannels?.(list => (list.some(c => c.channel_id === saved.channel_id)
                ? list.map(c => (c.channel_id === saved.channel_id ? { ...c, ...saved } : c))
                : [...list, saved]));
        },
        dropPending: (tempId) => setPendingChannels(prev => prev.filter(c => c.channel_id !== tempId)),
        committed: () => onChannelsChanged?.(),
        patch: (channelId, patch) => onApplyChannels?.(list => list.map(c => (c.channel_id === channelId ? { ...c, ...patch } : c))),
        fail: (message) => toast.push({ kind: 'error', message }),
    };

    /** Remove the channel from the list now; put it back (and say so) if the
     *  server refuses. A 404 means it is already gone - that is success. */
    const deleteChannelOptimistic = async (ch: ChannelInfo) => {
        if (!onDeleteChannelApi) return;
        onApplyChannels?.(list => list.filter(c => c.channel_id !== ch.channel_id));
        try {
            await onDeleteChannelApi(ch);
            onChannelsChanged?.();
        } catch (e) {
            if (axios.isAxiosError(e) && e.response?.status === 404) { onChannelsChanged?.(); return; }
            console.error('[ServerChannelList] delete channel:', e);
            onApplyChannels?.(list => (list.some(c => c.channel_id === ch.channel_id) ? list : [...list, ch]));
            toast.push({ kind: 'error', message: `Couldn't delete #${ch.name}. It's back in the list.` });
        }
    };

    // ── Dividers: optimistic create / edit / delete ──────────────────────
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const applyDividers = (update: (list: DividerInfo[]) => DividerInfo[]) => {
        const next = update(localDividersRef.current);
        setLocalDividers(next);
        localDividersRef.current = next;
        onApplyDividers?.(update);
    };
    const pendingSeq = useRef(0);

    const createDivider = (container: string | null, v: DividerValues) => {
        const tempId = `pending:div:${++pendingSeq.current}`;
        const temp: DividerInfo = {
            divider_id: tempId, server_id: server.server_id, parent_category_id: container,
            position: endOf(container), ...v,
        };
        applyDividers(list => [...list, temp]);
        axios.post(apiUrl`/servers/${server.server_id}/dividers`, {
            style: v.style,
            ...(container ? { parent_category_id: container } : {}),
            ...(v.label ? { label: v.label } : {}),
            ...(v.color ? { color: v.color } : {}),
        }, auth)
            .then(res => {
                applyDividers(list => list.map(d => (d.divider_id === tempId ? (res.data as DividerInfo) : d)));
                onChannelsChanged?.();
            })
            .catch(e => {
                applyDividers(list => list.filter(d => d.divider_id !== tempId));
                toast.push({ kind: 'error', message: errMsg(e) ?? "Couldn't add that divider." });
            });
    };

    const updateDivider = (d: DividerInfo, v: DividerValues) => {
        applyDividers(list => list.map(x => (x.divider_id === d.divider_id ? { ...x, ...v } : x)));
        axios.patch(apiUrl`/servers/${server.server_id}/dividers/${d.divider_id}`, {
            style: v.style, label: v.label ?? '', color: v.color,
        }, auth)
            .then(() => onChannelsChanged?.())
            .catch(e => {
                applyDividers(list => list.map(x => (x.divider_id === d.divider_id ? d : x)));
                toast.push({ kind: 'error', message: errMsg(e) ?? "Couldn't save that divider. It's back as it was." });
            });
    };

    const deleteDivider = (d: DividerInfo) => {
        applyDividers(list => list.filter(x => x.divider_id !== d.divider_id));
        axios.delete(apiUrl`/servers/${server.server_id}/dividers/${d.divider_id}`, auth)
            .then(() => onChannelsChanged?.())
            .catch(e => {
                if (axios.isAxiosError(e) && e.response?.status === 404) { onChannelsChanged?.(); return; }
                applyDividers(list => (list.some(x => x.divider_id === d.divider_id) ? list : [...list, d]));
                toast.push({ kind: 'error', message: "Couldn't delete that divider. It's back in the list." });
            });
    };

    const [channelDialog, setChannelDialog] = useState<
        | { mode: 'create'; defaultCategoryId: string | null; defaultKind: 'text' }
        | { mode: 'edit'; channel: ChannelInfo }
        | null
    >(null);
    // After a create (Create another UNCHECKED) the user lands in the new
    // channel. Skipped if they opened a different channel while the create was
    // in flight (the dialog closes instantly; the server answers later) so we
    // never yank them out of what they moved on to.
    const activeIdRef = useRef(activeChannelId);
    activeIdRef.current = activeChannelId;
    const activeAtDialogOpenRef = useRef<string | null>(activeChannelId);
    useEffect(() => { if (channelDialog) activeAtDialogOpenRef.current = activeIdRef.current; }, [channelDialog]);
    const navigateToCreated = useCallback((ch: ChannelInfo) => {
        if (activeIdRef.current !== activeAtDialogOpenRef.current) return;
        // Text: exactly a sidebar click (opens the chat, runs the key bootstrap).
        // Calls: never joins - the row is only scrolled into view and flashed.
        if (ch.kind === 'text') onSelectChannel(ch);
        requestAnimationFrame(() => requestAnimationFrame(() => { revealChannelRow(ch.channel_id, document); }));
    }, [onSelectChannel]);
    const [categoryDialog, setCategoryDialog] = useState<
        | { mode: 'create'; parentCategoryId?: string | null }
        | { mode: 'edit'; category: CategoryInfo; initialTab?: 'overview' | 'permissions' }
        | null
    >(null);
    const [dividerDialog, setDividerDialog] = useState<
        | { mode: 'create'; container: string | null }
        | { mode: 'edit'; divider: DividerInfo }
        | null
    >(null);
    const [pendingConfirm, setPendingConfirm] = useState<ConfirmOptions | null>(null);
    /** The two-choice category delete (CategoryDeleteDialog). */
    const [categoryDelete, setCategoryDelete] = useState<{
        cat: CategoryInfo; isSub: boolean; only: CategoryDeleteConfirm; contents: CategoryContents;
    } | null>(null);

    const createMenu = useContextMenu();

    // ── Category / sub-category collapse state ───────────────────────────
    // One map for both (ids never collide); per user, per server, encrypted
    // at rest (secureLocalStore; classified in services/backupRegistry.ts).
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

    /** Open a category if it is collapsed (the off-screen-unread jump landing in one). Persists like a manual toggle. */
    const expandCategory = useCallback((id: string) => {
        setCollapsedCats(prev => {
            if (!prev[id]) return prev;
            const next = { ...prev, [id]: false };
            if (collapseKey) {
                try { secureLocalStore.setItem(collapseKey, JSON.stringify(next)); } catch { /* full / disabled */ }
            }
            return next;
        });
    }, [collapseKey]);

    // ── DnD setup ────────────────────────────────────────────────────────
    const [activeId, setActiveId] = useState<string | null>(null);
    const [overId,   setOverId]   = useState<string | null>(null);
    const [overPlace, setOverPlace] = useState<DropPlace>('after');
    // The dragged item cannot land where the pointer is (decideLayoutDrop says
    // 'refused'): the drop line / zone and the ghost turn red, the cursor is
    // not-allowed, and releasing there opens `subcatRefusal` instead of moving.
    const [overRefused, setOverRefused] = useState(false);
    const [subcatRefusal, setSubcatRefusal] = useState(false);
    useEffect(() => {
        if (!overRefused) return;
        const root = document.documentElement;
        root.classList.add('cl-drag-refused');
        return () => root.classList.remove('cl-drag-refused');
    }, [overRefused]);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    );

    function onDragStart({ active }: DragStartEvent) {
        setActiveId(active.id as string);
        setOverId(null);
        setOverRefused(false);
        backupRef.current = {
            channels: localChannelsRef.current,
            categories: localCategoriesRef.current,
            dividers: localDividersRef.current,
        };
        dragStartOrderRef.current = layoutOrderFromTree(tree);
    }

    // Nothing moves between containers while the pointer travels: the drop is
    // decided once in onDragEnd from the drag-start layout (layoutDrop.ts).
    function onDragOver({ active, over }: DragOverEvent) {
        setOverId(over ? (over.id as string) : null);
        const place = dropPlace(active, over);
        setOverPlace(place);
        const startOrder = dragStartOrderRef.current;
        setOverRefused(!!over && !!startOrder
            && decideLayoutDrop(startOrder, active.id as string, over.id as string, place, topLevelIds).kind === 'refused');
    }

    function restoreBackup() {
        const b = backupRef.current;
        setLocalChannels(b.channels); localChannelsRef.current = b.channels;
        setLocalCategories(b.categories); localCategoriesRef.current = b.categories;
        setLocalDividers(b.dividers); localDividersRef.current = b.dividers;
    }

    function onDragEnd({ active, over }: DragEndEvent) {
        setActiveId(null);
        setOverId(null);
        setOverRefused(false);
        const startOrder = dragStartOrderRef.current;
        dragStartOrderRef.current = null;

        if (!over || !canManage) { restoreBackup(); return; }

        const dragId = active.id as string;
        const dropId = over.id as string;
        const cats = localCategoriesRef.current;

        // ── Top-level category reorder ─────────────────────────────────
        if (dragId.startsWith('cat:')) {
            if (!dropId.startsWith('cat:') || dragId === dropId) return;
            const tops = cats.filter(c => topLevelIds.has(c.category_id)).sort((a, b) => a.position - b.position);
            const activeIdx = tops.findIndex(c => c.category_id === dragId.slice(4));
            const overIdx   = tops.findIndex(c => c.category_id === dropId.slice(4));
            if (activeIdx === -1 || overIdx === -1) return;

            const moved = arrayMove(tops, activeIdx, overIdx).map((c, i) => ({ ...c, position: (i + 1) * 1000 }));
            const byId = new Map(moved.map(c => [c.category_id, c]));
            const newCats = cats.map(c => byId.get(c.category_id) ?? c);
            setLocalCategories(newCats);
            localCategoriesRef.current = newCats;

            axios.patch(apiUrl`/servers/${server.server_id}/categories/reorder`, {
                category_ids: moved.map(c => c.category_id),
            }, auth)
                .then(() => onChannelsChanged?.())
                .catch(() => {
                    setLocalCategories(backupRef.current.categories);
                    localCategoriesRef.current = backupRef.current.categories;
                    toast.push({ kind: 'error', message: "Couldn't move that category. It's back where it was." });
                });
            return;
        }

        // ── Channels, dividers, sub-categories ─────────────────────────
        // One pure decision for every drop, from the layout as it was when the
        // drag began (layoutDrop.ts): released over itself = no change.
        if (!startOrder || !parseItemKey(dragId)) return;
        const verdict = decideLayoutDrop(startOrder, dragId, dropId, dropPlace(active, over), topLevelIds);
        if (verdict.kind === 'refused') {
            // Nothing moved (no relocation during the drag); say why instead
            // of a silent snap-back. The server refuses the same drop anyway.
            setSubcatRefusal(true);
            return;
        }
        if (verdict.kind !== 'move') return;
        const plan = verdict.plan;

        const moves = applyPlanPositions(plan);
        const patchOf = (key: string) => moves.get(key);
        const nextChannels = localChannelsRef.current.map(c => {
            const m = patchOf(`ch:${c.channel_id}`);
            return m ? { ...c, parent_category_id: m.parent, position: m.position } : c;
        });
        const nextCats = localCategoriesRef.current.map(c => {
            const m = patchOf(`sub:${c.category_id}`);
            return m ? { ...c, parent_category_id: m.parent, position: m.position } : c;
        });
        const nextDividers = localDividersRef.current.map(d => {
            const m = patchOf(`div:${d.divider_id}`);
            return m ? { ...d, parent_category_id: m.parent, position: m.position } : d;
        });
        setLocalChannels(nextChannels); localChannelsRef.current = nextChannels;
        setLocalCategories(nextCats); localCategoriesRef.current = nextCats;
        setLocalDividers(nextDividers); localDividersRef.current = nextDividers;

        axios.patch(apiUrl`/servers/${server.server_id}/channel-layout`, layoutPatchBody(plan), auth)
            .then(() => {
                // Keep the parent's state (and cache) in step until the echo lands.
                onApplyChannels?.(list => list.map(c => {
                    const m = patchOf(`ch:${c.channel_id}`);
                    return m ? { ...c, parent_category_id: m.parent, position: m.position } : c;
                }));
                onApplyCategories?.(list => list.map(c => {
                    const m = patchOf(`sub:${c.category_id}`);
                    return m ? { ...c, parent_category_id: m.parent, position: m.position } : c;
                }));
                onApplyDividers?.(() => localDividersRef.current);
                onChannelsChanged?.();
            })
            .catch(() => {
                restoreBackup();
                toast.push({ kind: 'error', message: "Couldn't move that. It's back where it was." });
            });
    }

    // ── Drop-line helper ─────────────────────────────────────────────────
    /** 'top' | 'bottom' | null for the drop indicator on `itemKey`. */
    const getDropLine = (itemKey: string, containerKeys: string[]): 'top' | 'bottom' | null => {
        if (!activeId || overId !== itemKey || activeId === itemKey) return null;
        // A channel / divider over a sub-category header goes INTO it: the
        // header highlights instead of drawing a line (see renderSub).
        if (itemKey.startsWith('sub:') && !activeId.startsWith('sub:')) return null;
        const aIdx = containerKeys.indexOf(activeId);
        const oIdx = containerKeys.indexOf(itemKey);
        if (oIdx === -1) return null;
        // Same container: sortable semantics; otherwise the pointer's half.
        if (aIdx !== -1) return aIdx < oIdx ? 'bottom' : 'top';
        return overPlace === 'after' ? 'bottom' : 'top';
    };

    // ── Off-screen unread indicator ──────────────────────────────────────
    // What each badge says, keyed by anchor (offscreenUnread.ts owns the rule,
    // renderChannelRow draws from the same function). A channel inside a
    // collapsed category or sub-category has no row, so its header stands in.
    const unreadModel = useMemo(() => buildUnreadModel({
        uncategorized: tree.top.filter(i => i.kind === 'channel').map(i => (i as Extract<TreeLeaf, { kind: 'channel' }>).channel),
        categories: tree.categories.map(c => ({
            category_id: c.category.category_id,
            channels: c.items.filter(i => i.kind === 'channel').map(i => (i as Extract<TreeLeaf, { kind: 'channel' }>).channel),
            subcategories: c.items.filter((i): i is TreeSub => i.kind === 'subcategory').map(s => ({
                category_id: s.id,
                channels: channelsIn(s.items),
            })),
        })),
        collapsed: collapsedCats,
        unreadCounts, mentionCounts, mutedChannelIds: mutedSet, serverNotifMode, activeChannelId,
    }), [tree, collapsedCats, unreadCounts, mentionCounts, mutedSet, serverNotifMode, activeChannelId]);
    const reducedMotion = usePrefersReducedMotion();
    const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
    const offscreen = useOffscreenUnread({
        scroller: listEl, model: unreadModel, reducedMotion, onExpandCategory: expandCategory,
    });

    /** Rolled-up unread state of a collapsed sub-category: strongest kind and a count. */
    const subUnread = (sub: TreeSub): { kind: UnreadKind; count: number } | null => rolledUnread(channelsIn(sub.items));

    /** Rolled-up unread state of any set of channels (a collapsed category or sub-category). */
    const rolledUnread = (inside: ChannelInfo[]): { kind: UnreadKind; count: number } | null => {
        let kind: UnreadKind | null = null;
        let unread = 0;
        let mentions = 0;
        for (const ch of inside) {
            const k = channelBadgeKind({
                unread: unreadCounts?.[ch.channel_id] ?? 0,
                mentions: mentionCounts?.[ch.channel_id] ?? 0,
                serverNotifMode,
                channelMuted: mutedSet.has(ch.channel_id),
                active: activeChannelId === ch.channel_id,
            });
            if (!k) continue;
            kind = kind ? strongerKind(kind, k) : k;
            unread += unreadCounts?.[ch.channel_id] ?? 0;
            mentions += mentionCounts?.[ch.channel_id] ?? 0;
        }
        if (!kind) return null;
        return { kind, count: kind === 'mention' ? mentions : kind === 'unread' ? unread : 0 };
    };

    // ── Context menu builders ────────────────────────────────────────────
    const buildChannelMenu = (ch: ChannelInfo): ContextMenuItem[] => {
        const hasUnread = ((unreadCounts?.[ch.channel_id] ?? 0) + (mentionCounts?.[ch.channel_id] ?? 0)) > 0;
        return [
            ...(onMarkChannelRead ? [{
                icon: <CheckCheck />, label: 'Mark as Read',
                disabled: !hasUnread,
                onSelect: () => onMarkChannelRead(ch.channel_id),
            }] : []),
            ...buildMuteItems(mute, ch.channel_id, 'Channel'),
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
                        onConfirm: () => { void deleteChannelOptimistic(ch); },
                    }),
                }] : []),
            ] : []),
        ];
    };

    const deleteCategoryNow = (cat: CategoryInfo) => {
        if (!onDeleteCategoryApi) return;
        void onDeleteCategoryApi(cat)
            .then(() => onChannelsChanged?.())
            .catch(e => {
                console.error('[ServerChannelList] delete category:', e);
                toast.push({ kind: 'error', message: errMsg(e) ?? `Couldn't delete ‘${cat.name}’.` });
            });
    };

    /** The whole subtree in ONE request - never channel by channel. A refusal
     *  (someone else's channel inside, or the contents changed) shows the
     *  server's message; nothing was deleted then. */
    const deleteCategoryWithContentsNow = (cat: CategoryInfo, contents: CategoryContents) => {
        if (!onDeleteCategoryWithContentsApi) return;
        void onDeleteCategoryWithContentsApi(cat, expectedCounts(contents))
            .then(() => onChannelsChanged?.())
            .catch(e => {
                console.error('[ServerChannelList] delete category with contents:', e);
                toast.push({ kind: 'error', message: errMsg(e) ?? `Couldn't delete ‘${cat.name}’.` });
                onChannelsChanged?.();
            });
    };

    /**
     * Open the delete confirm for a category. A top-level category that still
     * holds sub-categories is checked first: if it is PRIVATE the server would
     * refuse (409), so the dialog says why with Delete disabled and the way
     * out (categoryDelete.ts). If its overrides cannot be read, the normal
     * confirm opens and the server's message is shown if it refuses.
     */
    const requestDeleteCategory = async (cat: CategoryInfo) => {
        const isSub = !!cat.parent_category_id && !topLevelIds.has(cat.category_id);
        const hasSubcategories = !isSub && localCategoriesRef.current.some(c => c.parent_category_id === cat.category_id);
        let isPrivate: boolean | null = null;
        if (hasSubcategories && token) {
            try {
                const [roles, overrides] = await Promise.all([
                    axios.get(apiUrl`/servers/${server.server_id}/roles`, auth),
                    axios.get(apiUrl`/servers/${server.server_id}/categories/${cat.category_id}/overrides`, auth),
                ]);
                isPrivate = categoryRestrictsView(
                    ((roles.data ?? []) as Parameters<typeof roleFromWire>[0][]).map(roleFromWire),
                    ((overrides.data ?? []) as Parameters<typeof overrideFromWire>[0][]).map(overrideFromWire),
                );
            } catch { isPrivate = null; }
        }
        const confirm = categoryDeleteConfirm({
            name: cat.name, isSub, parentName: categoryName(cat.parent_category_id), hasSubcategories, isPrivate,
        });
        if (onDeleteCategoryWithContentsApi) {
            // Two choices: contents move up a level, or go with it.
            const contents = categoryContents(cat.category_id, {
                categories: localCategoriesRef.current, channels: localChannelsRef.current, dividers: localDividersRef.current,
            });
            setCategoryDelete({ cat, isSub, only: confirm, contents });
            return;
        }
        setPendingConfirm({
            ...confirm,
            confirmLabel: 'Delete',
            onConfirm: () => { if (!confirm.confirmDisabled) deleteCategoryNow(cat); },
        });
    };

    // Every item here is a MANAGE_CHANNELS-gated action (create/edit/delete),
    // so the whole menu is empty for a member who lacks it — the server
    // still refuses these calls independently; this is UX only. "Create
    // Channel Here" used to sit outside the canManage check (only Edit/Delete
    // were gated), so any member could right-click a category header and see
    // the option, even though POST /channels would 403.
    /** Every channel under a category (its sub-categories' too) or a sub-category. */
    const channelsUnder = (categoryId: string): ChannelInfo[] => {
        const top = tree.categories.find(c => c.category.category_id === categoryId);
        if (top) return channelsIn(top.items);
        const sub = tree.categories.flatMap(c => c.items).find((i): i is TreeSub => i.kind === 'subcategory' && i.id === categoryId);
        return sub ? channelsIn(sub.items) : [];
    };

    /**
     * One menu for categories AND sub-categories, so they cannot drift apart.
     * The only difference is by design: a sub-category cannot hold
     * sub-categories (one level). No "Move to top level" and no separate "Edit
     * Permissions" (owner, 2026-11-16): Edit has a Permissions tab and its
     * "Sits in" picker moves a sub-category. Mark as
     * Read and Copy ID are for every member; the rest needs MANAGE_CHANNELS
     * (UX only - the server re-checks every write).
     */
    const buildCategoryMenu = (cat: CategoryInfo): ContextMenuItem[] => {
        const isSub = !!cat.parent_category_id && !topLevelIds.has(cat.category_id);
        const inside = channelsUnder(cat.category_id);
        const hasUnread = inside.some(ch => ((unreadCounts?.[ch.channel_id] ?? 0) + (mentionCounts?.[ch.channel_id] ?? 0)) > 0);
        const noun = isSub ? 'Sub-category' : 'Category';
        return [
            ...(onMarkChannelRead ? [{
                icon: <CheckCheck />, label: 'Mark as Read',
                disabled: !hasUnread,
                onSelect: () => { for (const ch of inside) onMarkChannelRead(ch.channel_id); },
            }] : []),
            ...buildMuteItems(mute, cat.category_id, noun),
            ...(canManage ? [
                ...(onMarkChannelRead ? [{ divider: true as const }] : []),
                {
                    icon: <Plus />, label: 'Create Channel Here',
                    onSelect: () => setChannelDialog({ mode: 'create', defaultCategoryId: cat.category_id, defaultKind: 'text' }),
                },
                ...(!isSub ? [{
                    icon: <CornerDownRight />, label: 'Create Sub-category Here',
                    onSelect: () => setCategoryDialog({ mode: 'create', parentCategoryId: cat.category_id }),
                }] : []),
                {
                    icon: <Minus />, label: 'Add Divider Here',
                    onSelect: () => setDividerDialog({ mode: 'create', container: cat.category_id }),
                },
                { divider: true as const },
                {
                    icon: <Pencil />, label: `Edit ${noun}`,
                    onSelect: () => setCategoryDialog({ mode: 'edit', category: cat }),
                },
            ] : []),
            { divider: true as const },
            {
                icon: <LinkIcon />, label: `Copy ${noun} ID`,
                onSelect: () => writeToClipboard(cat.category_id).catch(() => toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })),
            },
            ...(canManage && onDeleteCategoryApi ? [{
                icon: <Trash2 />, label: `Delete ${noun}`, danger: true,
                onSelect: () => { void requestDeleteCategory(cat); },
            }] : []),
        ];
    };

    /**
     * The header "+" menu (managers). A top-level category can hold channels,
     * dividers and sub-categories; a sub-category only channels and dividers
     * (one nesting level). Each option preselects this category as the parent.
     * Sub-categories are offered ONLY from here and the category's own menu,
     * never from blank space.
     */
    const buildAddMenu = (cat: CategoryInfo): ContextMenuItem[] => {
        const isSub = !!cat.parent_category_id && !topLevelIds.has(cat.category_id);
        return [
            {
                icon: <Plus />, label: 'Create Channel',
                onSelect: () => setChannelDialog({ mode: 'create', defaultCategoryId: cat.category_id, defaultKind: 'text' }),
            },
            {
                icon: <Minus />, label: 'Add Divider',
                onSelect: () => setDividerDialog({ mode: 'create', container: cat.category_id }),
            },
            ...(!isSub ? [{
                icon: <CornerDownRight />, label: 'Create Sub-category',
                onSelect: () => setCategoryDialog({ mode: 'create', parentCategoryId: cat.category_id }),
            }] : []),
        ];
    };

    const buildDividerMenu = (d: DividerInfo): ContextMenuItem[] => (canManage && !d.divider_id.startsWith('pending:') ? [
        { icon: <Pencil />, label: 'Edit Divider', onSelect: () => setDividerDialog({ mode: 'edit', divider: d }) },
        {
            icon: <Trash2 />, label: 'Delete Divider', danger: true,
            onSelect: () => setPendingConfirm({
                title: d.label ? `Delete the "${d.label}" divider?` : 'Delete this divider?',
                message: 'Only the divider goes; channels stay where they are.',
                confirmLabel: 'Delete',
                onConfirm: () => deleteDivider(d),
            }),
        },
    ] : []);

    // ── Render helpers ───────────────────────────────────────────────────
    // Menu vocabulary (selm/ctxm): active rows glow lume, hover is a faint
    // lume wash — not the flat raise box.
    const channelRowCls = (channelId: string) =>
        `group flex items-center gap-2 px-2 py-1.5 rounded-[9px] cursor-pointer transition-all text-sm select-none relative ${
            activeChannelId === channelId
                ? 'bg-cl-lume/10 text-cl-lume-text font-semibold cl-row-active'
                : 'text-cl-muted font-medium hover:text-cl-text hover:bg-cl-lume/[0.06]'
        }`;

    const renderChannelRow = (ch: ChannelInfo) => {
        const isMuted = mutedSet.has(ch.channel_id);
        const isChannelMuted = serverNotifMode === 'none' || isMuted;
        const unread = unreadCounts?.[ch.channel_id] ?? 0;
        const mentions = mentionCounts?.[ch.channel_id] ?? 0;
        // One rule for the badge AND the off-screen pill (offscreenUnread.ts):
        //  - 'mention': the red badge, always, regardless of mute;
        //  - 'unread':  the counted lume badge — not when muted;
        //  - 'quiet':   the plain grey dot, no number, for a server on
        //               "@mentions only" that is NOT muted: "there is something
        //               new here" without claiming it wants attention. Same
        //               treatment as the rail (components/RailBadge.tsx);
        //  - null:      nothing (the open channel, or muted with no mention).
        const badge = channelBadgeKind({
            unread, mentions, serverNotifMode, channelMuted: isMuted, active: activeChannelId === ch.channel_id,
        });
        const pending = isPending(ch);
        if (pending) {
            // Created locally, not acknowledged yet: visible but inert.
            return (
                <div
                    key={ch.channel_id}
                    aria-busy="true"
                    className="flex items-center gap-2 px-2 py-1.5 rounded-[9px] text-sm select-none text-cl-muted font-medium opacity-60 motion-safe:animate-pulse"
                    title="Creating channel..."
                >
                    {ch.icon_name ? (
                        <ChannelIconRenderer name={ch.icon_name} size={16} className="shrink-0 text-cl-faint" />
                    ) : (
                        <Hash size={16} className="shrink-0 text-cl-faint" />
                    )}
                    <span className="truncate flex-1">{ch.name}</span>
                </div>
            );
        }
        return (
            <div
                key={ch.channel_id}
                /* Target for a clicked #channel link (utils/channelRefs.revealChannelRow). */
                data-channel-id={ch.channel_id}
                onClick={() => onSelectChannel(ch)}
                // Rest the pointer on a restricted channel and its member-sidebar
                // viewer set is fetched before the click (utils/channelViewerCache).
                onMouseEnter={() => hoverPrefetchChannelViewers(ch, token)}
                onMouseLeave={cancelHoverPrefetch}
                onContextMenu={(e) => ctx.open(e, buildChannelMenu(ch), `${ch.icon_emoji ?? '#'} ${ch.name}`)}
                className={channelRowCls(ch.channel_id)}
                title={ch.topic ?? ch.name}
                data-unread-anchor={badge ? channelKey(ch.channel_id) : undefined}
            >
                {ch.icon_name ? (
                    <ChannelIconRenderer
                        name={ch.icon_name}
                        size={16}
                        className={`shrink-0 ${activeChannelId === ch.channel_id ? 'text-cl-lume-text' : 'text-cl-faint group-hover:text-cl-muted'}`}
                    />
                ) : ch.icon_emoji ? (
                    <span className="shrink-0 text-[15px] leading-none w-4 text-center">{ch.icon_emoji}</span>
                ) : (
                    <Hash
                        size={16}
                        className={`shrink-0 ${activeChannelId === ch.channel_id ? 'text-cl-lume-text' : 'text-cl-faint group-hover:text-cl-muted'}`}
                    />
                )}
                <span className={`truncate flex-1 ${isChannelMuted ? 'opacity-50' : ''}`}>{ch.name}</span>
                {ch.age_restricted && (
                    <span role="img" aria-label="Age-restricted channel" title="Age-restricted (18+)" className="shrink-0 text-cl-glow-text/80" data-testid="age-restricted-icon">
                        <ShieldAlert size={12} aria-hidden="true" />
                    </span>
                )}
                {isMuted && <MutedGlyph size={12} />}
                {/* @mention badge — always shown regardless of mute */}
                {badge === 'mention' && (
                    <span className="ml-auto min-w-[16px] h-4 px-0.5 rounded-full bg-cl-flash text-cl-text text-[9px] font-bold flex items-center justify-center group-hover:opacity-0 transition-opacity shrink-0">
                        {mentions > 99 ? '99+' : mentions}
                    </span>
                )}
                {/* Unread badge — only when not muted and no mention badge */}
                {/* @mentions-only draws a plain grey dot, no number: there is
                    something new, but the user asked not to be pinged for it.
                    Same treatment as the rail (components/RailBadge.tsx). */}
                {(badge === 'quiet' || badge === 'unread') && (badge === 'quiet' ? (
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

    const renderDividerRow = (d: DividerInfo) => {
        const pending = d.divider_id.startsWith('pending:');
        const menu = buildDividerMenu(d);
        const confirmDelete = () => setPendingConfirm({
            title: d.label ? `Delete the "${d.label}" divider?` : 'Delete this divider?',
            message: 'Only the divider goes; channels stay where they are.',
            confirmLabel: 'Delete',
            onConfirm: () => deleteDivider(d),
        });
        return (
            <DividerHitArea
                divider={d}
                interactive={canManage}
                pending={pending}
                ariaLabel={dividerAriaLabel(d)}
                tabIndex={canManage && !pending ? 0 : undefined}
                onContextMenu={menu.length ? (e) => ctx.open(e, menu, d.label ? `Divider · ${d.label}` : 'Divider') : undefined}
                onDoubleClick={canManage && !pending ? () => setDividerDialog({ mode: 'edit', divider: d }) : undefined}
                onKeyDown={canManage && !pending ? (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); setDividerDialog({ mode: 'edit', divider: d }); }
                    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); confirmDelete(); }
                    else if (isMenuKey(e)) { e.preventDefault(); ctx.open(anchorOf(e.currentTarget), menu, 'Divider'); }
                } : undefined}
            />
        );
    };

    const renderLeaf = (leaf: TreeLeaf, containerKeys: string[]) => {
        if (leaf.kind === 'divider' && !visibleDividers.shown.has(leaf.id)) return null;
        const pending = leaf.id.startsWith('pending:');
        return (
            <SortableLeaf
                key={leaf.key}
                id={leaf.key}
                disabled={!canManage || pending}
                isDragging={activeId === leaf.key}
                dropLine={getDropLine(leaf.key, containerKeys)}
                dropRefused={overRefused && overId === leaf.key}
            >
                {leaf.kind === 'channel' ? renderChannelRow(leaf.channel) : renderDividerRow(leaf.divider)}
            </SortableLeaf>
        );
    };

    const renderSub = (sub: TreeSub, containerKeys: string[]) => {
        const collapsed = !!collapsedCats[sub.id];
        const cat = sub.category;
        const rolled = collapsed ? subUnread(sub) : null;
        const dropInto = !!activeId && overId === sub.key && !activeId.startsWith('sub:');
        const keys = sub.items.map(i => i.key);
        const menuTitle = cat.name;
        return (
            <SortableSection
                key={sub.key}
                id={sub.key}
                disabled={!canManage}
                isDragging={activeId === sub.key}
                dropLine={getDropLine(sub.key, containerKeys)}
            >
                {(setHeaderRef, headerDragProps) => (
                    // Indented with a guide line (concept): consecutive blocks
                    // join into one continuous rule.
                    <div className="ml-2.5 pl-2.5 border-l border-solid border-cl-border" data-subcategory-id={sub.id}>
                        <div
                            ref={canManage ? setHeaderRef : undefined}
                            {...(canManage ? headerDragProps : {})}
                            role="button"
                            tabIndex={0}
                            aria-expanded={!collapsed}
                            aria-label={`${cat.name}, sub-category${rolled ? (rolled.kind === 'mention' ? `, ${rolled.count} mentions` : ', unread') : ''}`}
                            className={`group flex items-center gap-1.5 w-full px-2 py-[2px] mt-1.5 ${canManage ? 'min-h-[26px]' : 'min-h-[23px]'} rounded-md relative transition-colors outline-none focus-visible:ring-1 focus-visible:ring-cl-lume/60 ${
                                dropInto ? 'bg-cl-lume/10 ring-1 ring-cl-lume/30' : 'hover:bg-cl-raise/40'
                            } ${canManage ? 'cursor-grab active:cursor-grabbing select-none touch-none' : 'cursor-pointer'}`}
                            data-unread-anchor={collapsed && unreadModel.has(categoryKey(sub.id)) ? categoryKey(sub.id) : undefined}
                            onContextMenu={(e) => {
                                e.stopPropagation();
                                ctx.open(e, buildCategoryMenu(cat), menuTitle);
                            }}
                            onClick={() => toggleCategory(sub.id)}
                            onKeyDown={(e) => {
                                // Keys pressed on the header's own buttons ("+", "...") belong to them.
                                if (e.target !== e.currentTarget) return;
                                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCategory(sub.id); }
                                else if (e.key === 'ArrowRight' && collapsed) { e.preventDefault(); toggleCategory(sub.id); }
                                else if (e.key === 'ArrowLeft' && !collapsed) { e.preventDefault(); toggleCategory(sub.id); }
                                else if (isMenuKey(e)) { e.preventDefault(); ctx.open(anchorOf(e.currentTarget), buildCategoryMenu(cat), menuTitle); }
                            }}
                        >
                            <span className="shrink-0 text-cl-faint group-hover:text-cl-text transition-colors w-3 h-3 flex items-center justify-center">
                                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                            </span>
                            {/* No icon picked = the default the create/edit dialog shows
                                (CornerDownRight). The sidebar used to draw nothing, so the
                                default "wasn't applied" (owner, 2026-11-16). */}
                            {cat.icon_name ? (
                                <ChannelIconRenderer
                                    name={cat.icon_name}
                                    size={13}
                                    className="shrink-0 block text-cl-faint group-hover:text-cl-muted transition-colors"
                                />
                            ) : (
                                <CornerDownRight
                                    size={13}
                                    aria-hidden="true"
                                    data-testid="subcat-default-icon"
                                    className="shrink-0 block text-cl-faint group-hover:text-cl-muted transition-colors"
                                />
                            )}
                            <span
                                data-testid="subcat-label"
                                className={`truncate text-[13px] leading-none font-normal transition-colors ${collapsed ? 'text-cl-faint' : 'text-cl-muted'} group-hover:text-cl-text`}
                            >
                                {cat.name}
                            </span>
                            {rolled && (
                                <span
                                    aria-hidden="true"
                                    className={`shrink-0 ml-1 w-[7px] h-[7px] rounded-full ${rolled.kind === 'mention' ? 'bg-cl-flash' : rolled.kind === 'unread' ? 'bg-cl-lume' : 'bg-cl-faint'}`}
                                />
                            )}
                            <span className="flex-1" />
                            {rolled && rolled.count > 0 && (
                                <span
                                    aria-hidden="true"
                                    className="shrink-0 text-[10px] text-cl-faint group-hover:opacity-0 transition-opacity"
                                    style={{ fontFamily: 'var(--cl-font-mono)' }}
                                >
                                    {rolled.count > 99 ? '99+' : rolled.count}
                                </span>
                            )}
                            {canManage && (
                                <HoverActions
                                    // Out of the layout until hover / focus (categoryHeadingStyle.ts).
                                    className={CATEGORY_HEADER_ACTIONS_CLASS}
                                    actions={[
                                        {
                                            icon: <Plus />, label: 'Add to this sub-category',
                                            onClick: (e: React.MouseEvent) => ctx.open(buttonAnchor(e.currentTarget as HTMLElement), buildAddMenu(cat), cat.name),
                                        },
                                        {
                                            icon: <MoreVertical />, label: 'Sub-category options',
                                            onClick: (e: React.MouseEvent) => { e.stopPropagation(); ctx.open(e, buildCategoryMenu(cat), menuTitle); },
                                        },
                                    ]}
                                />
                            )}
                        </div>
                        {!collapsed && (
                            <SortableContext items={keys} strategy={verticalListSortingStrategy}>
                                {sub.items.map(leaf => renderLeaf(leaf, keys))}
                            </SortableContext>
                        )}
                    </div>
                )}
            </SortableSection>
        );
    };

    const renderItem = (item: TreeItem, containerKeys: string[]) =>
        (item.kind === 'subcategory' ? renderSub(item, containerKeys) : renderLeaf(item, containerKeys));

    // ── Active drag overlay (ghost item) ─────────────────────────────────
    const activeParsed = activeId ? parseItemKey(activeId) : null;
    const activeChannel = activeParsed?.kind === 'channel'
        ? localChannels.find(c => c.channel_id === activeParsed.id) ?? null
        : null;
    const activeDivider = activeParsed?.kind === 'divider'
        ? localDividers.find(d => d.divider_id === activeParsed.id) ?? null
        : null;
    const activeCat = activeId?.startsWith('cat:')
        ? localCategories.find(c => c.category_id === activeId.slice(4)) ?? null
        : activeParsed?.kind === 'subcategory'
            ? localCategories.find(c => c.category_id === activeParsed.id) ?? null
            : null;

    if (loading && channels.length === 0 && categories.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center" role="status" aria-label="Loading channels">
                <div className="w-5 h-5 border-2 border-white/20 border-t-cl-lume rounded-full animate-spin" />
            </div>
        );
    }

    const hasBanner = !!(server.banner_attachment && server.banner_key_b64 && server.banner_nonce_b64);
    const isEmpty = channels.length === 0 && categories.length === 0 && localDividers.length === 0;
    const topKeys = tree.top.map(i => i.key);
    const catKeys = tree.categories.map(c => `cat:${c.category.category_id}`);
    const editingCategory = categoryDialog?.mode === 'edit' ? categoryDialog.category : null;

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
                        animate
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
                        style={{ fontFamily: 'var(--cl-font-display)', textShadow: 'var(--cl-title-halo, 0 1px 10px rgb(var(--cl-shade-rgb) / 0.7))' }}
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
                                style={{ color: 'var(--cl-lume-text)', background: 'rgb(var(--cl-lume-rgb) / .10)' }}
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
                collisionDetection={layoutCollisionDetection}
                // Re-measure drop targets while dragging: the end-of-list drop
                // zone grows once a drag starts, shifting everything below it,
                // and rects measured only at drag start then point one row off
                // (a channel released on a sub-category's channel landed in
                // the parent category instead).
                measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragEnd={onDragEnd}
                onDragCancel={() => { setActiveId(null); setOverId(null); setOverRefused(false); dragStartOrderRef.current = null; restoreBackup(); }}
            >
                {/* The pills overlay the scroller's edges, so they live in a
                    positioned wrapper OUTSIDE it: they never scroll with the list
                    and never change its layout. */}
                <div className="relative flex-1 min-h-0 flex flex-col">
                <div
                    ref={setListEl}
                    tabIndex={-1}
                    className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-4 custom-scrollbar outline-none"
                    onContextMenu={(e) => {
                        if (!canManage) return;
                        createMenu.open(e, [
                            { icon: <Hash />,   label: 'Create Channel',
                              onSelect: () => setChannelDialog({ mode: 'create', defaultCategoryId: null, defaultKind: 'text' }) },
                            { icon: <Folder />, label: 'Create Category',
                              onSelect: () => setCategoryDialog({ mode: 'create' }) },
                            { icon: <Minus />, label: 'Add Divider',
                              onSelect: () => setDividerDialog({ mode: 'create', container: null }) },
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
                            {/* Top of the list: uncategorized channels + dividers */}
                            <SortableContext items={topKeys} strategy={verticalListSortingStrategy}>
                                {tree.top.map(leaf => renderLeaf(leaf, topKeys))}
                            </SortableContext>
                            {canManage && (
                                <UncategorizedDropzone dragActive={!!activeId && !activeId.startsWith('cat:')} overHere={overId === UNCATEGORIZED_END_ID} refused={overRefused} />
                            )}

                            {/* Categories */}
                            <SortableContext items={catKeys} strategy={verticalListSortingStrategy}>
                                {tree.categories.map(({ category: cat, items }) => {
                                    const collapsed = !!collapsedCats[cat.category_id];
                                    const catKey  = `cat:${cat.category_id}`;
                                    const itemKeys = items.map(i => i.key);
                                    return (
                                        <SortableSection
                                            key={cat.category_id}
                                            id={catKey}
                                            disabled={!canManage}
                                            isDragging={activeId === catKey}
                                            dropLine={activeId?.startsWith('cat:') ? getDropLine(catKey, catKeys) : null}
                                        >
                                            {(setHeaderRef, headerDragProps) => (
                                                <div className="mt-4">
                                                    {/* Entire header row is the drag activator */}
                                                    <div
                                                        ref={canManage ? setHeaderRef : undefined}
                                                        {...(canManage ? headerDragProps : {})}
                                                        role="button"
                                                        tabIndex={0}
                                                        aria-expanded={!collapsed}
                                                        aria-label={`${cat.name}, ${categoryDividerLook(cat) ? 'divider category' : 'category'}`}
                                                        className={`group flex items-center gap-2 w-full px-2 py-px ${canManage ? 'min-h-[24px]' : 'min-h-[18px]'} rounded relative transition-colors outline-none focus-visible:ring-1 focus-visible:ring-cl-lume/60 ${
                                                            activeId && !activeId.startsWith('cat:') && overId === catKey ? 'bg-cl-lume/10' : 'hover:bg-cl-raise/40'
                                                        } ${canManage ? 'cursor-grab active:cursor-grabbing select-none touch-none' : 'cursor-pointer'}`}
                                                        // A COLLAPSED category stands in for the unread channels it hides
                                                        // (the off-screen pill's jump expands it); see offscreenUnread.ts.
                                                        data-unread-anchor={collapsed && unreadModel.has(categoryKey(cat.category_id)) ? categoryKey(cat.category_id) : undefined}
                                                        onContextMenu={(e) => {
                                                            e.stopPropagation();
                                                            // Members get Mark as Read + Copy ID; managers the rest.
                                                            ctx.open(e, buildCategoryMenu(cat), cat.name);
                                                        }}
                                                        onClick={() => toggleCategory(cat.category_id)}
                                                        onKeyDown={(e) => {
                                                            // Keys pressed on the header's own buttons ("+", "...") belong to them.
                                                            if (e.target !== e.currentTarget) return;
                                                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCategory(cat.category_id); }
                                                            else if (isMenuKey(e)) { e.preventDefault(); ctx.open(anchorOf(e.currentTarget), buildCategoryMenu(cat), cat.name); }
                                                        }}
                                                    >
                                                        {/* Ordinary label (the TOP level, never quieter than a
                                                            sub-category) or, for a divider category, the divider. */}
                                                        <CategoryHeading
                                                            category={cat}
                                                            collapsed={collapsed}
                                                            rolled={collapsed ? rolledUnread(channelsIn(items)) : null}
                                                            muted={mute.isMuted(cat.category_id)}
                                                        />
                                                        {canManage && (
                                                            <HoverActions
                                                                // Out of the layout until hover / focus (categoryHeadingStyle.ts).
                                                                className={CATEGORY_HEADER_ACTIONS_CLASS}
                                                                actions={[
                                                                    {
                                                                        icon: <Plus />, label: 'Add to this category',
                                                                        onClick: (e: React.MouseEvent) => ctx.open(buttonAnchor(e.currentTarget as HTMLElement), buildAddMenu(cat), cat.name),
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
                                                            <SortableContext items={itemKeys} strategy={verticalListSortingStrategy}>
                                                                {items.map(item => renderItem(item, itemKeys))}
                                                            </SortableContext>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </SortableSection>
                                    );
                                })}
                            </SortableContext>
                        </>
                    )}
                </div>
                {offscreen.above && (
                    <div className="absolute top-2 inset-x-0 z-40 flex justify-center pointer-events-none">
                        <span className="pointer-events-auto flex">
                            <OffscreenUnreadPill direction="above" summary={offscreen.above} onJump={offscreen.jump} />
                        </span>
                    </div>
                )}
                {offscreen.below && (
                    <div className="absolute bottom-2 inset-x-0 z-40 flex justify-center pointer-events-none">
                        <span className="pointer-events-auto flex">
                            <OffscreenUnreadPill direction="below" summary={offscreen.below} onJump={offscreen.jump} />
                        </span>
                    </div>
                )}
                </div>

                {/* Drag overlay — ghost of the item being dragged */}
                <DragOverlay dropAnimation={null}>
                    {activeChannel && (
                        <div className="opacity-80 pointer-events-none shadow-2xl">
                            {renderChannelRow(activeChannel)}
                        </div>
                    )}
                    {activeDivider && (
                        <div className="opacity-80 pointer-events-none shadow-2xl bg-cl-deep rounded-md">
                            <ChannelDividerVisual divider={activeDivider} />
                        </div>
                    )}
                    {activeCat && (
                        <div className="pointer-events-none">
                            <div
                                className={`opacity-80 shadow-2xl px-2 py-0.5 text-[12px] font-medium text-cl-muted bg-cl-deep rounded border ${
                                    overRefused ? 'border-cl-flash' : 'border-cl-border'
                                }`}
                            >
                                {activeCat.name}
                            </div>
                            {overRefused && (
                                <div
                                    className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold text-cl-flash-text bg-cl-deep border border-cl-flash/40 shadow-lg whitespace-nowrap"
                                    data-testid="drag-refused-hint"
                                >
                                    <Ban size={11} aria-hidden="true" />
                                    Sub-categories go inside a category
                                </div>
                            )}
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
                    onNavigateToCreated={navigateToCreated}
                    onCreatedKeepOpen={() => onChannelsChanged?.()}
                    onDelete={onDeleteChannelApi ? (ch) => { setChannelDialog(null); void deleteChannelOptimistic(ch); } : undefined}
                    optimism={optimism}
                />
            )}
            {categoryDialog && (
                <CategoryFormDialog
                    serverId={server.server_id}
                    token={token}
                    category={editingCategory}
                    initialTab={categoryDialog.mode === 'edit' ? categoryDialog.initialTab : undefined}
                    parentCategoryId={categoryDialog.mode === 'create' ? (categoryDialog.parentCategoryId ?? null) : null}
                    kind="text"
                    ownerUserId={server.owner_user_id}
                    currentUserId={userId ?? null}
                    myPermissions={myPermissions}
                    categories={categories}
                    channels={channels}
                    onClose={() => setCategoryDialog(null)}
                    onSaved={(saved) => {
                        // Show it now; the server:channels_changed echo reconciles.
                        onApplyCategories?.(list => (list.some(c => c.category_id === saved.category_id)
                            ? list.map(c => (c.category_id === saved.category_id ? { ...c, ...saved } : c))
                            : [...list, saved]));
                        onChannelsChanged?.();
                    }}
                    onDelete={onDeleteCategoryApi ? (cat) => { void requestDeleteCategory(cat); } : undefined}
                />
            )}
            {dividerDialog && (
                <DividerFormDialog
                    divider={dividerDialog.mode === 'edit' ? dividerDialog.divider : null}
                    containerName={dividerDialog.mode === 'create' ? categoryName(dividerDialog.container) : categoryName(dividerDialog.divider.parent_category_id)}
                    onClose={() => setDividerDialog(null)}
                    onSubmit={(v) => {
                        if (dividerDialog.mode === 'create') createDivider(dividerDialog.container, v);
                        else updateDivider(dividerDialog.divider, v);
                    }}
                    onDelete={dividerDialog.mode === 'edit' ? () => deleteDivider(dividerDialog.divider) : undefined}
                />
            )}

            {subcatRefusal && (
                <ConfirmDialog
                    title="That spot is outside a category"
                    message="Sub-categories have to be under a category. Drop it onto a category, or between the channels inside one."
                    confirmDisabled
                    tone="default"
                    icon={<CornerDownRight size={18} strokeWidth={2.2} />}
                    onConfirm={() => setSubcatRefusal(false)}
                    onCancel={() => setSubcatRefusal(false)}
                />
            )}

            {categoryDelete && (
                <CategoryDeleteDialog
                    name={categoryDelete.cat.name}
                    isSub={categoryDelete.isSub}
                    only={categoryDelete.only}
                    contents={categoryDelete.contents}
                    onCancel={() => setCategoryDelete(null)}
                    onConfirm={(choice) => {
                        const { cat, contents } = categoryDelete;
                        setCategoryDelete(null);
                        if (choice === 'everything') deleteCategoryWithContentsNow(cat, contents);
                        else deleteCategoryNow(cat);
                    }}
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
