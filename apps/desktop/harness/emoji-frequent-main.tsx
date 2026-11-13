// The real emoji-mart with the real placeholder helper. A custom emoji in Frequently Used is
// drawn before its image resolves, then the image arrives. `?fix=0` is the control (the bug).
import React from 'react';
import { createRoot } from 'react-dom/client';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { placeholderSrcFor, useFillResolvedPlaceholders } from '../src/components/emojiPickerPlaceholders';

const ID = 'cl_test_emoji';
const REAL = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#25E0C8"/></svg>');
localStorage.setItem('emoji-mart.frequently', JSON.stringify({ [ID]: 9, '+1': 5 }));
const fix = new URLSearchParams(location.search).get('fix') !== '0';

function App() {
    const ref = React.useRef<HTMLDivElement>(null);
    const [url, setUrl] = React.useState<string | null>(null);
    React.useEffect(() => { const t = setTimeout(() => setUrl(REAL), 900); return () => clearTimeout(t); }, []);
    const urls = React.useMemo(() => (fix && url ? { [ID]: url } : {}), [url]);
    useFillResolvedPlaceholders(ref, urls);
    const custom = React.useMemo(() => [{ id: 'mine', name: 'Mine', emojis: [{ id: ID, name: 'test', keywords: ['test'], skins: [{ src: url ?? placeholderSrcFor(ID) }] }] }], [url]);
    return <div ref={ref}>{React.createElement(Picker as never, { data, custom, theme: 'dark', set: 'native' })}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
