import { describe, it, expect } from 'vitest';
import { buildChannelCandidates, rankChannelCandidates, type LinkableChannel, type LinkableCategory } from './channelRefs';

// The `#` channel picker with sub-categories: channels inside one get a
// "Parent › Sub" breadcrumb and sit in sidebar order (at the sub-category's
// slot inside its parent); dividers are not channels and never appear.

const SID = 's';
const ch = (channel_id: string, parent: string | null, position: number): LinkableChannel => ({
    channel_id, server_id: SID, kind: 'text', name: channel_id, topic: null, position, parent_category_id: parent,
});
const cats: LinkableCategory[] = [
    { category_id: 'CRAFT', name: 'Crafting', position: 1000 },
    { category_id: 'WOOD', name: 'Woodworking', position: 2000, parent_category_id: 'CRAFT' },
    { category_id: 'PRINT', name: '3D Printing', position: 4000, parent_category_id: 'CRAFT' },
    { category_id: 'EVENTS', name: 'Events', position: 2000 },
];
const channels = [
    ch('build-nights', 'EVENTS', 1000),
    ch('print-help', 'PRINT', 1000),
    ch('joinery', 'WOOD', 1000),
    ch('finishes', 'WOOD', 2000),
    ch('crafting-chat', 'CRAFT', 1000),
    ch('after-wood', 'CRAFT', 3000), // a direct channel between the two sub-categories
    ch('welcome', null, 1000),
];

describe('# picker with sub-categories', () => {
    const cands = buildChannelCandidates(channels, cats, SID);

    it('lists channels in sidebar order, sub-category channels at their sub-category\'s slot', () => {
        expect(cands.map(c => c.channel.name)).toEqual([
            'welcome', 'crafting-chat', 'joinery', 'finishes', 'after-wood', 'print-help', 'build-nights',
        ]);
    });

    it('labels a sub-category channel with a breadcrumb, a category channel with its category', () => {
        expect(cands.find(c => c.channel.name === 'joinery')!.categoryName).toBe('Crafting › Woodworking');
        expect(cands.find(c => c.channel.name === 'crafting-chat')!.categoryName).toBe('Crafting');
        expect(cands.find(c => c.channel.name === 'welcome')!.categoryName).toBeNull();
    });

    it('a sub-category whose parent is missing from the list still labels with its own name', () => {
        const c = buildChannelCandidates([ch('x', 'WOOD', 1000)], [cats[1]], SID);
        expect(c[0].categoryName).toBe('Woodworking');
    });

    it('search ranks sub-category channels like any other', () => {
        expect(rankChannelCandidates(cands, 'join').map(c => c.channel.name)).toEqual(['joinery']);
    });
});
