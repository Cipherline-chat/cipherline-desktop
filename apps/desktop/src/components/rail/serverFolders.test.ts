import { describe, it, expect } from 'vitest';
import {
    DEFAULT_FOLDER_NAME, MAX_FOLDER_NAME, addServerToFolder, aggregateFolderBadge, applyRailDrop, canMerge,
    createFolder, dropZoneFor, findFolder, flattenServerIds, folderKey, folderOfServer, folderPopoverKey,
    folderServerKey, forgetServer, gridNeighbor, moveRailItemBy, moveToRailPosition, normalize, parseKey,
    parseRailLayout, placePopover, popoverColumns, railIndexOfServer, reconcileRailLayout, removeFromFolder,
    renameFolder, reorderInFolder, resolveRailDrop, sanitizeFolderName, serializeRailLayout, serverKey,
    setFolderColor, sideFor, ungroupFolder, type RailLayout,
} from './serverFolders';

/** Compact layout notation: 'a' = server, ['f', 'a', 'b'] = folder f. */
type Spec = (string | string[])[];
const L = (spec: Spec): RailLayout => ({
    items: spec.map(x => typeof x === 'string'
        ? { kind: 'server' as const, id: x }
        : { kind: 'folder' as const, folder: { id: x[0], name: x[0].toUpperCase(), color: null, serverIds: x.slice(1) } }),
});
const S = (l: RailLayout): Spec => l.items.map(it => it.kind === 'server' ? it.id : [it.folder.id, ...it.folder.serverIds]);
const newId = () => 'new';

describe('legacy order migration (pre-folder saved orders keep working)', () => {
    it('a bare id array becomes a folder-less layout in the same order', () => {
        expect(S(parseRailLayout(['b', 'a', 'c']))).toEqual(['b', 'a', 'c']);
    });
    it('drops non-strings, empties and duplicates from a legacy array', () => {
        expect(S(parseRailLayout(['a', 3, '', null, 'a', 'b']))).toEqual(['a', 'b']);
    });
    it('garbage of any other shape reads as empty, never throws', () => {
        for (const g of [null, undefined, 42, 'x', {}, { items: 'no' }, { v: 2 }]) {
            expect(parseRailLayout(g).items).toEqual([]);
        }
    });
});

describe('v2 (de)serialisation', () => {
    it('round-trips servers and folders (name, colour, members)', () => {
        const l = setFolderColor(renameFolder(L(['a', ['f', 'b', 'c'], 'd']), 'f', 'Games'), 'f', 'glow');
        const back = parseRailLayout(JSON.parse(serializeRailLayout(l)));
        expect(S(back)).toEqual(['a', ['f', 'b', 'c'], 'd']);
        expect(findFolder(back, 'f')).toMatchObject({ name: 'Games', color: 'glow' });
    });
    it('an unknown colour (e.g. a crafted backup carrying CSS) is dropped to null', () => {
        const l = parseRailLayout({ v: 2, items: [{ id: 'f', name: 'X', color: 'red;background:url(x)', servers: ['a', 'b'] }] });
        expect(findFolder(l, 'f')!.color).toBeNull();
    });
    it('malformed folder entries are skipped; a stored one-server folder dissolves on read', () => {
        const l = parseRailLayout({ v: 2, items: [{ name: 'no id', servers: ['a'] }, { id: 'f', servers: ['b'] }, 'c', { id: 'g', servers: 'x' }] });
        expect(S(l)).toEqual(['b', 'c']);
    });
    it('folder names are cleaned: whitespace collapsed, capped, empty → default', () => {
        expect(sanitizeFolderName('  a \n  b ')).toBe('a b');
        expect(sanitizeFolderName('   ')).toBe(DEFAULT_FOLDER_NAME);
        expect(sanitizeFolderName('x'.repeat(100))).toHaveLength(MAX_FOLDER_NAME);
    });
});

