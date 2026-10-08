import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source-level wiring checks for rail server folders — the pieces are unit-
// tested in rail/ (serverFolders, useServerRailLayout) and exercised in the
// browser harness; this guards that Dashboard actually connects them (the
// "module tested in isolation but never wired" class of bug).
const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

function railNav(source: string): string {
    const start = source.indexOf('className="shrink-0 app-rail"');
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('</nav>', start));
}

describe('server folders — Dashboard wiring', () => {
    const nav = railNav(dash);

    it('the rail renders the persisted LAYOUT (servers + folders), not a flat order', () => {
        expect(dash).toContain('useServerRailLayout(userId, serverIds)');
        expect(dash).not.toContain('useServerRailOrder');
        expect(nav).toContain('{railItems.map(item => {');
        expect(nav).toContain("if (item.kind === 'folder')");
        expect(nav).toContain('<ServerFolderTile');
    });

    it('one DndContext hosts the rail AND the popover, with the folder dnd state machine', () => {
        const open = nav.indexOf('<DndContext');
        const close = nav.indexOf('</DndContext>');
        expect(nav.slice(open, open + 80)).toContain('{...railDnd.dndProps}');
        const pop = nav.indexOf('<ServerFolderPopover');
        expect(pop).toBeGreaterThan(open);
        expect(pop).toBeLessThan(close);
        expect(nav).toContain('strategy={staticSortingStrategy}');
        expect(nav).toContain('merge={railDnd.mergeKey === railKey}');
        expect(nav).toContain('merge={railDnd.mergeKey === fKey}');
    });

    it('the active pill and scroll-into-view resolve a server inside a folder to the FOLDER tile', () => {
        expect(nav).toContain('railIndexOfServer(railLayout.layout, activeServerView.serverId)');
        expect(dash).toContain('folderOfServer(railLayout.layout, activeRailServerId)');
        expect(dash).toContain('[data-rail-id="${folderKey(activeRailFolderId)}"]');
    });

    it('leaving a server takes it out of its folder (persisted)', () => {
        const leave = dash.indexOf('/servers/${leaveServerTarget.server_id}/leave');
        expect(leave).toBeGreaterThan(-1);
        expect(dash.slice(leave, leave + 900)).toContain('railLayout.forget(leaveServerTarget.server_id)');
    });

    it('folder context menu offers rename, colour and remove (ungroup)', () => {
        const fn = dash.slice(dash.indexOf('const openFolderRailMenu'), dash.indexOf('const openFolderRailMenu') + 3000);
        expect(fn).toContain("label: 'Rename'");
        expect(fn).toContain("label: 'Change colour'");
        expect(fn).toContain('railLayout.ungroup(folderId)');
    });

    it('the popover closes on navigation without an effect (render-time key)', () => {
        expect(dash).toContain('if (railNavKeySeen !== railNavKey)');
    });

    it('positive control: the nav extractor sees the rail', () => {
        expect(nav).toContain('<Mascot');
        expect(nav).not.toContain('Main Content Area');
    });
});
