/**
 * Settings → Privacy: how links leave Cipherline.
 *
 *   "Opening links" — "Warn before opening links" (default on) and, under it,
 *   "Still warn about suspicious links" (default on; only matters when the
 *   first is off). utils/externalLinks/linkWarningPrefs.ts.
 *
 *   "Trusted websites" — the sites whose links open without the "You're
 *   leaving Cipherline" check (utils/externalLinks/trustedDomains.ts). Built
 *   for a long list: a search that filters as you type (Unicode or punycode),
 *   a count, a list that scrolls inside a bounded height, and "Remove all"
 *   behind an in-page confirm.
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ExternalLink, Globe, Search, ShieldAlert, X } from 'lucide-react';
import { ClButton, ClSearch, ClToggle } from './cl';
import { useEscape } from '../hooks/useEscape';
import {
    BUILT_IN_TRUSTED_DOMAINS, listTrustedDomains, subscribeTrustedDomains, untrustAllDomains, untrustDomain,
} from '../utils/externalLinks/trustedDomains';
import { filterTrustedRows, trustedRows } from '../utils/externalLinks/trustedDomainsFilter';
import { getLinkWarningPrefs, setLinkWarningPrefs, subscribeLinkWarningPrefs } from '../utils/externalLinks/linkWarningPrefs';
import { hostDisplay } from '../utils/externalLinks/idnDisplay';
import { registrableDomain } from '../utils/externalLinks/registrableDomain';
import '../styles/leaving-dialog.css';

const plural = (n: number) => `${n} trusted website${n === 1 ? '' : 's'}`;

function LinkWarningCard() {
    const prefs = useSyncExternalStore(subscribeLinkWarningPrefs, getLinkWarningPrefs, getLinkWarningPrefs);
    const subActive = !prefs.warn;
    return (
        <div className="sd-card" data-setting="link-warnings">
            <h3>Opening links</h3>
            <div className="sd-row" style={{ borderTop: 'none' }}>
                <span className={`sd-tile${prefs.warn ? '' : ' sd-tile--dim'}`}><ExternalLink size={16} /></span>
                <div className="sd-rl">
                    <b>Warn before opening links</b>
                    <span>Ask “You’re leaving Cipherline?” before a link to a site you haven’t trusted opens in your browser.</span>
                </div>
                <div className="sd-rc">
                    <ClToggle checked={prefs.warn} onChange={(v) => { setLinkWarningPrefs({ warn: v }); }} aria-label="Warn before opening links" />
                </div>
            </div>
            <div className={`sd-row lws-sub${subActive ? '' : ' lws-sub--off'}`} data-setting="link-warnings-suspicious" aria-disabled={!subActive}>
                <span className={`sd-tile${subActive && prefs.warnSuspicious ? '' : ' sd-tile--dim'}`}><ShieldAlert size={16} /></span>
                <div className="sd-rl">
                    <b>Still warn about suspicious links <span className="lws-rec">Recommended</span></b>
                    <span>
                        Link text naming a different site, look-alike addresses and a user name before the @ are how
                        phishing links hide where they really go.
                    </span>
                    {!subActive && <span className="lws-note">Only applies when “Warn before opening links” is off.</span>}
                </div>
                <div className="sd-rc">
                    <ClToggle
                        checked={prefs.warnSuspicious}
                        disabled={!subActive}
                        onChange={(v) => { setLinkWarningPrefs({ warnSuspicious: v }); }}
                        aria-label="Still warn about suspicious links"
                    />
                </div>
            </div>
        </div>
    );
}

function TrustedWebsitesCard() {
    const domains = useSyncExternalStore(subscribeTrustedDomains, listTrustedDomains, listTrustedDomains);
    const rows = useMemo(() => trustedRows(domains), [domains]);
    const [query, setQuery] = useState('');
    const shown = useMemo(() => filterTrustedRows(rows, query), [rows, query]);
    const [confirmAll, setConfirmAll] = useState(false);
    const confirmCancelRef = useRef<HTMLSpanElement>(null);
    const total = rows.length;
    const filtering = query.trim().length > 0;

    const [searchFocused, setSearchFocused] = useState(false);

    useEffect(() => {
        if (confirmAll) confirmCancelRef.current?.querySelector<HTMLElement>('button')?.focus();
    }, [confirmAll]);
    // Esc backs out of the in-page "Remove all" confirm first, then clears a
    // search the box is focused on; an empty, unfocused box leaves Esc to
    // Settings as usual. Both through the shared escape stack.
    useEscape(() => setConfirmAll(false), confirmAll);
    useEscape(() => setQuery(''), searchFocused && query !== '' && !confirmAll);

    return (
        <div className="sd-card" data-setting="trusted-websites">
            <h3>Trusted websites</h3>
            <p className="sd-sub">
                Links to these sites open without the “You’re leaving Cipherline” check. Each one includes its
                subdomains. {BUILT_IN_TRUSTED_DOMAINS.join(', ')} is always trusted. A link whose text names a
                different site still asks first.
            </p>
            {total === 0 ? (
                <div className="tws-empty">
                    No trusted websites yet. Tick “Always trust links to …” when you open a link to add one.
                </div>
            ) : (
                <>
                    <div className="tws-bar">
                        <div className="tws-search">
                            <ClSearch
                                icon={<Search size={15} />}
                                type="search"
                                value={query}
                                placeholder="Search trusted websites"
                                aria-label="Search trusted websites"
                                onChange={(e) => setQuery(e.target.value)}
                                onFocus={() => setSearchFocused(true)}
                                onBlur={() => setSearchFocused(false)}
                                // Enter in a filter box has nothing to submit.
                                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                            />
                        </div>
                        <span className="tws-count" data-tws-count="" aria-live="polite">
                            {filtering ? `${shown.length} of ${plural(total)}` : plural(total)}
                        </span>
                        {!confirmAll && (
                            <ClButton variant="ghost" size="sm" onClick={() => setConfirmAll(true)} ariaLabel="Remove all trusted websites">
                                Remove all
                            </ClButton>
                        )}
                    </div>
                    {confirmAll && (
                        <div
                            className="tws-confirm"
                            role="group"
                            aria-label="Confirm removing all trusted websites"
                            data-tws-confirm=""
                        >
                            <span>Remove all {plural(total)}? Links to them will ask before opening again.</span>
                            <span ref={confirmCancelRef}>
                                <ClButton variant="ghost" size="sm" onClick={() => setConfirmAll(false)}>Cancel</ClButton>
                            </span>
                            <ClButton variant="danger" size="sm" onClick={() => { untrustAllDomains(); setConfirmAll(false); setQuery(''); }}>
                                Remove all
                            </ClButton>
                        </div>
                    )}
                    <div className="tws-scroll" data-tws-scroll="" role="region" aria-label="Trusted websites list">
                        {shown.length === 0 ? (
                            <div className="tws-empty tws-empty--search" data-tws-nomatch="">
                                No trusted websites match “{query.trim()}”.
                            </div>
                        ) : (
                            <ul className="tws-list" aria-label="Trusted websites">
                                {shown.map(({ domain, shown: label }) => {
                                    const d = hostDisplay(domain);
                                    const exact = registrableDomain(domain).exactOnly;
                                    return (
                                        <li key={domain} className="tws-item">
                                            <span className="sd-tile"><Globe size={16} /></span>
                                            <span className="tws-domain">
                                                {label}
                                                <small>{exact ? 'This exact address' : 'And its subdomains'}{d.verdict === 'unicode' ? ` · ${d.ascii}` : ''}</small>
                                            </span>
                                            <ClButton
                                                variant="ghost"
                                                size="sm"
                                                ariaLabel={`Remove ${label} from trusted websites`}
                                                onClick={() => { untrustDomain(domain); }}
                                            >
                                                <X size={13} /> Remove
                                            </ClButton>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

const TrustedWebsitesSettings: React.FC = () => (
    <>
        <LinkWarningCard />
        <TrustedWebsitesCard />
    </>
);

export default TrustedWebsitesSettings;
