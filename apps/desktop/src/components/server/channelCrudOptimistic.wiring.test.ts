import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Source-level guards (the repo's wiring-test style) for the channel
// create / edit / delete / drag fixes. They pin the SHAPE that fixed the bugs
// so a refactor cannot quietly put the old behaviour back.
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('ServerChannelList drag end', () => {
    const src = read('./ServerChannelList.tsx');

    // Sub-categories + dividers (2026-11-16) replaced planChannelDrop with
    // planLayoutDrop. The bug planChannelDrop fixed (a cross-container move
    // already applied by onDragOver, then swallowed by "released over itself")
    // cannot recur: nothing is relocated while dragging, and the drop is
    // planned from the layout captured at drag START.
    it('plans every list-item drop from the drag-start layout, never relocating mid-drag', () => {
        // decideLayoutDrop = planLayoutDrop that also tells a refused drop (a
        // sub-category outside a category) from a no-op, same inputs.
        expect(src).toContain('decideLayoutDrop(startOrder, dragId, dropId, dropPlace(active, over), topLevelIds)');
        expect(src).toContain('dragStartOrderRef.current = layoutOrderFromTree(tree);');
        const onDragOver = src.slice(src.indexOf('function onDragOver'), src.indexOf('function restoreBackup'));
        expect(onDragOver).not.toContain('setLocalChannels');
        // Layout-aware successor of channelCollisionDetection (layoutDrop.ts):
        // the sentinel still wins when the pointer is inside it.
        expect(src).toContain('collisionDetection={layoutCollisionDetection}');
    });

    it('saves through the layout endpoint and rolls back with a toast on refusal', () => {
        expect(src).toContain('/channel-layout`, layoutPatchBody(plan)');
        expect(src).toContain("Couldn't move that. It's back where it was.");
    });
});

describe('optimistic channel CRUD', () => {
    const dialog = read('./ChannelSettingsDialog.tsx');
    const list = read('./ServerChannelList.tsx');
    const dash = read('../Dashboard.tsx');

    it('only goes optimistic when no permission overrides ride along', () => {
        expect(dialog.match(/if \(optimism && !permsDirty\)/g)?.length).toBe(2); // create + edit
    });

    it('mints the channel key only after the server created the channel', () => {
        const create = dialog.slice(dialog.indexOf('if (optimism && !permsDirty)'));
        expect(create.indexOf('request.then')).toBeGreaterThan(-1);
        expect(create.indexOf('onCreated?.(created)')).toBeGreaterThan(create.indexOf('request.then'));
    });

    it('rolls back with a toast on refusal', () => {
        expect(dialog).toContain('optimism.dropPending(tempId)');
        expect(dialog).toContain('optimism.patch(ch.channel_id, prev)');
        expect(list).toContain("Couldn't delete #");
    });

    it('does not refetch the list itself on a local mutation: it waits for the echo', () => {
        expect(dash).toContain('onChannelsChanged={() => expectChannelsEcho(srv.server_id)}');
        expect(dash).not.toMatch(/onChannelsChanged=\{\(\) => \{\s*loadChannels\(srv\.server_id\)/);
    });
});