describe('normalize — the module invariants', () => {
    it('a server appears once (first occurrence wins, top level or folder)', () => {
        expect(S(normalize(L(['a', ['f', 'a', 'b', 'c'], 'b'])))).toEqual(['a', ['f', 'b', 'c']]);
    });
    it('a one-server folder dissolves IN PLACE, an empty one disappears', () => {
        expect(S(normalize(L(['a', ['f', 'b'], 'c', ['g'], 'd'])))).toEqual(['a', 'b', 'c', 'd']);
    });
    it('a duplicate folder id keeps its servers as plain tiles (never drops a server)', () => {
        expect(S(normalize(L([['f', 'a', 'b'], ['f', 'c', 'd']])))).toEqual([['f', 'a', 'b'], 'c', 'd']);
    });
    it('returns the same reference when already normal (cheap render-time use)', () => {
        const l = L(['a', ['f', 'b', 'c']]);
        expect(normalize(l)).toBe(l);
    });
});

describe('reconcileRailLayout — saved layout vs servers joined right now', () => {
    it('keeps the saved order and folders', () => {
        expect(S(reconcileRailLayout(L(['c', ['f', 'a', 'b']]), ['a', 'b', 'c']))).toEqual(['c', ['f', 'a', 'b']]);
    });
    it('a left server leaves its folder; a folder of two dissolves into the survivor', () => {
        expect(S(reconcileRailLayout(L(['c', ['f', 'a', 'b']]), ['b', 'c']))).toEqual(['c', 'b']);
    });
    it('new servers append at the END, outside folders, in API order', () => {
        expect(S(reconcileRailLayout(L([['f', 'a', 'b']]), ['z', 'a', 'b', 'y']))).toEqual([['f', 'a', 'b'], 'z', 'y']);
    });
    it('unknown ids are dropped silently', () => {
        expect(S(reconcileRailLayout(L(['ghost', ['f', 'x', 'y'], 'a']), ['a']))).toEqual(['a']);
    });
    it('first run (nothing saved) is API order', () => {
        expect(S(reconcileRailLayout({ items: [] }, ['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
    });
    it('returns the saved reference when nothing changes (stable memo)', () => {
        const l = L(['a', ['f', 'b', 'c']]);
        expect(reconcileRailLayout(l, ['c', 'b', 'a'])).toBe(l);
    });
    it('positive control: a changed membership is NOT returned by reference', () => {
        const l = L(['a', ['f', 'b', 'c']]);
        expect(reconcileRailLayout(l, ['a', 'b'])).not.toBe(l);
    });
});

describe('createFolder (the drag-and-hold merge)', () => {
    it('server on server → a folder in the TARGET slot holding [target, dragged]', () => {
        expect(S(createFolder(L(['a', 'b', 'c', 'd']), 'b', 'd', 'n'))).toEqual(['a', ['n', 'b', 'd'], 'c']);
    });
    it('dragging out of another folder of two dissolves that folder', () => {
        expect(S(createFolder(L([['g', 'x', 'y'], 'a']), 'a', 'y', 'n'))).toEqual(['x', ['n', 'a', 'y']]);
    });
    it('no-op (same reference) on self, missing ids, a folder target, or a taken folder id', () => {
        const l = L(['a', ['f', 'b', 'c']]);
        expect(createFolder(l, 'a', 'a', 'n')).toBe(l);
        expect(createFolder(l, 'zz', 'a', 'n')).toBe(l);
        expect(createFolder(l, 'b', 'a', 'n')).toBe(l); // b is inside a folder, not a top-level target
        expect(createFolder(l, 'a', 'b', 'f')).toBe(l);
    });
});

describe('addServerToFolder / reorderInFolder / removeFromFolder', () => {
    it('adds at the end by default, at an index when given', () => {
        expect(S(addServerToFolder(L(['a', ['f', 'b', 'c']]), 'f', 'a'))).toEqual([['f', 'b', 'c', 'a']]);
        expect(S(addServerToFolder(L(['a', ['f', 'b', 'c']]), 'f', 'a', 1))).toEqual([['f', 'b', 'a', 'c']]);
    });
    it('moving between folders dissolves a source left with one', () => {
        expect(S(addServerToFolder(L([['g', 'x', 'y'], ['f', 'b', 'c']]), 'f', 'x'))).toEqual(['y', ['f', 'b', 'c', 'x']]);
    });
    it('reorders inside a folder before/after a sibling', () => {
        const l = L([['f', 'a', 'b', 'c', 'd']]);
        expect(S(reorderInFolder(l, 'f', 'a', 'c', 'after'))).toEqual([['f', 'b', 'c', 'a', 'd']]);
        expect(S(reorderInFolder(l, 'f', 'd', 'b', 'before'))).toEqual([['f', 'a', 'd', 'b', 'c']]);
        expect(reorderInFolder(l, 'f', 'b', 'a', 'after')).toBe(l); // already there
    });
    it('remove puts the server right after the folder; a folder of two dissolves', () => {
        expect(S(removeFromFolder(L([['f', 'a', 'b', 'c'], 'z']), 'b'))).toEqual([['f', 'a', 'c'], 'b', 'z']);
        expect(S(removeFromFolder(L([['f', 'a', 'b'], 'z']), 'a'))).toEqual(['b', 'a', 'z']);
    });
    it('remove of a top-level server is a no-op', () => {
        const l = L(['a', ['f', 'b', 'c']]);
        expect(removeFromFolder(l, 'a')).toBe(l);
    });
});

describe('ungroup / rename / colour / forget', () => {
    it('ungroup returns servers, in order, where the folder was — none lost', () => {
        const l = L(['a', ['f', 'c', 'b', 'd'], 'e']);
        const u = ungroupFolder(l, 'f');
        expect(S(u)).toEqual(['a', 'c', 'b', 'd', 'e']);
        expect(flattenServerIds(u).sort()).toEqual(flattenServerIds(l).sort());
    });
    it('rename cleans the name; same name → same reference', () => {
        const l = renameFolder(L([['f', 'a', 'b']]), 'f', '  Work ');
        expect(findFolder(l, 'f')!.name).toBe('Work');
        expect(renameFolder(l, 'f', 'Work')).toBe(l);
    });
    it('colour accepts the palette and null, rejects anything else', () => {
        const l = L([['f', 'a', 'b']]);
        expect(findFolder(setFolderColor(l, 'f', 'ok'), 'f')!.color).toBe('ok');
        expect(findFolder(setFolderColor(l, 'f', 'hotpink' as never), 'f')!.color).toBeNull();
    });
    it('forget removes a server from its folder (folder of two dissolves)', () => {
        expect(S(forgetServer(L([['f', 'a', 'b'], 'c']), 'a'))).toEqual(['b', 'c']);
    });
});

describe('moveToRailPosition / moveRailItemBy', () => {
    it('moves a server before/after another top-level item', () => {
        expect(S(moveToRailPosition(L(['a', 'b', 'c']), serverKey('a'), serverKey('c'), 'after'))).toEqual(['b', 'c', 'a']);
        expect(S(moveToRailPosition(L(['a', 'b', 'c']), serverKey('c'), serverKey('a'), 'before'))).toEqual(['c', 'a', 'b']);
    });
    it('moves a whole folder', () => {
        expect(S(moveToRailPosition(L(['a', ['f', 'b', 'c'], 'd']), folderKey('f'), serverKey('d'), 'after'))).toEqual(['a', 'd', ['f', 'b', 'c']]);
    });
    it('moving a folder member to the rail takes it out of its folder (drag out of the popover)', () => {
        expect(S(moveToRailPosition(L(['a', ['f', 'b', 'c', 'd']]), serverKey('c'), serverKey('a'), 'before'))).toEqual(['c', 'a', ['f', 'b', 'd']]);
    });
    it('a no-op move returns the same reference', () => {
        const l = L(['a', 'b']);
        expect(moveToRailPosition(l, serverKey('a'), serverKey('b'), 'before')).toBe(l);
    });
    it('keyboard move swaps with the neighbour and clamps', () => {
        const l = L(['a', ['f', 'b', 'c'], 'd']);
        expect(S(moveRailItemBy(l, folderKey('f'), 1))).toEqual(['a', 'd', ['f', 'b', 'c']]);
        expect(moveRailItemBy(l, serverKey('a'), -1)).toBe(l);
    });
});

describe('drop zones', () => {
    it('top/bottom quarters reorder, the middle half is the merge zone', () => {
        expect(dropZoneFor(100, 100, 44)).toBe('before');
        expect(dropZoneFor(110.9, 100, 44)).toBe('before');
        expect(dropZoneFor(111.1, 100, 44)).toBe('center');
        expect(dropZoneFor(122, 100, 44)).toBe('center');
        expect(dropZoneFor(132.9, 100, 44)).toBe('center');
        expect(dropZoneFor(133.1, 100, 44)).toBe('after');
    });
    it('side is the half the pointer is in', () => {
        expect(sideFor(121.9, 100, 44)).toBe('before');
        expect(sideFor(122, 100, 44)).toBe('after');
    });
});

describe('resolveRailDrop — decision table', () => {
    const l = L(['a', 'b', ['f', 'x', 'y', 'z'], 'c']);
    it('server held over server (merge armed) → createFolder', () => {
        expect(resolveRailDrop(l, serverKey('a'), serverKey('c'), 'after', true)).toEqual({ type: 'createFolder', targetId: 'c', draggedId: 'a' });
    });
    it('server dropped on server WITHOUT the dwell → reorder (gap behaviour kept)', () => {
        expect(resolveRailDrop(l, serverKey('a'), serverKey('c'), 'after', false)).toEqual({ type: 'move', activeKey: serverKey('a'), targetKey: serverKey('c'), side: 'after' });
    });
    it('server held over a folder → addToFolder', () => {
        expect(resolveRailDrop(l, serverKey('a'), folderKey('f'), 'before', true)).toEqual({ type: 'addToFolder', folderId: 'f', serverId: 'a' });
    });
    it('folder never merges (no nesting) — it reorders', () => {
        expect(canMerge(l, folderKey('f'), serverKey('a'))).toBe(false);
        expect(resolveRailDrop(l, folderKey('f'), serverKey('a'), 'before', true)).toEqual({ type: 'move', activeKey: folderKey('f'), targetKey: serverKey('a'), side: 'before' });
    });
    it('a popover server cannot merge into its own folder; dropped next to it, it leaves the folder', () => {
        expect(canMerge(l, folderServerKey('x'), folderKey('f'))).toBe(false);
        expect(resolveRailDrop(l, folderServerKey('x'), folderKey('f'), 'after', false)).toEqual({ type: 'move', activeKey: serverKey('x'), targetKey: folderKey('f'), side: 'after' });
    });
    it('a popover server held over a rail server → new folder with it', () => {
        expect(resolveRailDrop(l, folderServerKey('y'), serverKey('b'), 'after', true)).toEqual({ type: 'createFolder', targetId: 'b', draggedId: 'y' });
    });
    it('within the popover → reorderInFolder; a rail server on a popover tile → addToFolder at that slot', () => {
        expect(resolveRailDrop(l, folderServerKey('x'), folderServerKey('z'), 'after', false)).toEqual({ type: 'reorderInFolder', folderId: 'f', serverId: 'x', targetId: 'z', side: 'after' });
        expect(resolveRailDrop(l, serverKey('a'), folderServerKey('y'), 'before', false)).toEqual({ type: 'addToFolder', folderId: 'f', serverId: 'a', index: 1 });
    });
    it('a rail server on the popover background → addToFolder (end); a member on it → none', () => {
        expect(resolveRailDrop(l, serverKey('c'), folderPopoverKey('f'), 'after', false)).toEqual({ type: 'addToFolder', folderId: 'f', serverId: 'c' });
        expect(resolveRailDrop(l, folderServerKey('x'), folderPopoverKey('f'), 'after', false)).toEqual({ type: 'none' });
    });
    it('no target / onto itself → none', () => {
        expect(resolveRailDrop(l, serverKey('a'), null, 'after', false)).toEqual({ type: 'none' });
        expect(resolveRailDrop(l, serverKey('a'), serverKey('a'), 'after', true)).toEqual({ type: 'none' });
    });
    it('applyRailDrop executes each action', () => {
        expect(S(applyRailDrop(l, resolveRailDrop(l, serverKey('a'), serverKey('c'), 'after', true), newId))).toEqual(['b', ['f', 'x', 'y', 'z'], ['new', 'c', 'a']]);
        expect(S(applyRailDrop(l, resolveRailDrop(l, folderServerKey('x'), serverKey('a'), 'before', false), newId))).toEqual(['x', 'a', 'b', ['f', 'y', 'z'], 'c']);
        expect(applyRailDrop(l, { type: 'none' }, newId)).toBe(l);
    });
});

describe('queries', () => {
    const l = L(['a', ['f', 'b', 'c'], 'd']);
    it('railIndexOfServer finds the folder slot for a member (active pill / scroll target)', () => {
        expect(railIndexOfServer(l, 'a')).toBe(0);
        expect(railIndexOfServer(l, 'c')).toBe(1);
        expect(railIndexOfServer(l, 'd')).toBe(2);
        expect(railIndexOfServer(l, 'zz')).toBe(-1);
    });
    it('folderOfServer / flattenServerIds / parseKey', () => {
        expect(folderOfServer(l, 'b')!.id).toBe('f');
        expect(folderOfServer(l, 'a')).toBeNull();
        expect(flattenServerIds(l)).toEqual(['a', 'b', 'c', 'd']);
        expect(parseKey('fsrv:x')).toEqual({ kind: 'folderServer', id: 'x' });
        expect(parseKey('nope')).toBeNull();
        expect(parseKey('srv:')).toBeNull();
    });
});

describe('aggregateFolderBadge', () => {
    it('sums loud counts', () => {
        expect(aggregateFolderBadge([{ count: 3, tone: 'alert' }, null, { count: 12, tone: 'alert' }])).toEqual({ count: 15, tone: 'alert' });
    });
    it('loud wins over quiet; quiet alone is the quiet dot; nothing → null', () => {
        expect(aggregateFolderBadge([{ count: 1, tone: 'quiet' }, { count: 2, tone: 'alert' }])).toEqual({ count: 2, tone: 'alert' });
        expect(aggregateFolderBadge([{ count: 5, tone: 'quiet' }, null])).toEqual({ count: 1, tone: 'quiet' });
        expect(aggregateFolderBadge([null, undefined])).toBeNull();
        expect(aggregateFolderBadge([])).toBeNull();
    });
});

describe('popover layout helpers', () => {
    it('columns: 2 up to four, 3 up to nine, then 4', () => {
        expect([1, 2, 4, 5, 9, 10, 30].map(popoverColumns)).toEqual([1, 2, 2, 3, 3, 4, 4]);
    });
    it('grid arrow navigation clamps and moves by rows', () => {
        // 3 columns, 7 items
        expect(gridNeighbor(0, 'ArrowLeft', 7, 3)).toBe(0);
        expect(gridNeighbor(2, 'ArrowRight', 7, 3)).toBe(3);
        expect(gridNeighbor(1, 'ArrowDown', 7, 3)).toBe(4);
        expect(gridNeighbor(4, 'ArrowDown', 7, 3)).toBe(4); // no item below
        expect(gridNeighbor(4, 'ArrowUp', 7, 3)).toBe(1);
        expect(gridNeighbor(3, 'End', 7, 3)).toBe(6);
        expect(gridNeighbor(3, 'Home', 7, 3)).toBe(0);
    });
    it('placement: right of the rail, aligned to the tile, clamped to the viewport', () => {
        const vp = { width: 1280, height: 800 };
        expect(placePopover({ top: 300, height: 44, right: 72 }, { width: 250, height: 200 }, vp)).toEqual({ left: 84, top: 290, originY: 32 });
        // tile near the bottom: popover pushed up, origin still points at the tile
        const low = placePopover({ top: 740, height: 44, right: 72 }, { width: 250, height: 200 }, vp);
        expect(low.top).toBe(800 - 200 - 8);
        expect(low.originY).toBe(740 + 22 - low.top);
        // tiny viewport: never above the margin
        expect(placePopover({ top: 10, height: 44, right: 72 }, { width: 250, height: 900 }, vp).top).toBe(8);
    });
});
