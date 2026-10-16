import { useEffect, useRef, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import { useDialogFocus } from './dialog-focus';
import { markRequested, requestErrorMessage, SeerrStatus, seerrKey, seerrMeta, seerrStatusLabel, type SeerrItem } from './seerr';
import { t } from './i18n';

/** Applies locally completed requests so every card showing the title agrees. */
export function withRequested(items: SeerrItem[], requested: Record<string, SeerrItem>): SeerrItem[] {
    return items.map(item => requested[seerrKey(item)] || item);
}

export function SeerrCard({ item, onOpen }: { item: SeerrItem; onOpen: (item: SeerrItem) => void }) {
    const [ imageFailed, setImageFailed ] = useState(false);
    const status = seerrStatusLabel(item);
    const meta = seerrMeta(item);
    const hasImage = Boolean(item.posterUrl) && !imageFailed;
    const initials = item.title.trim().split(/\s+/).slice(0, 2).map(word => word.charAt(0)).join('').toUpperCase();
    return <button data-focusable="true" type="button" class="home-feed-card poster seerr-card" aria-label={`${item.canRequest ? t('Request') : t('View request for')} ${item.title}, ${meta}${status ? `, ${status}` : ''}`} onClick={() => onOpen(item)}>
        <span class={`home-feed-card-art${hasImage ? '' : ' no-artwork'}`}>
            {hasImage
                ? <img src={item.posterUrl} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setImageFailed(true)} />
                : <span class="home-feed-card-fallback" aria-hidden="true"><span class="home-feed-fallback-glow" /><span class="home-feed-fallback-icon">{initials || '?'}</span><span class="home-feed-fallback-label">{t('NOT IN YOUR LIBRARY')}</span></span>}
            {status && <span class="seerr-status">{status}</span>}
            <span class="home-feed-card-overlay"><strong>{item.title}</strong><small>{meta}</small></span>
        </span>
    </button>;
}

export function SeerrSearchResults({ items, loading, error, onOpen }: { items: SeerrItem[]; loading: boolean; error: string; onOpen: (item: SeerrItem) => void }) {
    if (!loading && !error && !items.length) return null;
    return <section class="seerr-search" aria-labelledby="seerr-search-title">
        <div class="section-heading"><div><p class="eyebrow">{t('NOT IN YOUR LIBRARY')}</p><h2 id="seerr-search-title">{t('Request from Seerr')}</h2></div></div>
        {loading && <p class="muted" role="status">{t('Checking Seerr…')}</p>}
        {error && <p class="notice error" role="status">{error}</p>}
        {items.length > 0 && <div class="seerr-grid">{items.map(item => <SeerrCard key={seerrKey(item)} item={item} onOpen={onOpen} />)}</div>}
    </section>;
}

export function SeerrRequestSheet({ api, item, onClose, onRequested }: {
    api: JellyfinApi;
    item: SeerrItem;
    onClose: () => void;
    onRequested: (item: SeerrItem) => void;
}) {
    const sheet = useRef<HTMLElement>(null);
    const mounted = useRef(true);
    const [ busy, setBusy ] = useState(false);
    const [ error, setError ] = useState('');
    const [ done, setDone ] = useState(false);
    useEffect(() => () => { mounted.current = false; }, []);
    useDialogFocus(sheet, true, onClose, { initial: '.seerr-sheet-request:not(:disabled), .seerr-sheet-close' });
    useEffect(() => {
        if (done) sheet.current?.querySelector<HTMLElement>('.seerr-sheet-close')?.focus();
    }, [ done ]);
    const status = seerrStatusLabel(item);
    const request = () => {
        if (busy || !item.canRequest) return;
        setBusy(true);
        setError('');
        void api.requestSeerr(item.mediaType, item.mediaId).then(() => {
            onRequested(markRequested(item));
            if (mounted.current) setDone(true);
        }).catch(cause => {
            if (mounted.current) setError(requestErrorMessage(cause));
        }).finally(() => {
            if (mounted.current) setBusy(false);
        });
    };
    return <div class="seerr-sheet-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
        <aside ref={sheet} class="seerr-sheet" role="dialog" aria-modal="true" aria-labelledby="seerr-sheet-title">
            <div class="seerr-sheet-poster">{item.posterUrl ? <img src={item.posterUrl} alt="" referrerpolicy="no-referrer" /> : <span aria-hidden="true" />}</div>
            <div class="seerr-sheet-body">
                <p class="eyebrow">{t('NOT IN YOUR LIBRARY')}</p>
                <h2 id="seerr-sheet-title">{item.title}</h2>
                <p class="muted">{seerrMeta(item)}{status ? ` · ${status}` : ''}</p>
                {item.overview && <p class="seerr-sheet-overview">{item.overview}</p>}
                {done && <p class="notice" role="status">{t('Requested “{0}”.', item.title)}</p>}
                {error && <p class="notice error" role="alert">{error}</p>}
                {!item.canRequest && !done && <p class="muted">{item.status === SeerrStatus.Processing ? t('This title is being added to the library.') : t('This title has already been requested.')}</p>}
                <div class="seerr-sheet-actions">
                    {item.canRequest && !done && <button data-focusable="true" type="button" class="button primary seerr-sheet-request" disabled={busy} onClick={request}>{busy ? t('Requesting…') : t('Request')}</button>}
                    <button data-focusable="true" type="button" class="button secondary seerr-sheet-close" onClick={onClose}>{done ? t('Done') : t('Close')}</button>
                </div>
            </div>
        </aside>
    </div>;
}
