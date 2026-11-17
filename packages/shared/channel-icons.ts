/**
 * The approved icon set: the curated lucide ("Material-style") icons the
 * desktop's ChannelIconPicker offers, stored by name (`icon_name`).
 *
 * NAMES are free to be typed or pasted with emoji (channel / category /
 * divider names accept them), but an ICON is only ever one of these. The API
 * checks every category / sub-category `icon_name` write against this list;
 * the desktop picker renders exactly these (a desktop test asserts the two
 * agree, so a rename on either side fails loudly instead of silently turning
 * into the Hash fallback glyph).
 *
 * Stored spelling is lucide's own name ('Image', not the picker's import alias
 * 'ImageIcon').
 */
export const CHANNEL_ICON_NAMES = [
    // Communication
    'Hash', 'MessageSquare', 'MessagesSquare', 'Megaphone', 'Mail', 'AtSign',
    'MessageCircle', 'Phone', 'Send', 'Reply',
    // Voice / video
    'Volume2', 'Mic', 'Video', 'Headphones', 'Radio', 'PhoneCall', 'Podcast', 'Voicemail',
    // Content
    'Image', 'Film', 'Music', 'Code', 'FileText', 'Newspaper', 'BookOpen',
    'Camera', 'Book', 'Library', 'FileVideo', 'FileAudio',
    // Activity
    'Gamepad2', 'Trophy', 'Sparkles', 'Zap', 'Heart', 'Star', 'Flame', 'Coffee',
    'Rocket', 'PartyPopper', 'Gift', 'Dumbbell',
    // Tooling
    'Wrench', 'Cog', 'Hammer', 'Cpu', 'Terminal', 'Database', 'Server', 'GitBranch', 'Bug', 'Package',
    // Organisation
    'Pin', 'Lock', 'Globe', 'Bell', 'Bookmark', 'Tag', 'FolderOpen', 'Archive', 'Flag', 'ClipboardList',
    // People
    'Users', 'UserPlus', 'Smile', 'ThumbsUp', 'Crown', 'GraduationCap', 'Handshake', 'BadgeHelp',
    // Creative
    'Pen', 'Brush', 'Palette', 'Scissors', 'Aperture', 'Wand2', 'PaintBucket',
    // Business
    'BarChart2', 'PieChart', 'TrendingUp', 'DollarSign', 'ShoppingCart', 'ShoppingBag', 'Target', 'Award',
    // Nature
    'Leaf', 'Sun', 'Moon', 'Cloud', 'Snowflake', 'Wind', 'TreePine', 'Flower2',
    // Misc
    'Lightbulb', 'MapPin', 'Briefcase', 'Calendar', 'Swords',
] as const;

export type ChannelIconName = typeof CHANNEL_ICON_NAMES[number];

const NAME_SET: ReadonlySet<string> = new Set(CHANNEL_ICON_NAMES);

/** True only for a name in the approved set (never an emoji, never free text). */
export function isChannelIconName(v: unknown): v is ChannelIconName {
    return typeof v === 'string' && NAME_SET.has(v);
}
