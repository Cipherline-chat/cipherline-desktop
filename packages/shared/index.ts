export const Colors = {
    background: '#121212', // deep dark
    surface: '#1E1E1E', // slightly elevated flat
    surfaceHover: '#2A2A2A', // interactive
    primary: '#5C6BC0', // Indigo accent
    primaryHover: '#7986CB',
    secondary: '#FF4081', // Pink accent for contrast
    text: '#FFFFFF',
    textSecondary: '#B3B3B3',
    divider: '#333333',
    error: '#EF5350',
    success: '#66BB6A',
    warning: '#FFA726',
};


// basic type exports for consistency across apps
export type Platform = 'windows' | 'mac' | 'linux' | 'ios' | 'android' | 'web';
export * from './content';
export * from './klipy';
export * from './user';
export * from './permissions';
export * from './storage-tiers';
export * from './billing';
export * from './call-naming';
export * from './attribution';
export * from './call-media';
